/**
 * The last few batches of approved tidy changes, kept in this browser so Undo is
 * still there after the screen is closed. Each batch holds both the old and new
 * value of every change it made. Kept short on purpose: it is a safety net for
 * "I didn't mean that", not an audit trail.
 */

import type { GuidedFix } from "@eq/intake";

export interface TidyBatch {
  id: string;
  at: string;
  count: number;
  fixes: GuidedFix[];
}

const MAX_BATCHES = 5;

/**
 * After an apply the plan is read again. Keep what the person had ticked for the
 * suggestions that are still on offer; a suggestion that was not in the old plan
 * (it only appeared now) gets its normal default, ticked when it is a sure one.
 */
export function nextSelection(
  prevSelected: ReadonlySet<string>,
  prevIds: ReadonlySet<string>,
  next: ReadonlyArray<{ id: string; tier: "sure" | "check" }>,
): Set<string> {
  const out = new Set<string>();
  for (const p of next) {
    if (prevIds.has(p.id) ? prevSelected.has(p.id) : p.tier === "sure") out.add(p.id);
  }
  return out;
}
const storageKey = (tenantId: string | undefined): string => `eq-guided-tidy:${tenantId ?? "none"}`;

/** Newest first, capped. */
export function pushBatch(list: readonly TidyBatch[], batch: TidyBatch, max: number = MAX_BATCHES): TidyBatch[] {
  return [batch, ...list.filter((b) => b.id !== batch.id)].slice(0, max);
}

export function loadBatches(tenantId: string | undefined): TidyBatch[] {
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as TidyBatch[]).filter((b) => b && Array.isArray(b.fixes)) : [];
  } catch {
    return [];
  }
}

export function saveBatches(tenantId: string | undefined, list: readonly TidyBatch[]): void {
  try {
    window.localStorage.setItem(storageKey(tenantId), JSON.stringify(list));
  } catch {
    /* storage can be blocked or full: Undo then lasts only for this visit */
  }
}
