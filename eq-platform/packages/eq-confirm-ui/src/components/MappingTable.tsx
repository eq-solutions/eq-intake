/**
 * MappingTable — confirm-mapping screen.
 *
 * Plain React component. Uses semantic HTML so the host app can style with
 * any framework (Tailwind, plain CSS, shadcn). className strings are
 * suggestive but functional in plain CSS too.
 *
 * Drop-in usage:
 *   const { useStore } = createConfirmFlow();
 *   <MappingTable
 *     store={useStore}
 *     canonicalFields={['first_name', 'last_name', ...]}
 *     schema={STAFF_SCHEMA}  // optional — enables grouped + described picker
 *   />
 *
 * Without `schema`: a flat alphabetical dropdown of canonicalFields. With
 * `schema`: fields are grouped by `x-eq-section` (when present), required
 * fields carry a red asterisk, and the field description is the option's
 * hover tooltip via the native title attribute.
 */

import { useMemo, useState, type JSX } from "react";
import type { UseBoundStore, StoreApi } from "zustand";
import type { FlowState } from "../types.js";
import { DestinationPicker } from "./DestinationPicker.js";

export interface MappingTableProps {
  /** Store hook returned by createConfirmFlow(). */
  store: UseBoundStore<StoreApi<FlowState>>;
  /** Canonical fields available as mapping targets (from the schema). */
  canonicalFields: string[];
  /**
   * Optional target schema. When provided, the picker groups by `x-eq-section`,
   * shows field descriptions on hover, and marks required fields. Without it,
   * the picker shows a flat alphabetical list of `canonicalFields`.
   */
  schema?: Record<string, unknown>;
  /** Optional callback when user clicks Continue. Caller usually calls driver.validate(). */
  onContinue?: () => void;
  /** Optional callback when user clicks Back. */
  onBack?: () => void;
  /**
   * Optional callback fired when the user sets a destination on the
   * non-blocking "Where is this going?" prompt. Host app can log this
   * to localStorage / a database to build a route map over time.
   */
  onDestinationChange?: (
    value: string | undefined,
    source: "suggested" | "free_text",
  ) => void;
}

interface FieldMeta {
  name: string;
  description?: string;
  required: boolean;
  section?: string;
}

export function MappingTable(props: MappingTableProps): JSX.Element {
  const parsedSheet = props.store((s) => s.parsedSheet);
  const aiMapping = props.store((s) => s.aiMapping);
  const userOverrides = props.store((s) => s.userOverrides);
  const setOverride = props.store((s) => s.setUserOverride);
  const classification = props.store((s) => s.classification);

  const targetEntity =
    typeof props.schema?.["x-eq-entity"] === "string"
      ? (props.schema["x-eq-entity"] as string)
      : undefined;
  const mismatchWarning = classificationMismatchMessage(classification, targetEntity);
  // Any classification uncertainty the package can detect must be explicitly
  // acknowledged before Continue — mirrors the demo UI's close-call/unsure
  // tiers, which never let an ambiguous result pass through silently.
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const continueBlocked = mismatchWarning !== null && !warningAcknowledged;

  const fields = useMemo(
    () => buildFieldMeta(props.canonicalFields, props.schema),
    [props.canonicalFields, props.schema],
  );
  const fieldsByName = useMemo(
    () => new Map(fields.map((f) => [f.name, f])),
    [fields],
  );
  const groups = useMemo(() => groupFields(fields), [fields]);

  if (!parsedSheet) {
    return <div className="eq-confirm-empty">No parsed sheet yet — drop a file above.</div>;
  }

  const headers = parsedSheet.headerRow;
  if (headers.length === 0) {
    return (
      <div className="eq-confirm-empty">
        <strong>That file didn't parse cleanly.</strong>
        <p>
          The reader found zero columns. Possible causes: empty file, wrong
          format (binary uploaded as CSV?), or an encoding the reader didn't
          recognise. Try a different file or use the sample buttons above.
        </p>
      </div>
    );
  }
  const aiByCol = new Map(
    (aiMapping?.mappings ?? []).map((m) => [m.sourceColumn, m]),
  );

  return (
    <div className="eq-confirm-mapping">
      {mismatchWarning ? (
        <div
          className={`eq-classification-warning eq-classification-warning--${mismatchWarning.severity}`}
          role="alert"
        >
          <strong>{mismatchWarning.title}</strong>
          <p>{mismatchWarning.body}</p>
          <label className="eq-classification-warning__ack">
            <input
              type="checkbox"
              checked={warningAcknowledged}
              onChange={(e) => setWarningAcknowledged(e.target.checked)}
            />
            I've checked this — continue anyway.
          </label>
        </div>
      ) : null}
      <header className="eq-confirm-mapping__header">
        <h2>Match your columns to EQ fields</h2>
        <p>
          {headers.length} source columns. {countMapped(userOverrides)} mapped.
          {fields.some((f) => f.required) ? (
            <>
              {" "}
              <span className="eq-required-marker" aria-hidden>
                *
              </span>{" "}
              = required field.
            </>
          ) : null}
        </p>
      </header>

      <DestinationPicker
        store={props.store}
        onChange={props.onDestinationChange}
      />

      <table className="eq-confirm-mapping__table">
        <thead>
          <tr>
            <th>Source column</th>
            <th>Sample values</th>
            <th>AI confidence</th>
            <th>Canonical field</th>
          </tr>
        </thead>
        <tbody>
          {headers.map((col) => {
            const ai = aiByCol.get(col);
            const samples = sampleValues(parsedSheet.rows, col, 3);
            const current = userOverrides[col] ?? ai?.canonicalField ?? null;
            const currentMeta = current ? fieldsByName.get(current) : undefined;
            return (
              <tr key={col}>
                <td>
                  <strong>{col}</strong>
                </td>
                <td>
                  <code>{samples.join(" • ")}</code>
                </td>
                <td>
                  {ai
                    ? `${Math.round((ai.confidence ?? 0) * 100)}%`
                    : "—"}
                </td>
                <td>
                  <div className="eq-confirm-mapping__picker">
                    <select
                      value={current ?? ""}
                      onChange={(e) =>
                        setOverride(col, e.target.value === "" ? null : e.target.value)
                      }
                      aria-label={`Canonical field for ${col}`}
                      title={currentMeta?.description ?? ""}
                    >
                      <option value="">— don't import —</option>
                      {groups.map((group) => {
                        const options = group.fields.map((f) => (
                          <option
                            key={f.name}
                            value={f.name}
                            title={f.description ?? ""}
                          >
                            {f.required ? `${f.name} *` : f.name}
                          </option>
                        ));
                        // If there's no section header (the single-group
                        // fallback), render options directly. Otherwise wrap
                        // in optgroup for native browser grouping.
                        if (!group.label) return options;
                        return (
                          <optgroup key={group.label} label={group.label}>
                            {options}
                          </optgroup>
                        );
                      })}
                    </select>
                    {currentMeta?.required ? (
                      <span
                        className="eq-required-marker"
                        title="Required field"
                        aria-label="required"
                      >
                        *
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <footer className="eq-confirm-mapping__footer">
        {props.onBack && (
          <button type="button" onClick={props.onBack}>
            Back
          </button>
        )}
        {props.onContinue && (
          <button
            type="button"
            onClick={props.onContinue}
            className="eq-primary"
            disabled={continueBlocked}
            title={
              continueBlocked
                ? "Check the classification warning above before continuing."
                : undefined
            }
          >
            Continue
          </button>
        )}
      </footer>
    </div>
  );
}

// ============================================================================
// HELPERS — exported so the demo / tests can reuse the same logic
// ============================================================================

/**
 * Build per-field metadata by intersecting the canonicalFields list with the
 * (optional) JSON Schema. Anything in canonicalFields that's NOT in the
 * schema still surfaces — sometimes consumers map to a subset.
 */
export function buildFieldMeta(
  canonicalFields: string[],
  schema?: Record<string, unknown>,
): FieldMeta[] {
  const props = schemaProperties(schema);
  const required = new Set(schemaRequired(schema));
  return canonicalFields.map((name) => {
    const def = props[name];
    return {
      name,
      description: typeof def?.description === "string" ? def.description : undefined,
      required: required.has(name),
      section:
        typeof def?.["x-eq-section"] === "string"
          ? (def["x-eq-section"] as string)
          : undefined,
    };
  });
}

interface FieldGroup {
  /** Section label. Empty when there are no sections (single flat group). */
  label: string;
  fields: FieldMeta[];
}

/**
 * Group fields by `x-eq-section`. If no field has a section, returns a
 * single group with an empty label containing all fields sorted alphabetically.
 * Otherwise, sorts sections alphabetically with the "unsectioned" bucket
 * coming last so it doesn't visually outweigh the real sections.
 */
export function groupFields(fields: FieldMeta[]): FieldGroup[] {
  const anySection = fields.some((f) => f.section);
  if (!anySection) {
    return [
      {
        label: "",
        fields: [...fields].sort((a, b) => a.name.localeCompare(b.name)),
      },
    ];
  }

  const bySection = new Map<string, FieldMeta[]>();
  const UNSECTIONED = "__unsectioned__";
  for (const f of fields) {
    const key = f.section ?? UNSECTIONED;
    let bucket = bySection.get(key);
    if (!bucket) {
      bucket = [];
      bySection.set(key, bucket);
    }
    bucket.push(f);
  }

  const sortedSections = Array.from(bySection.keys())
    .filter((k) => k !== UNSECTIONED)
    .sort((a, b) => a.localeCompare(b));
  if (bySection.has(UNSECTIONED)) sortedSections.push(UNSECTIONED);

  return sortedSections.map((key) => ({
    label: key === UNSECTIONED ? "Other" : key,
    fields: (bySection.get(key) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }));
}

function schemaProperties(
  schema: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  const props = schema?.["properties"];
  if (props && typeof props === "object") {
    return props as Record<string, Record<string, unknown>>;
  }
  return {};
}

function schemaRequired(schema: Record<string, unknown> | undefined): string[] {
  const req = schema?.["required"];
  if (Array.isArray(req)) return req.filter((x): x is string => typeof x === "string");
  return [];
}

function sampleValues(
  rows: Record<string, unknown>[],
  col: string,
  n: number,
): string[] {
  return rows
    .slice(0, n)
    .map((r) => formatSample(r[col]));
}

/**
 * Format a single cell for the sample-value preview. Date objects (from
 * XLSX cells parsed with cellDates: true) render as YYYY-MM-DD rather than
 * the verbose JS Date.toString() form — easier to scan a column and tell
 * what shape it is.
 */
function formatSample(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "—";
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function countMapped(overrides: Record<string, string | null>): number {
  return Object.values(overrides).filter((v) => v != null).length;
}

interface MismatchWarning {
  severity: "warn" | "info";
  title: string;
  body: string;
}

/**
 * Compare the classifier's verdict to the configured target schema and
 * produce a user-facing warning when they disagree, or when the
 * classifier had no idea what the file is.
 *
 * Logic:
 *   - No classification result yet (no registry configured, or classify
 *     skipped) → no warning.
 *   - Classification matches the target via a decisive heuristic → no warning.
 *   - Classification matches the target, but only via an AI tie-break or an
 *     unresolved heuristic tie (method !== "heuristic") → "not fully sure"
 *     (info). Without this branch, an `ambiguous_fallback` result that
 *     happens to land on the right entity is indistinguishable from a clean
 *     heuristic match — the caller sees nothing either way.
 *   - Classification picked something else with confidence ≥ 0.5 →
 *     "this looks like a Y, not X" (warn).
 *   - All scores low (< 0.25) → "couldn't identify this file" (info).
 *   - Confidence is in the middle but mismatched → "this might be a Y" (info).
 */
export function classificationMismatchMessage(
  classification: import("@eq/intake").ClassifyResult | undefined,
  targetEntity: string | undefined,
): MismatchWarning | null {
  if (!classification || !targetEntity) return null;

  if (classification.entity === targetEntity) {
    if (classification.method === "heuristic") return null;
    return {
      severity: "info",
      title: `Not fully sure, but this looks like ${withArticle(targetEntity)} file.`,
      body:
        classification.method === "ai"
          ? `The column names weren't a clear match on their own, so an AI pass was used to decide — it landed on '${targetEntity}' at ${Math.round(classification.confidence * 100)}% confidence. Worth checking the mapping below before continuing.`
          : `The column names didn't clearly point to one entity (top match '${targetEntity}' at ${Math.round(classification.confidence * 100)}%, no AI provider configured to break the tie). Worth checking the mapping below before continuing.`,
    };
  }

  if (classification.confidence >= 0.5) {
    return {
      severity: "warn",
      title: `This file looks like ${withArticle(classification.entity)} register, not ${targetEntity}.`,
      body: `The classifier matched ${Math.round(classification.confidence * 100)}% of the source columns to '${classification.entity}' aliases. Mapping it to '${targetEntity}' will probably leave most columns unmapped and reject most rows. Reconfigure with the '${classification.entity}' schema, or pick a different file.`,
    };
  }

  // Low overall confidence — file doesn't look like any known entity.
  const targetScore = classification.scores[targetEntity] ?? 0;
  if (classification.confidence < 0.25 && targetScore < 0.25) {
    return {
      severity: "info",
      title: `Couldn't tell what this file is.`,
      body: `None of the known canonical entities scored above 25% against the source columns. The closest match was '${classification.entity}' at ${Math.round(classification.confidence * 100)}%. You can still pick fields manually below, but expect most rows to be rejected if required fields aren't covered.`,
    };
  }

  return {
    severity: "info",
    title: `This file might be ${withArticle(classification.entity)}, not ${targetEntity}.`,
    body: `Top match was '${classification.entity}' at ${Math.round(classification.confidence * 100)}%, '${targetEntity}' scored ${Math.round(targetScore * 100)}%. Manual mapping below is fine — just a heads-up that the configured schema may not be the best fit.`,
  };
}

/** "asset" → "an asset", "staff" → "a staff", "incident" → "an incident". */
function withArticle(noun: string): string {
  const first = noun.charAt(0).toLowerCase();
  const isVowelSound = "aeiou".includes(first);
  return `${isVowelSound ? "an" : "a"} ${noun}`;
}
