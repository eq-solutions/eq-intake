/**
 * DetectionLine — "what is it?" for one dropped file, replacing the old
 * 42-type domain picker. Three tiers driven by classifySheet's own output
 * (method + per-role scores) — no new classification logic, just a
 * presentation layer over what classify.ts already returns:
 *
 *   confident        — method === "heuristic": green check, "Change" link.
 *   close call       — ambiguous, but the top two candidates are both
 *                       plausible: two direct-pick buttons.
 *   unsure           — ambiguous and no plausible candidate (or the user
 *                       clicked "Change"): a plain-language type dropdown.
 *
 * Per INTAKE-REDESIGN-SPEC.md §5.2 / the 2026-08-17 build spec's state B.
 */

import { useMemo, useState, type JSX } from "react";
import type { FileSlot } from "./intake-bundle.js";
import type { RoleName } from "../rollup/roles.js";
import { entityLabel } from "./entity-label.js";
import { previewMultiValueCandidates, type MultiValueCandidate } from "../canonical/commit-canonical.js";

const ALL_ROLES: RoleName[] = ["customer", "contact", "site", "staff"];

/** Gap below which two candidates both count as "plausible" — mirrors classify.ts's own heuristicMargin default. */
const CLOSE_CALL_MARGIN = 0.15;
/** Below this, even the top candidate isn't worth offering as a one-click pick. */
const PLAUSIBLE_FLOOR = 0.3;

export interface DetectionLineProps {
  slot: FileSlot;
  onPick: (role: RoleName) => void;
}

export function DetectionLine({ slot, onPick }: DetectionLineProps): JSX.Element | null {
  const [overriding, setOverriding] = useState(false);

  // A pick always resolves back to the confident state (setSlotRole marks the
  // slot "heuristic") — clear the local override flag so this component falls
  // through to that branch instead of getting stuck showing the picker.
  const handlePick = (role: RoleName) => {
    setOverriding(false);
    onPick(role);
  };

  // Informational only (no gate here — CommitView is where "Save into EQ"
  // actually blocks on this, via shared/precommit-warnings.ts). Computed
  // whenever the sheet or its resolved role changes, not on every render.
  const multiValueCandidates = useMemo(
    () =>
      slot.sheet && slot.role !== "unknown"
        ? previewMultiValueCandidates(slot.sheet, slot.role)
        : [],
    [slot.sheet, slot.role],
  );
  const withWarnings = (tier: JSX.Element): JSX.Element =>
    multiValueCandidates.length === 0 ? tier : (
      <>
        {tier}
        <MultiValueWarning candidates={multiValueCandidates} />
      </>
    );

  if (slot.error || slot.role === "unknown" || !slot.sheet) return null;

  const confident = slot.method === "heuristic" && !overriding;

  if (confident) {
    const n = slot.sheet.rows.length;
    return withWarnings(
      <div className="eq-detect eq-detect--confident">
        <span className="eq-detect__icon eq-detect__icon--ok">✓</span>
        <span>
          Looks like <b>{entityLabel(slot.role)}</b> — {n.toLocaleString()} item{n === 1 ? "" : "s"}
        </span>
        <button type="button" className="eq-detect__change" onClick={() => setOverriding(true)}>
          Change
        </button>
      </div>,
    );
  }

  const ranked = Object.entries(slot.scores ?? {}).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const closeCall =
    !overriding &&
    top &&
    second &&
    top[1] >= PLAUSIBLE_FLOOR &&
    top[1] - second[1] < CLOSE_CALL_MARGIN &&
    ALL_ROLES.includes(top[0] as RoleName) &&
    ALL_ROLES.includes(second[0] as RoleName);

  if (closeCall) {
    const a = top[0] as RoleName;
    const b = second[0] as RoleName;
    return withWarnings(
      <div className="eq-detect eq-detect--closecall">
        <div className="eq-detect__row">
          <span className="eq-detect__icon eq-detect__icon--ok">✓</span>
          <span>
            This could be <b>{entityLabel(a)}</b> or <b>{entityLabel(b)}</b>.
          </span>
        </div>
        <div className="eq-detect__picks">
          <button type="button" className="eq-detect__pick" onClick={() => handlePick(a)}>
            {entityLabel(a)}
          </button>
          <button type="button" className="eq-detect__pick" onClick={() => handlePick(b)}>
            {entityLabel(b)}
          </button>
        </div>
      </div>,
    );
  }

  return withWarnings(
    <div className="eq-detect eq-detect--unsure">
      <div className="eq-detect__row">
        <span className="eq-detect__icon eq-detect__icon--unsure">?</span>
        <span>We couldn't place this one — what is it?</span>
      </div>
      <UnsurePicker onPick={handlePick} />
    </div>,
  );
}

function MultiValueWarning({ candidates }: { candidates: MultiValueCandidate[] }): JSX.Element {
  return (
    <div className="eq-detect eq-detect--multivalue" role="alert">
      {candidates.map((c) => {
        const n = c.affectedRowCount;
        const examples = c.sampleValues.slice(0, 2).join("; ");
        return (
          <div key={c.field} className="eq-detect__row">
            <span className="eq-detect__icon eq-detect__icon--unsure">⚠</span>
            <span>
              '{c.sourceColumn}' has {n} row{n === 1 ? "" : "s"} with more than one value (e.g.{" "}
              {examples}) — saves as one combined value unless fixed first.
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UnsurePicker({ onPick }: { onPick: (role: RoleName) => void }): JSX.Element {
  const [choice, setChoice] = useState<RoleName>(ALL_ROLES[0]!);
  return (
    <div className="eq-detect__picker">
      <select
        className="eq-detect__select"
        value={choice}
        onChange={(e) => setChoice(e.target.value as RoleName)}
      >
        {ALL_ROLES.map((r) => (
          <option key={r} value={r}>
            {entityLabel(r)}
          </option>
        ))}
      </select>
      <button type="button" className="eq-detect__use" onClick={() => onPick(choice)}>
        Use this
      </button>
    </div>
  );
}
