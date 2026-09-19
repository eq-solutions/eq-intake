/**
 * ResultPanel — the Into-EQ "done" screen (states C1/C2 of the 2026-08-17
 * build spec). Replaces CommitSummary's chip-row layout with the spec's
 * header + sub-line + action pair; same counts (committedCount /
 * flaggedCount / rejectedCount) off the same CommitResult, just presented
 * per the spec instead of as bare chips. The flagged/rejected row lists
 * below this (RowsDisclosure, in CommitView) are unchanged — this only
 * replaces the summary line above them.
 *
 * The sub-line used to promise "you can trace any row in Audit log" —
 * that was true only while eq_intake_events was still being written from
 * here (commit-canonical.ts's now-removed createIntakeEvent; see its
 * top-of-file comment). Nothing populates that row anymore, so the claim
 * would be false for every real commit once commits actually started
 * succeeding (PR #142) — dropped rather than left to mislead.
 */

import type { JSX } from "react";
import type { CommitResult } from "../canonical/commit-canonical.js";
import { entityLabel } from "./entity-label.js";

export interface ResultPanelProps {
  result: CommitResult;
  sourceFilename: string;
  /** "View in {place} →" — jumps to this module's own Overview drill-down for that entity. */
  onViewEntity: (entity: string) => void;
  /**
   * "View in To Do →" for staged rows — jumps to the To Do tab, which already
   * has real Approve/Dismiss/Change-answer on exactly these queue rows. Can't
   * deep-link to the specific rows from this commit yet: StageCommitResult
   * only returns an aggregate staged_count, not per-row queue ids.
   */
  onViewQueue: () => void;
  /** "Bring in another" — resets the drop zone bundle. */
  onReset: () => void;
}

export function ResultPanel({ result, sourceFilename, onViewEntity, onViewQueue, onReset }: ResultPanelProps): JSX.Element {
  const saved = result.perEntity.reduce((n, r) => n + r.committedCount, 0);
  const staged = result.perEntity.reduce((n, r) => n + r.stagedCount, 0);
  const rejected = result.perEntity.reduce((n, r) => n + r.rejectedCount, 0);
  const hasFatal = result.perEntity.some((r) => r.fatalError);
  const committedEntities = result.perEntity.filter((r) => r.committedCount > 0);

  if (hasFatal && saved === 0) {
    const firstError = result.perEntity.find((r) => r.fatalError)?.fatalError;
    return (
      <div className="eq-result" data-status="error">
        <div className="eq-result__head" data-status="error">
          <span className="eq-result__icon" data-status="error">✗</span>
          Couldn't save
        </div>
        {firstError && <p className="eq-result__sub">{firstError}</p>}
      </div>
    );
  }

  const headline =
    committedEntities.length === 1
      ? `Saved ${committedEntities[0]!.committedCount.toLocaleString()} ${entityLabel(committedEntities[0]!.entity).toLowerCase()} into EQ`
      : `Saved ${saved.toLocaleString()} record${saved === 1 ? "" : "s"} into EQ`;

  return (
    <div className="eq-result" data-status={rejected > 0 ? "warn" : "ok"}>
      <div className="eq-result__head" data-status={rejected > 0 ? "warn" : "ok"}>
        <span className="eq-result__icon" data-status={rejected > 0 ? "warn" : "ok"}>
          {rejected > 0 ? "⚠" : "✓"}
        </span>
        {headline}
      </div>

      {committedEntities.length > 1 && (
        <div className="eq-result__chips">
          {committedEntities.map((r) => (
            <span key={r.entity} className="eq-result__chip">
              {r.committedCount.toLocaleString()} {entityLabel(r.entity).toLowerCase()}
            </span>
          ))}
        </div>
      )}

      {sourceFilename && (
        <p className="eq-result__sub">
          Filed from {sourceFilename}.
        </p>
      )}

      {staged > 0 && (
        <p className="eq-result__sub eq-result__sub--warn">
          {staged.toLocaleString()} row{staged === 1 ? "" : "s"} waiting in the review queue —{" "}
          <button type="button" className="eq-result__link" onClick={onViewQueue}>
            View in To Do →
          </button>
        </p>
      )}

      <div className="eq-result__actions">
        {committedEntities.map((r) => (
          <button
            key={r.entity}
            type="button"
            className="eq-intake-btn-primary"
            onClick={() => onViewEntity(r.entity)}
          >
            View in {entityLabel(r.entity)} →
          </button>
        ))}
        <button type="button" className="eq-intake-btn-ghost" onClick={onReset}>
          Bring in another
        </button>
      </div>
    </div>
  );
}
