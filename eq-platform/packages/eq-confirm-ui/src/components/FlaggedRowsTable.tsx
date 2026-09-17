/**
 * FlaggedRowsTable — confirm-rows screen.
 *
 * Lists every flagged row with its flag(s) and the available resolutions.
 * Bulk "apply to all similar flags" is also wired here.
 */

import { useState, type JSX } from "react";
import type { UseBoundStore, StoreApi } from "zustand";
import type { Flag, ValidationError } from "@eq/validation";
import type { FlowState, FlagResolution } from "../types.js";

type RejectedRow = { source_row_index: number; errors: ValidationError[] };

export interface FlaggedRowsTableProps {
  store: UseBoundStore<StoreApi<FlowState>>;
  onBack?: () => void;
  onCommit?: () => void;
}

export function FlaggedRowsTable(props: FlaggedRowsTableProps): JSX.Element {
  const result = props.store((s) => s.validationResult);
  const resolutions = props.store((s) => s.resolutions);
  const resolveFlag = props.store((s) => s.resolveFlag);
  const resolveBulk = props.store((s) => s.resolveBulk);

  if (!result) {
    return <div className="eq-confirm-empty">No validation result yet.</div>;
  }

  const valid = result.summary.valid;
  const flagged = result.summary.flagged;
  const rejected = result.summary.rejected;

  return (
    <div className="eq-confirm-rows">
      <header className="eq-confirm-rows__header">
        <h2>Review rows before commit</h2>
        <div className="eq-confirm-rows__tabs">
          <span className="eq-tab eq-tab--ok">{valid} valid</span>
          <span className="eq-tab eq-tab--warn">{flagged} flagged</span>
          <span className="eq-tab eq-tab--err">{rejected} rejected</span>
        </div>
      </header>

      {flagged > 0 && (
        <section className="eq-confirm-rows__flagged">
          <h3>Flagged rows</h3>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Row preview</th>
                <th>Issue</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {result.flagged_rows.map((row) => (
                <tr key={row.source_row_index}>
                  <td>{row.source_row_index + 1}</td>
                  <td>
                    <code>{previewRow(row.canonical)}</code>
                  </td>
                  <td>
                    <ul className="eq-flag-list">
                      {row.flags.map((f, i) => (
                        <li key={i}>{flagSummary(f)}</li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <ResolutionPicker
                      flags={row.flags}
                      current={resolutions[row.source_row_index]}
                      onChange={(r) => resolveFlag(row.source_row_index, r)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <BulkActions
            flagged={result.flagged_rows}
            onBulk={resolveBulk}
          />
        </section>
      )}

      {rejected > 0 && (
        <RejectedSection rows={result.rejected_rows} />
      )}

      <footer className="eq-confirm-rows__footer">
        {props.onBack && (
          <button type="button" onClick={props.onBack}>
            Back
          </button>
        )}
        {props.onCommit && (
          <button type="button" onClick={props.onCommit} className="eq-primary">
            Commit {valid + flagged - countSkipped(resolutions)} rows
          </button>
        )}
      </footer>
    </div>
  );
}

// ============================================================================
// HELPERS
// ============================================================================

function previewRow(canonical: Record<string, unknown>): string {
  const entries = Object.entries(canonical).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${truncate(String(v ?? "—"), 20)}`).join(" · ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function flagSummary(f: Flag): string {
  switch (f.kind) {
    case "fk_fuzzy_match":
      return `Foreign-key fuzzy match on '${f.field}' — ${f.candidates.length} candidate(s)`;
    case "date_ambiguous":
      return `Ambiguous date on '${f.field}'`;
    case "sensitive_field":
      return `Sensitive field '${f.field}' (will be masked for non-admins)`;
    case "value_unusual":
      return `Unusual value on '${f.field}': ${f.reason}`;
    case "cross_field_warning":
      return `Cross-field warning: ${f.message}`;
    case "phone_kept_raw":
      return `Phone on '${f.field}' could not be normalised — kept raw`;
    case "multi_value_candidate":
      return `Looks like ${f.values.length} values in '${f.field}': ${f.values.join(", ")}`;
    case "ai_enrichment":
      return `AI suggestion for '${f.field}' (${Math.round(f.confidence * 100)}% confidence)`;
    case "duplicate":
      return f.matchType === "existing"
        ? `Likely duplicate of an existing asset (${f.reason})`
        : `Likely duplicate within this batch (${f.reason})`;
  }
}

function errorSummary(e: import("@eq/validation").ValidationError): string {
  switch (e.kind) {
    case "field_required":
      return `Missing required field: ${e.field}`;
    case "field_type_mismatch":
      return `Type mismatch on ${e.field}: expected ${e.expected}`;
    case "field_format_invalid":
      return `Invalid format on ${e.field}: ${e.format}`;
    case "field_enum_invalid":
      return `Invalid enum on ${e.field}: '${String(e.value)}'`;
    case "field_pattern_mismatch":
      return `Pattern mismatch on ${e.field}`;
    case "field_out_of_range":
      return `${e.field} out of range`;
    case "field_length_invalid":
      return `${e.field} wrong length`;
    case "cross_field_error":
      return `Cross-field: ${e.message}`;
    case "fk_no_match":
      return `Foreign-key match failed on ${e.field}: '${String(e.value)}'`;
    case "date_ambiguous_strict":
      return `Ambiguous date on ${e.field} (strict mode)`;
    case "coerce_failed":
      return `Coercion failed on ${e.field}: ${e.reason}`;
    case "cap_exceeded":
      return `Cap exceeded on ${e.field}: ${e.reason}`;
    default:
      // Exhaustive above; cast guards against new ValidationError kinds added
      // in @eq/validation so this always returns a string.
      return `Validation issue: ${(e as { kind?: string }).kind ?? "unknown"}`;
  }
}

function countSkipped(resolutions: Record<number, FlagResolution>): number {
  return Object.values(resolutions).filter((r) => r.kind === "skip_row").length;
}

interface RejectedGroup {
  fingerprint: string;
  /** Human-readable error labels in the order they appear in the row. */
  errorLabels: string[];
  rows: RejectedRow[];
}

/**
 * Group rejected rows by their error fingerprint so a thousand rows
 * missing the same three required fields collapse to one card with a
 * "1000 rows" count, not a thousand identical lines.
 *
 * Fingerprint is the sorted error kinds+fields concatenated. Same-kind
 * errors on different fields don't collapse; same-fields-different-rows
 * do.
 */
export function groupRejectedRows(rows: RejectedRow[]): RejectedGroup[] {
  const map = new Map<string, RejectedGroup>();
  for (const row of rows) {
    const labels = row.errors.map(errorSummary);
    // Stable fingerprint: sorted labels, joined.
    const fingerprint = [...labels].sort().join(" | ");
    let group = map.get(fingerprint);
    if (!group) {
      group = { fingerprint, errorLabels: labels, rows: [] };
      map.set(fingerprint, group);
    }
    group.rows.push(row);
  }
  // Most-common groups first.
  return Array.from(map.values()).sort((a, b) => b.rows.length - a.rows.length);
}

function RejectedSection({ rows }: { rows: RejectedRow[] }): JSX.Element {
  const groups = groupRejectedRows(rows);
  return (
    <section className="eq-confirm-rows__rejected">
      <h3>Rejected rows</h3>
      <p>
        These rows cannot be imported as-is. Fix at the source and re-upload, or skip them
        to commit only the valid + resolved-flagged rows.
      </p>
      <ul className="eq-rejected-groups">
        {groups.map((group, i) => (
          <RejectedGroupCard key={i} group={group} />
        ))}
      </ul>
    </section>
  );
}

function RejectedGroupCard({ group }: { group: RejectedGroup }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const rowCount = group.rows.length;
  const previewIndexes = group.rows.slice(0, 10).map((r) => r.source_row_index + 1);
  const remaining = rowCount - previewIndexes.length;

  return (
    <li className="eq-rejected-group">
      <div className="eq-rejected-group__header">
        <span className="eq-rejected-group__count">
          <strong>{rowCount.toLocaleString()}</strong> row{rowCount === 1 ? "" : "s"}
        </span>
        <ul className="eq-rejected-group__errors">
          {group.errorLabels.map((label, i) => (
            <li key={i}>{label}</li>
          ))}
        </ul>
      </div>
      <div className="eq-rejected-group__rows">
        Source rows:{" "}
        {previewIndexes.join(", ")}
        {remaining > 0 ? <> … and {remaining.toLocaleString()} more</> : null}
        {rowCount > 1 ? (
          <>
            {" · "}
            <button
              type="button"
              className="eq-link-button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? "Hide full list" : "Show full list"}
            </button>
          </>
        ) : null}
      </div>
      {expanded ? (
        <details open className="eq-rejected-group__full">
          <summary>All {rowCount.toLocaleString()} row indexes</summary>
          <code>
            {group.rows.map((r) => r.source_row_index + 1).join(", ")}
          </code>
        </details>
      ) : null}
    </li>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function ResolutionPicker(props: {
  flags: Flag[];
  current: FlagResolution | undefined;
  onChange: (r: FlagResolution) => void;
}): JSX.Element {
  const fuzzy = props.flags.find((f) => f.kind === "fk_fuzzy_match");
  const dateAmbig = props.flags.find((f) => f.kind === "date_ambiguous");

  if (fuzzy && fuzzy.kind === "fk_fuzzy_match") {
    return (
      <div className="eq-resolution">
        {(fuzzy.candidates as Array<{ id: string; score: number; matched_value: string }>).map(
          (c) => (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                props.onChange({
                  kind: "pick_candidate",
                  flagKind: "fk_fuzzy_match",
                  chosen: c.id,
                })
              }
            >
              {c.matched_value} ({Math.round(c.score * 100)}%)
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => props.onChange({ kind: "skip_row" })}
        >
          Skip
        </button>
      </div>
    );
  }

  if (dateAmbig && dateAmbig.kind === "date_ambiguous") {
    return (
      <div className="eq-resolution">
        {dateAmbig.candidates.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() =>
              props.onChange({
                kind: "pick_candidate",
                flagKind: "date_ambiguous",
                chosen: c,
              })
            }
          >
            {c}
          </button>
        ))}
        <button
          type="button"
          onClick={() => props.onChange({ kind: "skip_row" })}
        >
          Skip
        </button>
      </div>
    );
  }

  const multiValue = props.flags.find((f) => f.kind === "multi_value_candidate");
  if (multiValue && multiValue.kind === "multi_value_candidate") {
    return (
      <div className="eq-resolution">
        <button
          type="button"
          onClick={() =>
            props.onChange({
              kind: "split_row",
              field: multiValue.field,
              values: multiValue.values,
            })
          }
          aria-pressed={props.current?.kind === "split_row"}
        >
          Split into {multiValue.values.length} rows ({multiValue.values.join(" / ")})
        </button>
        <button
          type="button"
          onClick={() => props.onChange({ kind: "accept_canonical" })}
          aria-pressed={props.current?.kind === "accept_canonical"}
        >
          Keep as one
        </button>
        <button
          type="button"
          onClick={() => props.onChange({ kind: "skip_row" })}
          aria-pressed={props.current?.kind === "skip_row"}
        >
          Skip
        </button>
      </div>
    );
  }

  // Default: accept or skip
  return (
    <div className="eq-resolution">
      <button
        type="button"
        onClick={() => props.onChange({ kind: "accept_canonical" })}
        aria-pressed={props.current?.kind === "accept_canonical"}
      >
        Accept
      </button>
      <button
        type="button"
        onClick={() => props.onChange({ kind: "skip_row" })}
        aria-pressed={props.current?.kind === "skip_row"}
      >
        Skip
      </button>
    </div>
  );
}

function BulkActions(props: {
  flagged: import("@eq/validation").FlaggedRow[];
  onBulk: (kind: Flag["kind"], r: FlagResolution) => void;
}): JSX.Element | null {
  const kinds = new Set<Flag["kind"]>();
  for (const row of props.flagged) {
    for (const f of row.flags) kinds.add(f.kind);
  }
  if (kinds.size === 0) return null;

  return (
    <div className="eq-bulk-actions">
      <span>Bulk apply:</span>
      {Array.from(kinds).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => props.onBulk(k, { kind: "accept_canonical" })}
        >
          Accept all '{k}'
        </button>
      ))}
    </div>
  );
}
