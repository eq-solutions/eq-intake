/**
 * @eq/intake — fuzzy duplicate detection
 *
 * detectDuplicates() clusters records within an entity that are too similar
 * to be distinct real-world entries. Uses Dice coefficient on character
 * bigrams — handles abbreviations, missing punctuation, and legal suffix
 * differences better than token overlap alone.
 *
 * Clusters are surfaced in the health home so operators can review before
 * committing further data. No auto-merge — that requires human confirmation.
 *
 * Inactive (retired) rows ARE included in clustering. A retired row is the
 * classic silent-failure shape: the one copy that holds the correct customer
 * link can be `active = false`, so filtering it out hides the very row an
 * operator needs to keep. Instead each cluster carries per-member state
 * (active / has_customer_link / completeness), a *suggested* survivor, and a
 * `needs_reconcile` flag for when the live state disagrees with that
 * suggestion. When the signals conflict (e.g. two rows each carry a customer
 * link, as in the SY9 incident) survivor_confidence is 'low' — the engine
 * declines to pick for you rather than confidently picking wrong.
 */

import {
  normaliseCompanyName,
  normalisePersonName,
  normaliseAbn,
} from './normalize.js';
import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuplicateMember {
  id:                 string;   // PK value
  label:              string;   // human-readable display name
  active:             boolean;  // false = retired (still surfaced, not hidden)
  has_customer_link:  boolean;  // sites: customer_id set · assets: site_id set
  completeness:       number;   // count of populated fields — survivor tie-break
  recommended_survivor: boolean;// the suggested row to keep
}

export interface DuplicateCluster {
  entity:      string;
  record_ids:  string[];    // PK values (e.g. staff_id, customer_id)
  labels:      string[];    // human-readable display names
  similarity:  number;      // highest pair-wise similarity (0–1)
  match_field: string;      // field that triggered the match
  confidence:  'high' | 'medium';
  // ── Reconciliation decision support ──────────────────────────────────────
  members:                 DuplicateMember[];
  recommended_survivor_id: string | null;   // suggested row to keep, or null
  survivor_confidence:     'high' | 'low';  // 'low' when signals conflict
  needs_reconcile:         boolean;         // live state ≠ recommendation
}

export interface DuplicateReport {
  entity:         string;
  clusters:       DuplicateCluster[];
  total_records:  number;
  affected:       number;  // distinct records appearing in at least one cluster
  needs_reconcile: number; // clusters whose live state disagrees with the pick
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

// Exported — reconcile.ts's fuzzy pass uses the same bar for "confident
// enough to promote into a human-decision conflict" as this module's own
// clustering, so the two engines don't quietly drift apart on what counts
// as a likely duplicate.
export const HIGH_SIM = 0.85;
const MEDIUM_SIM = 0.65;

// A shared, non-null site code is a strong same-site identity claim — treated
// as a near-exact match, just below an exact ABN/serial (1.0).
const CODE_SIM   = 0.95;

// ---------------------------------------------------------------------------
// Bigram Dice coefficient
// ---------------------------------------------------------------------------

function bigrams(s: string): Set<string> {
  const bg = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
  return bg;
}

/**
 * Core Dice computation over pre-built bigram sets. Split out of dice() so
 * the O(n²) clustering loop below can precompute each candidate's bigram
 * set once (buildCandidates) instead of rebuilding both sides on every one
 * of the ~n²/2 pairs — the dominant cost once an entity gets into the
 * thousands of rows (2,854 live on the assets table as of 2026-09-07).
 * Iterates the smaller set as a small additional win.
 */
function diceOfBigrams(bA: Set<string>, bB: Set<string>): number {
  const [small, large] = bA.size <= bB.size ? [bA, bB] : [bB, bA];
  let matches = 0;
  small.forEach((bg) => { if (large.has(bg)) matches++; });
  return (2 * matches) / (bA.size + bB.size);
}

export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  return diceOfBigrams(bigrams(a), bigrams(b));
}

// ---------------------------------------------------------------------------
// Entity-specific normalisation and keying
// ---------------------------------------------------------------------------

type EntityRow = Record<string, unknown>;

export const PK: Record<string, string> = {
  staff:     'staff_id',
  customers: 'customer_id',
  sites:     'site_id',
  contacts:  'first_name',   // contacts table has no clean single-col PK from RPC
  assets:    'name',
};

export function identityLabelFor(entity: string, row: EntityRow): string {
  if (entity === 'staff' || entity === 'contacts') {
    return `${row['first_name'] ?? ''} ${row['last_name'] ?? ''}`.trim();
  }
  if (entity === 'customers') return String(row['company_name'] ?? '');
  if (entity === 'sites' || entity === 'assets') return String(row['name'] ?? '');
  return String(row[PK[entity] ?? 'id'] ?? '');
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

/** Count of populated fields on a row — a cheap, entity-agnostic completeness
 *  proxy used only to break survivor ties between otherwise-equal rows. */
function completenessOf(row: EntityRow): number {
  let n = 0;
  for (const v of Object.values(row)) if (!isBlank(v)) n++;
  return n;
}

/** Whether a row carries its defining parent link. For sites this is the
 *  customer_id — the single most decisive "this is the real row" signal, and
 *  exactly the field whose absence made the SY9 customer vanish from the
 *  site-driven service.customers view. */
function hasCustomerLink(entity: string, row: EntityRow): boolean {
  if (entity === 'sites')    return !isBlank(row['customer_id']);
  if (entity === 'assets')   return !isBlank(row['site_id']);
  if (entity === 'contacts') return !isBlank(row['customer_id']) || !isBlank(row['site_id']);
  return false;
}

type Candidate = {
  id:           string;
  label:        string;
  key_primary:  string;   // main comparison string
  key_abn?:     string;   // secondary: ABN (for customers)
  key_serial?:  string;   // secondary: serial number (for assets)
  key_code?:    string;   // secondary: site code (for sites)
  active:       boolean;
  hasLink:      boolean;
  completeness: number;
  // Precomputed once per candidate (not per pair) — see diceOfBigrams().
  key_primary_bigrams: Set<string>;
};

/**
 * The single normalised string used to fuzzy-compare two rows of the same
 * entity for "are these the same real-world thing" — company name, full
 * person name, site name+address, or asset name. Shared by this module's own
 * clustering below and by reconcile.ts's cross-key fuzzy pass (a source row
 * with no shared key value against canonical needs the same identity check
 * before it's allowed to fall through as an unrelated "new" row).
 */
export function identityKeyFor(entity: string, row: EntityRow): string {
  if (entity === 'customers') {
    return normaliseCompanyName(String(row['company_name'] ?? ''));
  }
  if (entity === 'staff' || entity === 'contacts') {
    return normalisePersonName(String(row['first_name'] ?? ''), String(row['last_name'] ?? ''));
  }
  if (entity === 'sites') {
    const name    = String(row['name'] ?? '').toLowerCase().trim();
    const address = String(row['address_line_1'] ?? '').toLowerCase().trim();
    return address ? `${name} ${address}` : name;
  }
  if (entity === 'assets') {
    return String(row['name'] ?? '').toLowerCase().trim();
  }
  return identityLabelFor(entity, row).toLowerCase();
}

function buildCandidates(entity: string, rows: EntityRow[]): Candidate[] {
  return rows
    // NB: inactive rows are intentionally retained — a retired row can be the
    // one holding the correct link, and hiding it is what makes the failure
    // silent. State is carried per-candidate instead of filtered away.
    .map((row): Candidate => {
      const id           = String(row[PK[entity] ?? 'id'] ?? '');
      const label        = identityLabelFor(entity, row);
      const active       = row['active'] !== false; // null/undefined ⇒ active
      const hasLink      = hasCustomerLink(entity, row);
      const completeness = completenessOf(row);
      const key_primary  = identityKeyFor(entity, row);
      const key_primary_bigrams = bigrams(key_primary);
      const base = { id, label, active, hasLink, completeness, key_primary, key_primary_bigrams };

      if (entity === 'customers') {
        return {
          ...base,
          key_abn: row['abn'] ? normaliseAbn(String(row['abn'])) : undefined,
        };
      }
      if (entity === 'sites') {
        return {
          ...base,
          key_code: row['code']
            ? String(row['code']).toUpperCase().replace(/\s+/g, '')
            : undefined,
        };
      }
      if (entity === 'assets') {
        return {
          ...base,
          key_serial: row['serial_number']
            ? String(row['serial_number']).toLowerCase().replace(/\s/g, '')
            : undefined,
        };
      }
      return base;
    })
    .filter((c) => c.key_primary.length >= 2 || c.key_code || c.key_abn || c.key_serial);
}

// ---------------------------------------------------------------------------
// Pair-wise clustering with union-find
// ---------------------------------------------------------------------------

function findCluster(parent: Map<string, string>, id: string): string {
  let root = id;
  while (parent.has(root)) root = parent.get(root)!;
  // Path compression
  let cur = id;
  while (parent.has(cur)) {
    const next = parent.get(cur)!;
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  const ra = findCluster(parent, a);
  const rb = findCluster(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

// ---------------------------------------------------------------------------
// Survivor selection
// ---------------------------------------------------------------------------

/**
 * Suggest which row in a cluster to keep, and how much to trust the suggestion.
 *
 * Ranking: a present customer link outranks everything (it is the field whose
 * absence causes silent customer loss), then completeness, then active state,
 * then a stable id tiebreak. Confidence is 'low' when the choice is genuinely
 * contested — more than one row carries a customer link, or more than one is
 * active — because that is precisely the shape (SY9) where the "obvious" pick
 * can be the wrong one. Low confidence tells the UI to ask a human, not act.
 */
function pickSurvivor(
  members: DuplicateMember[],
): { id: string | null; confidence: 'high' | 'low' } {
  if (members.length === 0) return { id: null, confidence: 'low' };

  const ranked = [...members].sort((a, b) =>
    (Number(b.has_customer_link) - Number(a.has_customer_link)) ||
    (b.completeness - a.completeness) ||
    (Number(b.active) - Number(a.active)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const linkedCount = members.filter((m) => m.has_customer_link).length;
  const activeCount = members.filter((m) => m.active).length;
  const confidence: 'high' | 'low' =
    linkedCount > 1 || activeCount > 1 ? 'low' : 'high';

  return { id: ranked[0]!.id, confidence };
}

// ---------------------------------------------------------------------------
// Public: detectDuplicates (one entity)
// ---------------------------------------------------------------------------

function detectForEntity(entity: string, rows: EntityRow[]): DuplicateReport {
  const candidates = buildCandidates(entity, rows);
  const parent     = new Map<string, string>();

  // Track highest similarity + matching field for each pair
  const pairSim   = new Map<string, number>();
  const pairField = new Map<string, string>();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;

      let sim   = 0;
      let field = 'name';

      // ABN exact match — strongest signal for customers
      if (a.key_abn && b.key_abn && a.key_abn.length >= 11 && a.key_abn === b.key_abn) {
        sim   = 1.0;
        field = 'abn';
      }
      // Serial number exact match — strongest signal for assets
      else if (
        a.key_serial &&
        b.key_serial &&
        a.key_serial.length >= 3 &&
        a.key_serial === b.key_serial
      ) {
        sim   = 1.0;
        field = 'serial_number';
      }
      // Site code exact match — a shared code is a strong same-site claim,
      // and reaches rows whose names diverge ("SY9" vs "Equinix SY9").
      else if (
        a.key_code &&
        b.key_code &&
        a.key_code.length >= 2 &&
        a.key_code === b.key_code
      ) {
        sim   = CODE_SIM;
        field = 'code';
      }
      // Primary key fuzzy match — reuses each candidate's precomputed bigram
      // set (buildCandidates) instead of rebuilding both sides on every one
      // of the ~n²/2 pairs. Same short-circuits as dice(), just inlined so
      // the precomputed sets can be passed straight to diceOfBigrams().
      else if (a.key_primary && b.key_primary) {
        sim = a.key_primary === b.key_primary
          ? 1
          : a.key_primary.length < 2 || b.key_primary.length < 2
            ? 0
            : diceOfBigrams(a.key_primary_bigrams, b.key_primary_bigrams);
        field = entity === 'customers' ? 'company_name' :
                entity === 'sites'     ? 'name+address' :
                'full_name';
      }

      if (sim >= MEDIUM_SIM) {
        const key = `${a.id}:${b.id}`;
        pairSim.set(key, sim);
        pairField.set(key, field);
        union(parent, a.id, b.id);
      }
    }
  }

  // Build clusters from union-find
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const root = findCluster(parent, c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c);
  }

  const clusters: DuplicateCluster[] = [];
  const affectedIds = new Set<string>();

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Find highest similarity and match field among all pairs in the group
    let highestSim = 0;
    let matchField = '';

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = `${group[i]!.id}:${group[j]!.id}`;
        const s   = pairSim.get(key) ?? 0;
        if (s > highestSim) {
          highestSim = s;
          matchField = pairField.get(key) ?? '';
        }
      }
    }

    group.forEach((c) => affectedIds.add(c.id));

    // Per-member decision signals
    const members: DuplicateMember[] = group.map((c) => ({
      id:                   c.id,
      label:                c.label,
      active:               c.active,
      has_customer_link:    c.hasLink,
      completeness:         c.completeness,
      recommended_survivor: false,
    }));

    const { id: survivorId, confidence } = pickSurvivor(members);
    for (const m of members) m.recommended_survivor = m.id === survivorId;

    // needs_reconcile: the live state disagrees with the recommendation —
    // either the suggested survivor is retired (SY9), or the active count is
    // anything other than exactly one (0 = all retired, >1 = split data).
    const activeCount   = members.filter((m) => m.active).length;
    const survivorActive =
      members.find((m) => m.id === survivorId)?.active ?? false;
    const needsReconcile = !survivorActive || activeCount !== 1;

    clusters.push({
      entity,
      record_ids:  group.map((c) => c.id),
      labels:      group.map((c) => c.label),
      similarity:  highestSim,
      match_field: matchField,
      confidence:  highestSim >= HIGH_SIM ? 'high' : 'medium',
      members,
      recommended_survivor_id: survivorId,
      survivor_confidence:     confidence,
      needs_reconcile:         needsReconcile,
    });
  }

  // Sort: clusters needing reconciliation first, then by similarity desc.
  clusters.sort((a, b) =>
    (Number(b.needs_reconcile) - Number(a.needs_reconcile)) ||
    (b.similarity - a.similarity),
  );

  return {
    entity,
    clusters,
    total_records:   candidates.length,
    affected:        affectedIds.size,
    needs_reconcile: clusters.filter((c) => c.needs_reconcile).length,
  };
}

// ---------------------------------------------------------------------------
// Public: detectAllDuplicates
// ---------------------------------------------------------------------------

type RpcClient = {
  rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const ENTITIES = ['staff', 'customers', 'sites', 'contacts', 'assets'] as const;

export async function detectAllDuplicates(
  supabase: SupabaseLikeClient,
): Promise<DuplicateReport[]> {
  const client = supabase as unknown as RpcClient;

  const results = await Promise.all(
    ENTITIES.map((entity) =>
      client
        .rpc('eq_tidy_read_entity', { p_table: entity })
        .then((r) => ({ entity, ...r })),
    ),
  );

  return results.map(({ entity, data: rawData }) => {
    const rows = (rawData as EntityRow[] | null) ?? [];
    return detectForEntity(entity, rows);
  });
}

// ---------------------------------------------------------------------------
// Public: matchAgainstLiveRecords — intake-time "does this already exist"
// ---------------------------------------------------------------------------

export interface LiveIdentityMatch {
  id: string;
  label: string;
  similarity: number;
}

/**
 * Host-supplied read of an entity's current live rows — same shape
 * detectAllDuplicates already gets from eq_tidy_read_entity, just scoped to
 * one entity instead of all five. Kept as an injected function (mirroring
 * dedup.ts's DupLookup) rather than this module taking a Supabase client
 * directly, so @eq/intake stays DB-free and the host owns the actual RPC call.
 */
export type LiveRowLookup = (entity: string) => Promise<EntityRow[]>;

/**
 * For each candidate identity key (one per new, not-yet-committed row),
 * find the best-matching already-saved record, if any is >= HIGH_SIM.
 *
 * Reuses the exact identityKeyFor()/dice()/HIGH_SIM this module already
 * applies to live-vs-live clustering (detectForEntity) — a new row and an
 * existing row count as "the same" under the same rule the health dashboard
 * already uses, not a second definition of "likely duplicate".
 *
 * newIdentityKeys entries that are null/too-short (no usable identity data
 * on that row) always resolve to null — never sent to the lookup, never
 * matched. Skips the lookup entirely when nothing in the batch has a usable
 * key, so an unrelated import (e.g. all sites, no customers) never triggers
 * a live customers read.
 */
export async function matchAgainstLiveRecords(
  entity: string,
  newIdentityKeys: (string | null)[],
  lookup: LiveRowLookup,
): Promise<(LiveIdentityMatch | null)[]> {
  if (!newIdentityKeys.some((k) => k !== null && k.length >= 2)) {
    return newIdentityKeys.map(() => null);
  }

  const liveRows = await lookup(entity);
  const liveCandidates = liveRows
    .map((row) => ({
      id: String(row[PK[entity] ?? 'id'] ?? ''),
      label: identityLabelFor(entity, row),
      key: identityKeyFor(entity, row),
    }))
    .filter((c) => c.id && c.key.length >= 2);

  return newIdentityKeys.map((key) => {
    if (!key || key.length < 2) return null;
    let best: LiveIdentityMatch | null = null;
    for (const c of liveCandidates) {
      const sim = dice(key, c.key);
      if (sim >= HIGH_SIM && (!best || sim > best.similarity)) {
        best = { id: c.id, label: c.label, similarity: sim };
      }
    }
    return best;
  });
}

// Exported for unit testing — pure, no DB dependency.
export { detectForEntity as _detectForEntity };
