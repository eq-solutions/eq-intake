/**
 * precommit-warnings — pure helpers for the "check these before saving" gate
 * on IntakeModule's CommitView. Four concerns share one mechanism:
 *   - a slot's classification wasn't a clean heuristic match (ai / ambiguous_fallback)
 *   - a slot has a schema-hinted field that looks like more than one value
 *     (see canonical/commit-canonical.ts's previewMultiValueCandidates)
 *   - a slot has a required field no column mapped to
 *     (see canonical/commit-canonical.ts's previewUnmappedRequiredFields)
 *   - two rows in the same slot look like the same record
 *     (see canonical/commit-canonical.ts's previewDuplicateRows)
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
  previewDuplicateRows,
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
    }
  | {
      kind: "duplicate_rows";
      slotLabel: string;
      role: RoleName;
      rowIndices: [number, number];
      values: [string, string];
      similarity: number;
    }
  | {
      kind: "duplicate_existing";
      slotLabel: string;
      role: RoleName;
      rowIndex: number;
      newValue: string;
      existingId: string;
      existingLabel: string;
      similarity: number;
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

    for (const d of previewDuplicateRows(slot.sheet, slot.role, manualMapping)) {
      warnings.push({
        kind: "duplicate_rows",
        slotLabel: slot.file.name,
        role: slot.role,
        rowIndices: d.rowIndices,
        values: d.values,
        similarity: d.similarity,
      });
    }
  }
  return warnings;
}

/**
 * Plain-English line for one warning, for the review panel's list. Kept
 * short and scannable on purpose — a human's already seen the fuller
 * explanation once, in DetectionLine, before reaching this panel; repeating
 * it at length here just made the real screen read as noise (feedback from
 * watching the actual production screen, not a style guess).
 */
export function describeWarning(w: PreCommitWarning): string {
  if (w.kind === "low_confidence") {
    const reason = w.method === "ai" ? "an AI guess" : "a guess from the column names";
    return `"${w.slotLabel}" — might not be ${roleLabel(w.role)} (${reason}). Check before saving.`;
  }
  if (w.kind === "unmapped_required") {
    if (w.reason === "customer_needs_a_name") {
      return `"${w.slotLabel}" — which column has the company name or person's name?`;
    }
    return `"${w.slotLabel}" — which column is "${w.field.replace(/_/g, " ")}"?`;
  }
  if (w.kind === "duplicate_rows") {
    const [a, b] = w.values;
    return `"${w.slotLabel}" — rows ${w.rowIndices[0] + 1} and ${w.rowIndices[1] + 1} look like the same one: "${a}" / "${b}".`;
  }
  if (w.kind === "duplicate_existing") {
    return `"${w.slotLabel}" — row ${w.rowIndex + 1} ("${w.newValue}") looks like it might already be in EQ as "${w.existingLabel}".`;
  }
  const n = w.affectedRowCount;
  const examples = w.sampleValues.slice(0, 2).join("; ");
  return `"${w.slotLabel}" — '${w.sourceColumn}' has ${n} row${n === 1 ? "" : "s"} with more than one value (e.g. ${examples}) — saves as one combined value unless fixed first.`;
}

/**
 * Stable key over the current warning set. CommitView resets its
 * acknowledgment checkbox whenever this changes — e.g. a new file lands, a
 * classification gets corrected, a manual mapping pick resolves an
 * unmapped_required warning, or a problem file is removed — so an earlier
 * "I've checked these" never silently covers a DIFFERENT problem.
 */
export type DuplicateRowsResolution = "merge" | "keep_both";
export type MultiValueResolution = "split" | "keep_combined";

/** Resolution key for a duplicate_rows pair — order matches the warning's own rowIndices. */
export function duplicateRowsKey(role: RoleName, rowIndices: [number, number]): string {
  return `${role}:${rowIndices[0]}:${rowIndices[1]}`;
}

/**
 * Resolution key for a multi_value warning — field-level (one candidate
 * already covers every affected row in that column), keyed by slotLabel
 * rather than role since the multi_value variant carries no role of its own
 * (see PreCommitWarning's union) — a slot's file name is unique per bundle.
 */
export function multiValueKey(slotLabel: string, field: string): string {
  return `${slotLabel}:${field}`;
}

/**
 * Drops any duplicate_rows/multi_value warning the user already resolved —
 * a real fix, same principle unmapped_required's column-pick and
 * duplicate_existing's Skip/Keep already follow. low_confidence and
 * unmapped_required aren't touched here: the former resolves by the slot's
 * role/method actually changing (DetectionLine's own picker), the latter by
 * manualMappings actually satisfying collectPreCommitWarnings, so both
 * already disappear on their own without a separate resolution map.
 */
export function filterResolvedWarnings(
  warnings: PreCommitWarning[],
  duplicateRowsResolutions: Record<string, DuplicateRowsResolution>,
  multiValueResolutions: Record<string, MultiValueResolution>,
): PreCommitWarning[] {
  return warnings.filter((w) => {
    if (w.kind === "duplicate_rows") {
      return !duplicateRowsResolutions[duplicateRowsKey(w.role, w.rowIndices)];
    }
    if (w.kind === "multi_value") {
      return !multiValueResolutions[multiValueKey(w.slotLabel, w.field)];
    }
    return true;
  });
}

export function warningsFingerprint(warnings: PreCommitWarning[]): string {
  return warnings
    .map((w) => {
      if (w.kind === "low_confidence") return `low_confidence:${w.slotLabel}:${w.role}:${w.method}`;
      if (w.kind === "unmapped_required") return `unmapped_required:${w.slotLabel}:${w.field}:${w.reason}`;
      if (w.kind === "duplicate_rows") return `duplicate_rows:${w.slotLabel}:${w.rowIndices.join(",")}`;
      if (w.kind === "duplicate_existing") return `duplicate_existing:${w.slotLabel}:${w.rowIndex}:${w.existingId}`;
      return `multi_value:${w.slotLabel}:${w.field}:${w.affectedRowCount}`;
    })
    .join("|");
}
