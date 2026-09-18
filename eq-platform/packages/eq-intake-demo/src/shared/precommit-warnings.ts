/**
 * precommit-warnings — pure helpers for the "check these before saving" gate
 * on IntakeModule's CommitView. Two concerns share one mechanism:
 *   - a slot's classification wasn't a clean heuristic match (ai / ambiguous_fallback)
 *   - a slot has a schema-hinted field that looks like more than one value
 *     (see canonical/commit-canonical.ts's previewMultiValueCandidates)
 *
 * Kept separate from IntakeModule.tsx / DetectionLine.tsx so the logic is
 * testable without rendering — this package has no component-testing infra,
 * so pure exported helpers (mirrors @eq/confirm-ui's classificationMismatchMessage)
 * are the established pattern here.
 */

import { roleLabel, type FileSlot } from "./intake-bundle.js";
import { previewMultiValueCandidates } from "../canonical/commit-canonical.js";
import type { RoleName } from "../rollup/roles.js";

export type PreCommitWarning =
  | {
      kind: "low_confidence";
      slotLabel: string;
      role: RoleName;
      method: "ai" | "ambiguous_fallback";
    }
  | {
      kind: "multi_value";
      slotLabel: string;
      field: string;
      sourceColumn: string;
      affectedRowCount: number;
      sampleValues: string[];
    };

/**
 * Scan every classified slot for anything worth a human glance before "Save
 * into EQ" — a shaky classification, or a cell that looks like it packs more
 * than one value. Mirrors the checkbox-acknowledgment gate @eq/confirm-ui's
 * MappingTable already applies to classification alone, extended to cover
 * multi-value cells too — eq-shell's real intake pipeline never renders
 * MappingTable at all, so neither warning reaches it any other way.
 */
export function collectPreCommitWarnings(slots: FileSlot[]): PreCommitWarning[] {
  const warnings: PreCommitWarning[] = [];
  for (const slot of slots) {
    if (slot.role === "unknown" || !slot.sheet) continue;

    if (slot.method && slot.method !== "heuristic") {
      warnings.push({
        kind: "low_confidence",
        slotLabel: slot.file.name,
        role: slot.role,
        method: slot.method,
      });
    }

    for (const c of previewMultiValueCandidates(slot.sheet, slot.role)) {
      warnings.push({
        kind: "multi_value",
        slotLabel: slot.file.name,
        field: c.field,
        sourceColumn: c.sourceColumn,
        affectedRowCount: c.affectedRowCount,
        sampleValues: c.sampleValues,
      });
    }
  }
  return warnings;
}

/** Plain-English line for one warning, for the review panel's list. */
export function describeWarning(w: PreCommitWarning): string {
  if (w.kind === "low_confidence") {
    const reason =
      w.method === "ai"
        ? "an AI guess, not a clear column match"
        : "a rough guess — the column names didn't clearly point to one type";
    return `"${w.slotLabel}" — not fully sure this is ${roleLabel(w.role)} (${reason}). Check it's the right type before saving.`;
  }
  const n = w.affectedRowCount;
  const examples = w.sampleValues.slice(0, 2).join("; ");
  return `"${w.slotLabel}" — ${n} row${n === 1 ? "" : "s"} in '${w.sourceColumn}' look${n === 1 ? "s" : ""} like more than one value (e.g. ${examples}). They'll save as one combined value unless you fix the source file first.`;
}

/**
 * Stable key over the current warning set. CommitView resets its
 * acknowledgment checkbox whenever this changes — e.g. a new file lands, a
 * classification gets corrected, or a problem file is removed — so an
 * earlier "I've checked these" never silently covers a DIFFERENT problem.
 */
export function warningsFingerprint(warnings: PreCommitWarning[]): string {
  return warnings
    .map((w) =>
      w.kind === "low_confidence"
        ? `low_confidence:${w.slotLabel}:${w.role}:${w.method}`
        : `multi_value:${w.slotLabel}:${w.field}:${w.affectedRowCount}`,
    )
    .join("|");
}
