/**
 * Asks Claude (through Shell's own AI proxy, which needs a signed-in person with the
 * Intake import permission) to find street addresses for sites that have none, and
 * hands each reply to draftProposals() to be checked.
 *
 * Shell's server stops a request after 26 seconds and every site needs its own web
 * search, so the sites go a couple at a time, a few requests at once. Whatever comes
 * back is shown as it arrives; a batch that fails is counted, not fatal.
 */

import { DRAFT_BATCH_SIZE, buildDraftRequest, draftProposals, type DraftCandidate, type DraftProposal } from "@eq/intake";

export type LookupFetch = (url: string, init: { method: string; credentials: "include"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const PROXY_URL = "/api/anthropic-proxy/messages";
const AT_ONCE = 4;

export interface LookupResult {
  proposals: DraftProposal[];
  /** Sites in batches that could not be checked (a timeout, a server error). */
  failed: number;
}

export interface LookupProgress {
  checked: number;
  total: number;
  proposals: DraftProposal[];
}

async function lookupBatch(batch: readonly DraftCandidate[], doFetch: LookupFetch): Promise<DraftProposal[]> {
  const res = await doFetch(PROXY_URL, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDraftRequest(batch)),
  });
  if (res.status === 401 || res.status === 403) throw new Error("You don't have permission to use the address lookup.");
  if (res.status === 429) throw new Error("That was asked too many times in a row. Try again in a few minutes.");
  if (!res.ok) throw new Error(`The address lookup didn't work this time (error ${res.status}). Nothing was changed.`);
  return draftProposals(await res.json(), batch);
}

export async function lookupAddresses(
  candidates: readonly DraftCandidate[],
  doFetch: LookupFetch = fetch as unknown as LookupFetch,
  onProgress?: (p: LookupProgress) => void,
): Promise<LookupResult> {
  if (candidates.length === 0) return { proposals: [], failed: 0 };
  const batches: DraftCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += DRAFT_BATCH_SIZE) batches.push(candidates.slice(i, i + DRAFT_BATCH_SIZE));

  const proposals: DraftProposal[] = [];
  let checked = 0;
  let failed = 0;
  let firstError: Error | null = null;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        proposals.push(...(await lookupBatch(batch, doFetch)));
      } catch (e) {
        failed += batch.length;
        firstError ??= e instanceof Error ? e : new Error("The address lookup didn't work this time.");
      }
      checked += batch.length;
      onProgress?.({ checked, total: candidates.length, proposals: [...proposals] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, batches.length) }, worker));

  if (failed === candidates.length && firstError) throw firstError;
  return { proposals, failed };
}
