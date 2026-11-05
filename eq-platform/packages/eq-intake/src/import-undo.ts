/**
 * Undo plan — a PURE description of what it would take to reverse an import.
 *
 * This module never writes. It takes what the commit step already knows (per
 * batch: the ids the commit RPC returned) and lists, per batch and table, the
 * ids a revert would remove. Executing it is a separate, explicitly approved
 * step in whichever app owns the Supabase client.
 *
 * Rule: every committed row appears somewhere. A batch whose ids are missing
 * or don't line up with its committed count is listed under `unrecoverable`
 * with a reason — it is never dropped from the plan.
 */

export type ImportEntity = "customer" | "site" | "contact" | "staff" | "licence";

/** What the commit step knows about one batch (one entity of one import). */
export interface ImportBatchRecord {
  /** Correlation id minted for this batch (the intake_id sent to the RPC). */
  intakeId: string;
  entity: ImportEntity | string;
  table: string;
  committedCount: number;
  /**
   * Ids returned by the commit RPC, one slot per committed row. A slot is
   * undefined when the id could not be tied to a row.
   */
  committedIds: (string | undefined)[];
  /** Rows parked in review instead of written. Not part of a delete plan. */
  stagedCount?: number;
}

export interface UndoStep {
  intakeId: string;
  entity: string;
  table: string;
  /** Distinct ids to remove, in first-seen order. */
  ids: string[];
}

export interface UnrecoverableBatch {
  intakeId: string;
  entity: string;
  table: string;
  committedCount: number;
  knownIds: number;
  reason: "no_ids_recorded" | "ids_incomplete" | "ids_exceed_count" | "duplicate_ids";
  /** Ids that are known and can still be removed by hand if the owner agrees. */
  partialIds: string[];
}

export interface UndoPlan {
  /** Steps in a safe delete order (children before parents). */
  steps: UndoStep[];
  unrecoverable: UnrecoverableBatch[];
  /** Batches that wrote nothing (committed 0) — listed so none vanish. */
  nothingToUndo: Array<{ intakeId: string; entity: string; table: string; stagedCount: number }>;
  totals: {
    batches: number;
    idsToRemove: number;
    committedRows: number;
    unrecoverableRows: number;
  };
  /** Fixed caveats the caller should show next to any "undo" button. */
  caveats: string[];
}

/** Delete children before parents (reverse of the FK-order commit). */
const DELETE_ORDER = ["contact", "site", "licence", "staff", "customer"];

function rank(entity: string): number {
  const i = DELETE_ORDER.indexOf(entity);
  return i === -1 ? DELETE_ORDER.length : i;
}

export const UNDO_CAVEATS: readonly string[] = [
  "Ids come from the commit step; a revert deletes those rows by id and nothing else.",
  "A row the commit merged into an existing record has no separate id and cannot be undone by delete.",
  "Rows other users edited after the import would be deleted with the import.",
  "Rows staged for review are not written; discard them from the review queue instead.",
];

/**
 * Build the undo plan for a set of committed batches. Pure: same input, same
 * output, no I/O.
 */
export function buildUndoPlan(batches: readonly ImportBatchRecord[]): UndoPlan {
  const steps: UndoStep[] = [];
  const unrecoverable: UnrecoverableBatch[] = [];
  const nothingToUndo: UndoPlan["nothingToUndo"] = [];
  let committedRows = 0;
  let unrecoverableRows = 0;

  for (const b of batches) {
    const stagedCount = b.stagedCount ?? 0;
    if (b.committedCount <= 0) {
      nothingToUndo.push({ intakeId: b.intakeId, entity: b.entity, table: b.table, stagedCount });
      continue;
    }
    committedRows += b.committedCount;

    const known = b.committedIds.filter((x): x is string => typeof x === "string" && x !== "");
    const distinct = [...new Set(known)];

    let reason: UnrecoverableBatch["reason"] | null = null;
    if (known.length === 0) reason = "no_ids_recorded";
    else if (distinct.length !== known.length) reason = "duplicate_ids";
    else if (known.length > b.committedCount) reason = "ids_exceed_count";
    else if (known.length < b.committedCount) reason = "ids_incomplete";

    if (reason) {
      unrecoverableRows += b.committedCount;
      unrecoverable.push({
        intakeId: b.intakeId,
        entity: b.entity,
        table: b.table,
        committedCount: b.committedCount,
        knownIds: known.length,
        reason,
        partialIds: distinct,
      });
      continue;
    }
    steps.push({ intakeId: b.intakeId, entity: b.entity, table: b.table, ids: distinct });
  }

  steps.sort((a, z) => rank(a.entity) - rank(z.entity));

  return {
    steps,
    unrecoverable,
    nothingToUndo,
    totals: {
      batches: batches.length,
      idsToRemove: steps.reduce((n, s) => n + s.ids.length, 0),
      committedRows,
      unrecoverableRows,
    },
    caveats: [...UNDO_CAVEATS],
  };
}
