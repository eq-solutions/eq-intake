/**
 * ConfirmFlow — orchestrates the screens based on store status.
 *
 * Renders the right child component for the current FlowStatus. Host app
 * supplies the dropzone (or any other entry) — once a file is parsed, this
 * component takes over and walks through mapping → flag review → commit.
 *
 * Every phase has a visible recovery path. Errors get a "Start over" button.
 * Complete gets a "Download committed batch" link. Long phases say what's
 * actually happening so a stalled mocked-AI doesn't look like a dead app.
 */

import type { JSX } from "react";
import type { UseBoundStore, StoreApi } from "zustand";
import type { FlowState } from "../types.js";
import { type FlowDriver, buildCommittedCsv } from "../store.js";
import { MappingTable } from "./MappingTable.js";
import { FlaggedRowsTable } from "./FlaggedRowsTable.js";
import { SheetPicker } from "./SheetPicker.js";

export interface ConfirmFlowProps {
  store: UseBoundStore<StoreApi<FlowState>>;
  driver: FlowDriver;
  /** Canonical fields available for mapping (derived from the target schema). */
  canonicalFields: string[];
  /**
   * Optional target schema. Passed through to MappingTable so the canonical-
   * field picker can group by `x-eq-section`, mark required fields, and show
   * field descriptions on hover.
   */
  schema?: Record<string, unknown>;
  /**
   * Optional callback for the non-blocking "Where is this going?" prompt
   * on the confirm_mapping screen. Host app uses it to log routes.
   */
  onDestinationChange?: (
    value: string | undefined,
    source: "suggested" | "free_text",
  ) => void;
}

export function ConfirmFlow(props: ConfirmFlowProps): JSX.Element {
  const status = props.store((s) => s.status);
  const parsedSheet = props.store((s) => s.parsedSheet);

  const startOver = () => {
    props.store.getState().reset();
  };

  switch (status.kind) {
    case "idle":
      // The dropzone above is the entry point — no need to repeat the prompt.
      return <></>;

    case "parsing":
      return <Spinner label="Reading your file…" />;

    case "confirm_sheet":
      return <SheetPicker store={props.store} driver={props.driver} />;

    case "classifying":
      return <Spinner label="Identifying what this is…" />;

    case "mapping":
      return <Spinner label="Matching columns…" />;

    case "confirm_mapping":
      return (
        <MappingTable
          store={props.store}
          canonicalFields={props.canonicalFields}
          schema={props.schema}
          onContinue={() => void props.driver.validate()}
          onDestinationChange={props.onDestinationChange}
        />
      );

    case "validating": {
      const rowCount = parsedSheet?.rows.length;
      const label =
        rowCount !== undefined
          ? `Checking ${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"} against the schema…`
          : "Checking every row…";
      const hint =
        rowCount !== undefined && rowCount > 5_000
          ? "Big file. The 10K-row budget is under 2s on most machines — give it a beat."
          : undefined;
      return <Spinner label={label} hint={hint} />;
    }

    case "confirm_rows":
      return (
        <FlaggedRowsTable
          store={props.store}
          onCommit={() => void props.driver.commit()}
        />
      );

    case "committing":
      return (
        <ProgressBar
          label={
            status.total === 0
              ? "Nothing left to commit — finishing up."
              : `Committing ${status.committed.toLocaleString()} of ${status.total.toLocaleString()} row${status.total === 1 ? "" : "s"}…`
          }
          ratio={status.total === 0 ? 1 : status.committed / status.total}
          hint="Saving into EQ on the server. Hold tight."
        />
      );

    case "complete": {
      return (
        <CompleteState
          committed={status.committed}
          flagged={status.flagged}
          rejected={status.rejected}
          onStartOver={startOver}
          onDownload={() => downloadCommitted(props.store.getState())}
        />
      );
    }

    case "error":
      return <ErrorState phase={status.phase} error={status.error} onStartOver={startOver} />;
  }
}

function Spinner({ label, hint }: { label: string; hint?: string }): JSX.Element {
  return (
    <div className="eq-spinner" aria-live="polite">
      <span className="eq-spinner__dot" />
      <div className="eq-spinner__text">
        <span>{label}</span>
        {hint ? <span className="eq-spinner__hint">{hint}</span> : null}
      </div>
    </div>
  );
}

function ProgressBar({
  label,
  ratio,
  hint,
}: {
  label: string;
  ratio: number;
  hint?: string;
}): JSX.Element {
  const pct = Math.round(ratio * 100);
  return (
    <div className="eq-progress" aria-live="polite">
      <p className="eq-progress__label">{label}</p>
      <div
        className="eq-progress__bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className="eq-progress__fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint ? <p className="eq-progress__hint">{hint}</p> : null}
    </div>
  );
}

function CompleteState({
  committed,
  flagged,
  rejected,
  onStartOver,
  onDownload,
}: {
  committed: number;
  flagged: number;
  rejected: number;
  onStartOver: () => void;
  onDownload: () => void;
}): JSX.Element {
  return (
    <div className="eq-confirm-complete" role="status">
      <h2>Done.</h2>
      <p>
        <strong>{committed.toLocaleString()}</strong> committed
        {flagged > 0 ? (
          <>
            {" · "}
            <strong>{flagged.toLocaleString()}</strong> committed-after-resolve
          </>
        ) : null}
        {rejected > 0 ? (
          <>
            {" · "}
            <strong>{rejected.toLocaleString()}</strong> skipped (need fixing at source)
          </>
        ) : null}
      </p>
      <div className="eq-confirm-complete__actions">
        <button
          type="button"
          className="eq-primary"
          onClick={onDownload}
          disabled={committed === 0}
        >
          Download committed rows (CSV)
        </button>
        <button type="button" onClick={onStartOver}>
          Drop another file
        </button>
      </div>
    </div>
  );
}

function ErrorState({
  phase,
  error,
  onStartOver,
}: {
  phase: string;
  error: string;
  onStartOver: () => void;
}): JSX.Element {
  return (
    <div className="eq-confirm-error" role="alert">
      <h2>Something went wrong during {phase}.</h2>
      <p className="eq-confirm-error__message">{error}</p>
      <p className="eq-confirm-error__hint">{hintForPhase(phase)}</p>
      <div className="eq-confirm-error__actions">
        <button type="button" className="eq-primary" onClick={onStartOver}>
          Start over
        </button>
      </div>
    </div>
  );
}

function hintForPhase(phase: string): string {
  switch (phase) {
    case "parsing":
      return "The reader couldn't make sense of this file. Check the format (CSV/XLSX/PDF/image) and that it isn't password-protected, then drop it again.";
    case "classifying":
      return "Couldn't work out what this file is. Try dropping it again, or skip classification by configuring the flow with a fixed schema.";
    case "mapping":
      return "The AI mapper threw before returning. If this is a real-Anthropic run, the most common causes are an expired API key, a quota limit, or a brief upstream blip — wait a moment and try again.";
    case "validating":
      return "The validator threw before producing a result. The file made it through parsing, so this is usually a schema mismatch — check EQ's field list against what's actually in the file.";
    case "committing":
      return "Saving into EQ failed. Nothing partial was written — start over once the back-end is healthy.";
    default:
      return "Try dropping the file again. If it keeps failing, check the source.";
  }
}

function downloadCommitted(state: FlowState): void {
  const built = buildCommittedCsv(state);
  if (!built) return;
  const blob = new Blob([built.content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = built.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
