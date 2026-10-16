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
