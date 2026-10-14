/**
 * reconcile — diff a source sheet against canonical rows.
 *
 * Given a ParsedSheet (just parsed from a dropped file) and a list of
 * canonical rows already in the database, this module:
 *   1. Finds the best match key (email, staff_id, serial_number, …)
 *   2. Matches source rows ↔ canonical rows on that key
 *   3. For matched pairs, flags field-level conflicts (same key, different value)
 *   4. Returns four buckets:
 *      - matched      — source row == canonical row on all non-key fields (green)
 *      - conflicts    — source row differs from canonical on ≥1 field (orange)
 *      - onlyInSource — source row has no canonical counterpart (red / new)
 *      - onlyInCanonical — canonical row not in source (grey / untouched)
 *
 * When an entity is supplied, step 2 gets a second pass: source/canonical
 * rows left unmatched by exact key are fuzzy-compared on their identity
 * string (company name, person name, site name+address…), the same
 * Dice-coefficient matcher duplicate-detect.ts uses for clustering. A
 * high-confidence pair (e.g. "Acme Pty Ltd" vs "ACME P/L") is promoted from
 * onlyInSource/onlyInCanonical into conflicts — flagged for a human, instead
 * of quietly becoming an unrelated "new row" next to an "untouched" one that
 * happen to be the same real-world record. These rows carry
 * `matchedBy: "fuzzy"` and never offer an automatic "use source" merge —
 * there's no shared key to upsert against.
 *
 * Resolution is tracked per-row via the `resolution` field. The commit step
 * (in ReconcileModule) uses it to decide which rows to write.
 */

import type { ParsedSheet } from "./readers/csv.js";
import { dice, identityKeyFor, identityLabelFor, HIGH_SIM } from "./duplicate-detect.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single field-level conflict between source and canonical. */
export interface FieldConflict {
  /** Canonical field name. */
  field: string;
  /** Value from the dropped file. May be empty string. */
  sourceValue: string;
  /** Value from the canonical database row. May be empty string. */
  canonicalValue: string;
}

/** The user's choice for how to resolve a conflicting row. */
export type Resolution = "keep-canonical" | "use-source" | "skip";

/** One row in the reconciliation output. */
export interface ReconcileRow {
  /** The original source row (from the parsed file). undefined for onlyInCanonical. */
  sourceRow?: Record<string, unknown>;
  /** The canonical row from the database. undefined for onlyInSource. */
  canonicalRow?: Record<string, unknown>;
  /** Field-level diffs. Empty for matched or onlyIn* rows. */
  conflicts: FieldConflict[];
  /** User-selected resolution for conflict rows. */
  resolution?: Resolution;
  /**
   * How this pair ended up in `conflicts`. Absent (or "key") for the normal
   * path — an exact match on `matchKey`. "fuzzy" means there was NO shared
   * key value; the pair was promoted here because their identity strings
   * (company name, person name, site name+address…) are near-identical —
   * e.g. "Acme Pty Ltd" in the file vs "ACME P/L" already in EQ. Callers
   * must not offer an automatic "use source" merge for a fuzzy row: there's
   * no shared key to upsert against, so committing it would silently insert
   * a duplicate instead of updating the matched canonical row.
   */
  matchedBy?: "key" | "fuzzy";
}

/** Full output of reconcileSheets(). */
export interface ReconcileResult {
  /** Source rows that match canonical exactly — no action needed. */
  matched: ReconcileRow[];
  /** Source rows that match on key but differ on ≥1 field — needs user review. */
  conflicts: ReconcileRow[];
  /** Source rows with no canonical counterpart — will be added on commit. */
  onlyInSource: ReconcileRow[];
  /** Canonical rows not present in source — will be left untouched. */
  onlyInCanonical: ReconcileRow[];
  /** The field name used as the match key. */
  matchKey: string;
  /**
   * True when canonical rows exist but none carry the match key (e.g. the key
   * is email and the viewer lacks entity.view_pii, so the column was withheld).
   * Nothing could match, so every source row is in onlyInSource — "new" there
   * means "couldn't compare", not "doesn't exist". Callers must not offer to
   * commit those rows as new.
   */
  matchKeyUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Match-key detection
// ---------------------------------------------------------------------------

/**
 * Priority-ordered list of field names that are likely unique identifiers.
 * When the source sheet contains one of these columns (exact or
 * case-insensitive match), we use it as the join key.
 */
const PREFERRED_KEYS: string[] = [
  "email",
  "email_address",
  "staff_id",
  "employee_id",
  "asset_serial_number",
  "serial_number",
  "serial_no",
  "external_id",
  "abn",
  "customer_id",
  "site_id",
  "contact_id",
  "phone",
  "mobile",
  "id",
];

/**
 * Detect the best match key for a given source sheet.
 * Returns the first column name (from the sheet's headerRow) that matches
 * any of the PREFERRED_KEYS (case-insensitive). Falls back to the first
 * column if none match.
 *
 * When `canonicalKeys` (the column names present on the fetched canonical
 * rows) is given and non-empty, a candidate the canonical rows don't carry is
 * skipped — a key the database side withheld can't join anything.
 */
export function detectMatchKey(sheet: ParsedSheet, canonicalKeys?: ReadonlySet<string>): string {
  const lower = sheet.headerRow.map((h) => h.toLowerCase().replace(/[\s_-]+/g, "_"));
  const usable = (idx: number): boolean =>
    !canonicalKeys || canonicalKeys.size === 0 || canonicalKeys.has(sheet.headerRow[idx]!) || canonicalKeys.has(lower[idx]!);

  for (const preferred of PREFERRED_KEYS) {
    const idx = lower.indexOf(preferred);
    if (idx !== -1 && usable(idx)) return sheet.headerRow[idx]!;
  }

  // Partial match — "email" inside a longer column name
  for (const preferred of PREFERRED_KEYS) {
    const idx = lower.findIndex((h, i) => h.includes(preferred) && usable(i));
    if (idx !== -1) return sheet.headerRow[idx]!;
  }

  return sheet.headerRow[0] ?? "id";
}

// ---------------------------------------------------------------------------
// Core reconcile function
// ---------------------------------------------------------------------------

/**
 * Reconcile a parsed source sheet against canonical rows.
 *
 * @param sourceSheet   The ParsedSheet from the dropped file.
 * @param canonicalRows The existing rows fetched from the canonical database.
 * @param matchKey      The field to join on. Auto-detected if not supplied.
 * @param entity        Canonical entity name (e.g. "customers", "sites").
 *                       When supplied, rows left over in onlyInSource /
 *                       onlyInCanonical after the exact-key pass get a
 *                       second, fuzzy identity pass (see the module doc
 *                       comment) before being reported as unrelated.
 */
export function reconcileSheets(
  sourceSheet: ParsedSheet,
  canonicalRows: Record<string, unknown>[],
  matchKey?: string,
  entity?: string,
): ReconcileResult {
  const canonicalKeys = new Set<string>();
  for (const row of canonicalRows) for (const k of Object.keys(row)) canonicalKeys.add(k);
  const key = matchKey ?? detectMatchKey(sourceSheet, canonicalKeys);
  const matchKeyUnavailable = canonicalRows.length > 0 && !canonicalKeys.has(key);

  // Build a map of canonical rows keyed by matchKey value for O(1) lookup.
  const canonicalByKey = new Map<string, Record<string, unknown>>();
  for (const row of canonicalRows) {
    const keyValue = normaliseValue(row[key]);
    if (keyValue !== "") {
      canonicalByKey.set(keyValue, row);
    }
  }

  // Track which canonical keys we matched (so we can detect onlyInCanonical).
  const matchedCanonicalKeys = new Set<string>();

  const matched: ReconcileRow[] = [];
  const conflicts: ReconcileRow[] = [];
  let onlyInSource: ReconcileRow[] = [];

  for (const sourceRow of sourceSheet.rows as Record<string, unknown>[]) {
    const keyValue = normaliseValue(sourceRow[key]);

    if (keyValue === "") {
      // No key value — treat as onlyInSource (can't match without a key).
      onlyInSource.push({ sourceRow, conflicts: [] });
      continue;
    }

    const canonicalRow = canonicalByKey.get(keyValue);

    if (!canonicalRow) {
      onlyInSource.push({ sourceRow, conflicts: [] });
      continue;
    }

    matchedCanonicalKeys.add(keyValue);

    // Compare field-by-field for columns present in both source and canonical.
    const fieldConflicts = detectFieldConflicts(sourceRow, canonicalRow);

    if (fieldConflicts.length === 0) {
      matched.push({ sourceRow, canonicalRow, conflicts: [] });
    } else {
      conflicts.push({ sourceRow, canonicalRow, conflicts: fieldConflicts });
    }
  }

  // Collect canonical rows that had no matching source row.
  let onlyInCanonical: ReconcileRow[] = [];
  for (const [keyValue, canonicalRow] of canonicalByKey) {
    if (!matchedCanonicalKeys.has(keyValue)) {
      onlyInCanonical.push({ canonicalRow, conflicts: [] });
    }
  }

  // Fuzzy identity pass over what's left — see the module doc comment.
  if (entity && onlyInSource.length > 0 && onlyInCanonical.length > 0) {
    const pairs = findFuzzyPairs(entity, onlyInSource, onlyInCanonical);
    if (pairs.length > 0) {
      for (const { sourceIdx, canonicalIdx } of pairs) {
        const sRow = onlyInSource[sourceIdx]!.sourceRow!;
        const cRow = onlyInCanonical[canonicalIdx]!.canonicalRow!;
        conflicts.push({
          sourceRow: sRow,
          canonicalRow: cRow,
          matchedBy: "fuzzy",
          conflicts: [
            {
              field: "name similarity",
              sourceValue: identityLabelFor(entity, sRow),
              canonicalValue: identityLabelFor(entity, cRow),
            },
            ...detectFieldConflicts(sRow, cRow),
          ],
        });
      }
      const usedSource = new Set(pairs.map((p) => p.sourceIdx));
      const usedCanonical = new Set(pairs.map((p) => p.canonicalIdx));
      onlyInSource = onlyInSource.filter((_, i) => !usedSource.has(i));
      onlyInCanonical = onlyInCanonical.filter((_, i) => !usedCanonical.has(i));
    }
  }

  return { matched, conflicts, onlyInSource, onlyInCanonical, matchKey: key, matchKeyUnavailable };
}

// ---------------------------------------------------------------------------
// Fuzzy identity pass — cross-key candidates left over after exact matching
// ---------------------------------------------------------------------------

interface FuzzyPair {
  sourceIdx: number;
  canonicalIdx: number;
  similarity: number;
}

/**
 * Pair up leftover onlyInSource/onlyInCanonical rows by identity-string
 * similarity. Greedy: strongest matches win first, each row claimed at most
 * once — good enough for what's typically a small leftover set, and avoids
 * a full assignment-problem solver for a UI hint, not a canonical decision.
 */
function findFuzzyPairs(
  entity: string,
  onlyInSource: ReconcileRow[],
  onlyInCanonical: ReconcileRow[],
): FuzzyPair[] {
  const candidates: FuzzyPair[] = [];

  for (let si = 0; si < onlyInSource.length; si++) {
    const sKey = identityKeyFor(entity, onlyInSource[si]!.sourceRow!);
    if (sKey.length < 2) continue;

    for (let ci = 0; ci < onlyInCanonical.length; ci++) {
      const cKey = identityKeyFor(entity, onlyInCanonical[ci]!.canonicalRow!);
      if (cKey.length < 2) continue;

      const similarity = dice(sKey, cKey);
      if (similarity >= HIGH_SIM) {
        candidates.push({ sourceIdx: si, canonicalIdx: ci, similarity });
      }
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);

  const usedSource = new Set<number>();
  const usedCanonical = new Set<number>();
  const pairs: FuzzyPair[] = [];
  for (const c of candidates) {
    if (usedSource.has(c.sourceIdx) || usedCanonical.has(c.canonicalIdx)) continue;
    usedSource.add(c.sourceIdx);
    usedCanonical.add(c.canonicalIdx);
    pairs.push(c);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a cell value to a lowercase trimmed string for comparison. */
function normaliseValue(v: unknown): string {
  if (v == null) return "";
  return String(v).trim().toLowerCase();
}

/**
 * Compare every field in sourceRow against canonicalRow.
 * Only reports conflicts for fields that appear in BOTH rows and have
 * non-empty values that differ after normalisation.
 */
function detectFieldConflicts(
  sourceRow: Record<string, unknown>,
  canonicalRow: Record<string, unknown>,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  // All fields in the source row that also appear in canonical.
  for (const field of Object.keys(sourceRow)) {
    if (!(field in canonicalRow)) continue;

    const sourceValue = normaliseValue(sourceRow[field]);
    const canonicalValue = normaliseValue(canonicalRow[field]);

    // Skip if either side is empty (we don't treat empty as "different").
    if (sourceValue === "" || canonicalValue === "") continue;

    if (sourceValue !== canonicalValue) {
      conflicts.push({
        field,
        sourceValue: String(sourceRow[field] ?? ""),
        canonicalValue: String(canonicalRow[field] ?? ""),
      });
    }
  }

  return conflicts;
}
