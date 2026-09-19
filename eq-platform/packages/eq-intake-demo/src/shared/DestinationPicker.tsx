/**
 * DestinationPicker — Into EQ (primary) + Quick Export (secondary, collapsed).
 *
 * Replaces the old <select>-based picker (three <optgroup>s) with the flat
 * pill row from INTAKE-REDESIGN-SPEC.md §5.3 / the 2026-08-17 build spec's
 * state B1. Per the build spec's "drop join templates for v1"
 * recommendation, the rollup engine's BUILTIN_TEMPLATES (Xero/MYOB/SimPRO
 * join exports) don't get pills here — they'd crowd the two hero flows
 * (Into EQ, quick exports) this screen exists to make fast. The capability
 * isn't gone: it still has a full home in RollupDropZone (the Rollup tab),
 * which also supports user-built templates that a flat pill row couldn't
 * represent anyway.
 *
 * Into EQ and Quick Export answer opposite questions — "bring this file in"
 * vs. "reshape my data for another system" — but a flat pill row of both
 * (the original state B1 layout) put them at equal visual weight under one
 * "Where's it going?" label, so an average first-time user had to read and
 * discount five export options before finding the one they came for. Into
 * EQ is now its own block (already the default — see IntakeModule's
 * `useState(INTO_EQ_ID)`); Quick Export sits behind a closed-by-default
 * <details> disclosure that opens itself once a quick destination is
 * selected, or the user opens it by hand — and then stays open, since it
 * only ever forces itself open, never closed, so it can't fight a manual
 * toggle on some later unrelated re-render.
 *
 * "Other…" (upload a sample list, match by column) is in the spec's copy
 * deck but has no engine behind it yet, so it renders disabled rather than
 * pretending to work.
 */

import { useState, type JSX } from "react";
import type { IntakeBundle } from "./intake-bundle.js";
import { roleLabel } from "./intake-bundle.js";
import { QUICK_DESTINATIONS, type QuickDestination } from "../quick-export/destinations.js";
import type { RoleName } from "../rollup/roles.js";

export const INTO_EQ_ID = "into-eq";
/** Namespaces QUICK_DESTINATIONS ids so the picker's value is unambiguous. */
export const QUICK_PREFIX = "quick:";
const OTHER_ID = "other";

export interface DestOption {
  id: string;
  label: string;
  description: string;
  /** Roles this destination needs present in the dropped bundle. Empty = Into EQ (accepts any recognised file). */
  needsRoles: RoleName[];
}

export const INTO_EQ_OPTION: DestOption = {
  id: INTO_EQ_ID,
  label: "Into EQ",
  description:
    "Save these records into EQ — customers, sites and contacts in one place, so you don't retype them anywhere else.",
  needsRoles: [],
};

const QUICK_OPTIONS: DestOption[] = QUICK_DESTINATIONS.map((d) => ({
  id: `${QUICK_PREFIX}${d.id}`,
  label: d.label,
  description: d.description,
  needsRoles: [d.needsRole],
}));

export const ALL_OPTIONS: DestOption[] = [INTO_EQ_OPTION, ...QUICK_OPTIONS];

export function findQuickDestination(id: string): QuickDestination | undefined {
  return QUICK_DESTINATIONS.find((d) => `${QUICK_PREFIX}${d.id}` === id);
}

function destAvailable(opt: DestOption, bundle: IntakeBundle): boolean {
  if (opt.needsRoles.length === 0) return bundle.availableRoles.size > 0;
  return opt.needsRoles.every((r) => bundle.availableRoles.has(r));
}

function missingRoles(opt: DestOption, bundle: IntakeBundle): RoleName[] {
  return opt.needsRoles.filter((r) => !bundle.availableRoles.has(r));
}

export interface DestinationPickerProps {
  destId: string;
  bundle: IntakeBundle;
  onChange: (id: string) => void;
}

export function DestinationPicker({ destId, bundle, onChange }: DestinationPickerProps): JSX.Element {
  const intoEqAvailable = destAvailable(INTO_EQ_OPTION, bundle);
  const intoEqActive = destId === INTO_EQ_ID;
  // <details>'s `open` must be a real, controlled value — a derived
  // `open={!intoEqActive}` looked right but silently re-closed on any
  // unrelated re-render while a user had it manually expanded (caught live:
  // click to open, then anything else re-renders IntakeModule, and it snaps
  // shut under the user's cursor). Once opened — by picking a quick
  // destination or by hand — it stays open; it only forces itself open, never
  // closed, so it can't fight a manual toggle.
  const [manuallyOpened, setManuallyOpened] = useState(false);

  return (
    <div className="eq-intake-dest">
      <button
        type="button"
        className={
          "eq-dest-primary" + (intoEqActive ? " eq-dest-primary--active" : "") + (!intoEqAvailable ? " eq-dest-primary--disabled" : "")
        }
        disabled={!intoEqAvailable}
        onClick={() => onChange(INTO_EQ_ID)}
      >
        <span className="eq-dest-primary__label">{INTO_EQ_OPTION.label}</span>
        <span className="eq-dest-primary__desc">
          {intoEqAvailable ? INTO_EQ_OPTION.description : "Drop a file we can recognise first."}
        </span>
      </button>

      <details
        className="eq-intake-dest-more"
        open={manuallyOpened || !intoEqActive}
        onToggle={(e) => setManuallyOpened(e.currentTarget.open)}
      >
        <summary>Need a ready-made file for another system instead?</summary>
        <div className="eq-intake-dest__row">
          {QUICK_OPTIONS.map((opt) => {
            const available = destAvailable(opt, bundle);
            const missing = missingRoles(opt, bundle);
            const active = opt.id === destId;
            const suffix =
              !available && missing.length > 0 ? ` — needs ${missing.map(roleLabel).join(" + ")}` : "";
            return (
              <button
                key={opt.id}
                type="button"
                className={
                  "eq-dest-pill" + (active ? " eq-dest-pill--active" : "") + (!available ? " eq-dest-pill--disabled" : "")
                }
                disabled={!available}
                title={opt.description}
                onClick={() => onChange(opt.id)}
              >
                {opt.label}
                {suffix}
              </button>
            );
          })}
          <button
            type="button"
            className="eq-dest-pill eq-dest-pill--disabled"
            disabled
            title="Upload a sample of your target list and we'll match it — coming soon."
          >
            Other…
          </button>
        </div>
      </details>
    </div>
  );
}

export { OTHER_ID };
