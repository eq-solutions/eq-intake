/**
 * FreeformIntakeInput — a natural language textarea for describing data.
 *
 * Sits below the drop zone in Import mode, collapsed to a single link by
 * default. Not part of INTAKE-REDESIGN-SPEC.md's anatomy — it was added
 * after that spec was written, so it has no assigned place in the "one
 * screen" flow. Rather than either removing it or permanently occupying
 * space on the primary drop-a-file path, it stays reachable as a secondary
 * affordance: collapsed until clicked, matching the spec's "simple by
 * default, deeper only when needed" principle (§3.4).
 *
 * The user can type a free-text description of what they want to import
 * (e.g. "Add 5 new customers from Adelaide"). If an AI client is wired in
 * via the `ai` prop, the input is sent for processing; otherwise it shows a
 * "no AI configured" notice.
 *
 * Design rules: no inline styles, no hardcoded hex. CSS in styles.css under
 * the .eq-freeform namespace.
 */

import { useState, type JSX } from "react";

/** Minimal interface for an AI client. Any object with a `complete` method
 * that accepts a string prompt and returns a string response suffices. */
export interface AiClient {
  complete: (prompt: string) => Promise<string>;
}

/** Shared with the textarea placeholder so the collapsed-state example (below)
 * never drifts out of sync with it. */
const EXAMPLE_TEXT = "Add 5 new customers from Adelaide with site addresses";

export interface FreeformIntakeInputProps {
  /** Optional AI client. When absent the component renders in preview-only
   * mode with a notice explaining AI isn't configured. */
  ai?: AiClient | null;
  /** Placeholder text for the textarea. */
  placeholder?: string;
  /** Called when the AI returns a response. Host can use this to pre-fill
   * the drop zone with structured data derived from the prompt. */
  onResult?: (result: string) => void;
}

export function FreeformIntakeInput({
  ai,
  placeholder = `Describe what you'd like to import — e.g. "${EXAMPLE_TEXT}"`,
  onResult,
}: FreeformIntakeInputProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!ai || !text.trim()) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const response = await ai.complete(text.trim());
      setResult(response);
      onResult?.(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!expanded) {
    return (
      <>
        <button
          type="button"
          className="eq-freeform-intake__toggle"
          onClick={() => setExpanded(true)}
        >
          Or describe what you want to import
        </button>
        <p className="eq-freeform-intake__example">e.g. "{EXAMPLE_TEXT}"</p>
      </>
    );
  }

  return (
    <div className="eq-freeform-intake">
      <div className="eq-freeform">
        <textarea
          className="eq-freeform-intake__textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={3}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <button
          type="button"
          className="eq-intake-btn-primary"
          onClick={() => void handleSubmit()}
          disabled={!ai || busy || !text.trim()}
        >
          {busy ? "Processing…" : "Process"}
        </button>
      </div>

      {!ai && (
        <p className="eq-freeform-intake__notice">
          AI isn't configured — ask whoever set this up to connect an AI client
          to enable natural language input.
        </p>
      )}

      {error && (
        <div role="alert" className="eq-intake-alert">
          {error}
        </div>
      )}

      {result && (
        <div className="eq-freeform-intake__result">
          <p className="eq-freeform-intake__result-label">AI response</p>
          <pre className="eq-freeform-intake__result-body">{result}</pre>
        </div>
      )}
    </div>
  );
}
