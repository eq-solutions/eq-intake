/**
 * PrecommitQuestionQueue — the "Check these before saving" panel, presented
 * one question at a time instead of a flat bullet list behind a single
 * checkbox. Each of the four kinds handled here already has a real
 * resolution (a column pick, a merge/keep, a split/keep-combined, a
 * skip/keep) — this component only changes how they're PRESENTED: the
 * current question front and centre, resolved ones collapsed into a running
 * trail above it, so answering one always reveals the next without losing
 * the thread of what's already been settled.
 *
 * low_confidence isn't included here — it already resolves inline via
 * DetectionLine, right where the file was dropped; showing it again here,
 * with no button of its own, would just be a second, unanswerable copy of
 * the same question.
 */
import { type JSX } from "react";
import {
  describeWarning,
  type PreCommitWarning,
  type DuplicateRowsResolution,
  type MultiValueResolution,
} from "./precommit-warnings.js";
import type { RoleName } from "../rollup/roles.js";

export interface ResolvedLogEntry {
  key: string;
  summary: string;
}

export interface PrecommitQuestionQueueProps {
  /** Outstanding questions, in order — the first is the one presented. */
  warnings: PreCommitWarning[];
  /** Already-answered questions, oldest first — the trail above the current one. */
  resolvedLog: ResolvedLogEntry[];
  manualMappings: Partial<Record<RoleName, Record<string, string | null>>>;
  onPickColumn: (role: RoleName, field: string, header: string | null) => void;
  onResolveDuplicateExisting: (role: RoleName, rowIndex: number, action: "skip" | "keep") => void;
  onResolveDuplicateRows: (role: RoleName, rowIndices: [number, number], action: DuplicateRowsResolution) => void;
  onResolveMultiValue: (slotLabel: string, field: string, action: MultiValueResolution) => void;
}

export function PrecommitQuestionQueue({
  warnings,
  resolvedLog,
  manualMappings,
  onPickColumn,
  onResolveDuplicateExisting,
  onResolveDuplicateRows,
  onResolveMultiValue,
}: PrecommitQuestionQueueProps): JSX.Element | null {
  if (warnings.length === 0 && resolvedLog.length === 0) return null;

  const current = warnings[0];

  return (
    <div className="eq-qa-queue" role="group" aria-label="Check these before saving">
      {resolvedLog.length > 0 && (
        <ul className="eq-qa-queue__trail">
          {resolvedLog.map((entry) => (
            <li key={entry.key} className="eq-qa-queue__trail-item">
              <span className="eq-qa-queue__trail-check">✓</span>
              <span>{entry.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {current ? (
        <div className="eq-qa-queue__current">
          <div className="eq-qa-queue__progress">
            {warnings.length} thing{warnings.length === 1 ? "" : "s"} to check before saving
          </div>
          <div className="eq-qa-queue__question">{describeWarning(current)}</div>
          <div className="eq-qa-queue__answer">
            {current.kind === "unmapped_required" && (
              <UnmappedFieldPicker
                warning={current}
                currentHeader={
                  Object.entries(manualMappings[current.role] ?? {}).find(([, f]) => f === current.field)?.[0] ?? ""
                }
                onPick={(header) => onPickColumn(current.role, current.field, header || null)}
              />
            )}
            {current.kind === "duplicate_existing" && (
              <div className="eq-qa-queue__buttons">
                <button
                  type="button"
                  className="eq-qa-queue__btn"
                  onClick={() => onResolveDuplicateExisting(current.role, current.rowIndex, "skip")}
                >
                  Skip — already in EQ
                </button>
                <button
                  type="button"
                  className="eq-qa-queue__btn eq-qa-queue__btn--secondary"
                  onClick={() => onResolveDuplicateExisting(current.role, current.rowIndex, "keep")}
                >
                  Keep — different record
                </button>
              </div>
            )}
            {current.kind === "duplicate_rows" && (
              <div className="eq-qa-queue__buttons">
                <button
                  type="button"
                  className="eq-qa-queue__btn"
                  onClick={() => onResolveDuplicateRows(current.role, current.rowIndices, "merge")}
                >
                  Merge — same record
                </button>
                <button
                  type="button"
                  className="eq-qa-queue__btn eq-qa-queue__btn--secondary"
                  onClick={() => onResolveDuplicateRows(current.role, current.rowIndices, "keep_both")}
                >
                  Keep both — different
                </button>
              </div>
            )}
            {current.kind === "multi_value" && (
              <div className="eq-qa-queue__buttons">
                <button
                  type="button"
                  className="eq-qa-queue__btn"
                  onClick={() => onResolveMultiValue(current.slotLabel, current.field, "split")}
                >
                  Split into separate rows
                </button>
                <button
                  type="button"
                  className="eq-qa-queue__btn eq-qa-queue__btn--secondary"
                  onClick={() => onResolveMultiValue(current.slotLabel, current.field, "keep_combined")}
                >
                  Keep as one value
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="eq-qa-queue__done">
          <span className="eq-qa-queue__done-icon">✓</span>
          All clear — ready to save.
        </div>
      )}
    </div>
  );
}

/**
 * "Which column is X?" picker for one unmapped_required question. Offers
 * every header in that slot's sheet, plus a blank "not picked yet" option so
 * nothing is silently pre-selected. Picking a header removes the question
 * (see collectPreCommitWarnings's manualMappings param) rather than just
 * acknowledging it, since a pick is an actual fix, not a known limitation.
 */
function UnmappedFieldPicker({
  warning,
  currentHeader,
  onPick,
}: {
  warning: Extract<PreCommitWarning, { kind: "unmapped_required" }>;
  currentHeader: string;
  onPick: (header: string) => void;
}): JSX.Element {
  return (
    <div className="eq-qa-queue__pick">
      <select
        aria-label={`Which column is ${warning.field.replace(/_/g, " ")}?`}
        value={currentHeader}
        onChange={(e) => onPick(e.target.value)}
      >
        <option value="">— pick a column —</option>
        {warning.availableHeaders.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}
