/**
 * Asks Claude (through Shell's own AI proxy, which needs a signed-in person with the
 * Intake import permission) to find street addresses for sites that have none, and
 * hands the reply to draftProposals() to be checked.
 */

import { buildDraftRequest, draftProposals, type DraftCandidate, type DraftProposal } from "@eq/intake";

export type LookupFetch = (url: string, init: { method: string; credentials: "include"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const PROXY_URL = "/api/anthropic-proxy/messages";

export async function lookupAddresses(candidates: readonly DraftCandidate[], doFetch: LookupFetch = fetch as unknown as LookupFetch): Promise<DraftProposal[]> {
  if (candidates.length === 0) return [];
  const res = await doFetch(PROXY_URL, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDraftRequest(candidates)),
  });
  if (res.status === 401 || res.status === 403) throw new Error("You don't have permission to use the address lookup.");
  if (res.status === 429) throw new Error("That was asked too many times in a row. Try again in a few minutes.");
  if (!res.ok) throw new Error("The address lookup didn't work this time. Nothing was changed.");
  return draftProposals(await res.json(), candidates);
}
