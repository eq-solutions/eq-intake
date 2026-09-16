/**
 * @eq/intake — write-time contact resolver advisory reader
 *
 * readContactAdvisory() returns what the write-time contact resolver (eq-shell
 * migration 0233) flagged: new-contact writes that matched, or were ambiguous
 * against, an existing contact. It calls the eq_contact_advisory_summary RPC,
 * which is tenant-scoped via the caller's JWT app_metadata.tenant_id.
 *
 * Mirrors readSiteAdvisory()/adjudicateSiteAdvisory() exactly — see
 * read-site-advisory.ts for the fuller design notes (the two are structurally
 * identical; contacts just resolve on email/name/phone signals instead of
 * code/name/address).
 *
 * Degrades gracefully: if the RPC doesn't exist yet (a tenant not on 0233)
 * the caller's catch keeps the rest of the dashboard working.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactVerdict = 'same' | 'different' | 'unsure';

export interface ContactAdvisoryItem {
  id:              string;
  at:              string;                       // ISO timestamp of the flagged write
  outcome:         'match' | 'ambiguous';
  confidence:      'high' | 'low' | null;
  score:           number | null;                // 0..1 best-candidate score
  candidate_name:  string | null;                // the incoming contact's name
  candidate_email: string | null;                // the incoming contact's email
  matched_name:    string | null;                // the existing contact it resembled
  matched_active:  boolean | null;               // whether that existing contact is live
  verdict:         ContactVerdict | null;        // latest human/AI verdict, null = undecided
  verdict_note:    string | null;
  decided_at:      string | null;
  /** True the moment a merge_log row exists for this advisory, human or auto (0323) — authoritative, don't infer from client-tracked state. */
  already_merged:  boolean;
  /** already_merged AND nobody clicked anything — the write-time resolver merged it on its own (0323). */
  auto_merged:     boolean;
}

export interface ContactAdvisorySummary {
  total:              number;
  matches:            number;
  ambiguous:          number;
  pending:            number;
  decided:            number;
  recent_days:        number;
  recent_count:       number;
  /** Count of auto_merged rows within recent_days (0323) — the "N handled automatically" line. */
  auto_merged_recent: number;
  items:              ContactAdvisoryItem[];
}

export interface ContactAdjudicateResult {
  ok:          boolean;
  verdict_id:  string;
  advisory_id: string;
  verdict:     ContactVerdict;
}

const EMPTY: ContactAdvisorySummary = {
  total: 0, matches: 0, ambiguous: 0, pending: 0, decided: 0,
  recent_days: 7, recent_count: 0, auto_merged_recent: 0, items: [],
};

// ---------------------------------------------------------------------------
// Public: readContactAdvisory
// ---------------------------------------------------------------------------

export async function readContactAdvisory(
  supabase: SupabaseLikeClient,
  opts?: { days?: number; limit?: number },
): Promise<ContactAdvisorySummary> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_contact_advisory_summary', { p_days: opts?.days ?? 7, p_limit: opts?.limit ?? 25 });

  if (error) {
    throw new Error(`readContactAdvisory: ${error.message}`);
  }
  if (!data || typeof data !== 'object') return EMPTY;

  const d = data as Partial<ContactAdvisorySummary>;
  return {
    total:              d.total              ?? 0,
    matches:            d.matches            ?? 0,
    ambiguous:          d.ambiguous          ?? 0,
    pending:            d.pending            ?? 0,
    decided:            d.decided            ?? 0,
    recent_days:        d.recent_days        ?? (opts?.days ?? 7),
    recent_count:       d.recent_count       ?? 0,
    auto_merged_recent: d.auto_merged_recent ?? 0,
    items:              Array.isArray(d.items) ? d.items : [],
  };
}

// ---------------------------------------------------------------------------
// Public: adjudicateContactAdvisory
// ---------------------------------------------------------------------------

export async function adjudicateContactAdvisory(
  supabase: SupabaseLikeClient,
  input: { advisoryId: string; verdict: ContactVerdict; note?: string },
): Promise<ContactAdjudicateResult> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_contact_advisory_adjudicate', {
    p_advisory_id: input.advisoryId,
    p_verdict:     input.verdict,
    p_note:        input.note ?? null,
  });

  if (error) {
    throw new Error(`adjudicateContactAdvisory: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<ContactAdjudicateResult>;
  return {
    ok:          d.ok          ?? true,
    verdict_id:  d.verdict_id  ?? '',
    advisory_id: d.advisory_id ?? input.advisoryId,
    verdict:     d.verdict     ?? input.verdict,
  };
}
