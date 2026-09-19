/**
 * precommit-warnings — pure helpers for the "check these before saving" gate
 * on IntakeModule's CommitView. Three concerns share one mechanism:
 *   - a slot's classification wasn't a clean heuristic match (ai / ambiguous_fallback)
 *   - a slot has a schema-hinted field that looks like more than one value
 *     (see canonical/commit-canonical.ts's previewMultiValueCandidates)
 *   - a slot has a required field no column mapped to
 *     (see canonical/commit-canonical.ts's previewUnmappedRequiredFields)
 *
 * Kept separate from IntakeModule.tsx / DetectionLine.tsx so the logic is
 * testable without rendering — this package has no component-testing infra,
 * so pure exported helpers (mirrors @eq/confirm-ui's classificationMismatchMessage)
 * are the established pattern here.
 */

import { roleLabel, type FileSlot } from "./intake-bundle.js";
import {
  previewMultiValueCandidates,
  previewUnmappedRequiredFields,
} from "../canonical/commit-canonical.js";
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
    }
  | {
      kind: "unmapped_required";
      slotLabel: string;
      role: RoleName;
      field: string;
      reason: "required" | "customer_needs_a_name";
      availableHeaders: string[];
    };

/**
 * Scan every classified slot for anything worth a human glance before "Save
 * into EQ" — a shaky classification, a cell that looks like it packs more
 * than one value, or a required field no column filled. Mirrors the
 * checkbox-acknowledgment gate @eq/confirm-ui's MappingTable already applies
 * to classification alone, extended to cover the other two — eq-shell's real
 * intake pipeline never renders MappingTable at all, so none of these three
 * warnings reach it any other way.
 *
 * manualMappings carries any per-role, per-header override a human has
 * already picked in CommitView (e.g. resolving an unmapped_required warning
 * by choosing which column is the company name) — both preview functions
 * treat it as taking priority over inferMapping()'s own exact-match result,
 * same as commitOneEntity does at actual commit time, so a resolved warning
 * disappears from this list the moment it's picked rather than needing a
 * separate "resolved" state to track.
 */
export function collectPreCommitWarnings(
  slots: FileSlot[],
  manualMappings?: Partial<Record<RoleName, Record<string, string | null>>>,
): PreCommitWarning[] {
  const warnings: PreCommitWarning[] = [];
  for (const slot of slots) {
    if (slot.role === "unknown" || !slot.sheet) continue;
    const manualMapping = manualMappings?.[slot.role];

    if (slot.method && slot.method !== "heuristic") {
      warnings.push({
        kind: "low_confidence",
        slotLabel: slot.file.name,
        role: slot.role,
        method: slot.method,
      });
    }

    for (const c of previewMultiValueCandidates(slot.sheet, slot.role, manualMapping)) {
      warnings.push({
        kind: "multi_value",
        slotLabel: slot.file.name,
        field: c.field,
        sourceColumn: c.sourceColumn,
        affectedRowCount: c.affectedRowCount,
        sampleValues: c.sampleValues,
      });
    }

    for (const u of previewUnmappedRequiredFields(slot.sheet, slot.role, manualMapping)) {
      warnings.push({
        kind: "unmapped_required",
        slotLabel: slot.file.name,
        role: slot.role,
        field: u.field,
        reason: u.reason,
        availableHeaders: u.availableHeaders,
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
  if (w.kind === "unmapped_required") {
    if (w.reason === "customer_needs_a_name") {
      return `"${w.slotLabel}" — couldn't find a company name or person's name column. Pick the column that has it below, or these rows won't save.`;
    }
    return `"${w.slotLabel}" — couldn't find a column for "${w.field.replace(/_/g, " ")}". Pick one below, or this row won't save.`;
  }
  const n = w.affectedRowCount;
  const examples = w.sampleValues.slice(0, 2).join("; ");
  return `"${w.slotLabel}" — ${n} row${n === 1 ? "" : "s"} in '${w.sourceColumn}' look${n === 1 ? "s" : ""} like more than one value (e.g. ${examples}). They'll save as one combined value unless you fix the source file first.`;
}

/**
 * Stable key over the current warning set. CommitView resets its
 * acknowledgment checkbox whenever this changes — e.g. a new file lands, a
 * classification gets corrected, a manual mapping pick resolves an
 * unmapped_required warning, or a problem file is removed — so an earlier
 * "I've checked these" never silently covers a DIFFERENT problem.
 */
export function warningsFingerprint(warnings: PreCommitWarning[]): string {
  return warnings
    .map((w) => {
      if (w.kind === "low_confidence") return `low_confidence:${w.slotLabel}:${w.role}:${w.method}`;
      if (w.kind === "unmapped_required") return `unmapped_required:${w.slotLabel}:${w.field}:${w.reason}`;
      return `multi_value:${w.slotLabel}:${w.field}:${w.affectedRowCount}`;
    })
    .join("|");
}
