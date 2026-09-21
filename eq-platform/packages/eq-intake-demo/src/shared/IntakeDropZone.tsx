/**
 * IntakeDropZone — the ONE drop zone for the consolidated Intake screen.
 *
 * Drop (or click to pick) any SimPRO export. Each sheet is parsed +
 * classified by the shared useIntakeBundle hook; this component just renders
 * the zone and the list of what landed ("looks like customers — 92% sure").
 * The destination is chosen separately, below, so the same dropped files can
 * go Into EQ or out to Xero/MYOB/etc. without re-dropping.
 */

import { useRef, useState, type DragEvent, type JSX } from "react";
import type { IntakeBundle, FileSlot } from "./intake-bundle.js";
import { DetectionLine } from "./DetectionLine.js";
import type { RoleName } from "../rollup/roles.js";

// ---------------------------------------------------------------------------
// Upload icon (inline SVG — no external icon dep needed here)
// ---------------------------------------------------------------------------
function UploadIcon({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--eq-deep)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export interface IntakeDropZoneProps {
  bundle: IntakeBundle;
  /** Offers a "Check for conflicts" action per classified slot when provided. */
  onCheckConflicts?: (slot: FileSlot, index: number) => void;
}

export function IntakeDropZone({ bundle, onCheckConflicts }: IntakeDropZoneProps): JSX.Element {
  const { slots, busy, ingestFiles, removeSlot, setSlotRole } = bundle;
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void ingestFiles(files);
  };

  const hasFiles = slots.length > 0;

  // Build drop zone class
  const zoneClass = [
    "eq-intake-dropzone",
    dragOver ? "eq-intake-dropzone--over" : "",
    hasFiles ? "eq-intake-dropzone--compact" : "",
  ].filter(Boolean).join(" ");

  return (
    <div>
      {/* Drop target */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop a file or click to pick"
        className={zoneClass}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
      >
        {busy && slots.length === 0 ? (
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--eq-deep)", fontSize: 14 }}>
            <span className="eq-spinner__dot" />
            Reading file…
          </span>
        ) : hasFiles ? (
          <>
            <UploadIcon size={16} />
            <span>Drop another file, or click to pick</span>
          </>
        ) : (
          <>
            <div className="eq-intake-dropzone__icon">
              <UploadIcon size={26} />
            </div>
            <p className="eq-intake-dropzone__title">
              Drop a file here, or <span className="eq-intake-dropzone__pick">click to pick</span>
            </p>
            {/* PDF is genuinely wired end-to-end today (readers/pdf.ts, no AI needed for
                born-digital PDFs). Photos aren't listed here yet — that path needs an
                AIProvider this module doesn't have wired in, and promising it in the
                copy before it works would be exactly the over-promise the redesign
                spec's voice rule warns against. */}
            <p className="eq-intake-dropzone__hint">CSV, Excel, or PDF · We work out what it is</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) void ingestFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      {/* File slot cards */}
      {slots.length > 0 && (
        <>
          <ul className="eq-intake-slots" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {slots.map((slot, i) => {
              const isUnknown = slot.role === "unknown";

              const slotClass = [
                "eq-intake-slot",
                isUnknown || slot.error ? "eq-intake-slot--err" : "",
              ].filter(Boolean).join(" ");

              return (
                <li key={i} className={slotClass}>
                  <div className="eq-intake-slot__info">
                    <div className="eq-intake-slot__row">
                      <span className="eq-intake-slot__name" title={slot.file.name}>
                        📄 {slot.file.name}
                      </span>
                      {slot.sheet?.sheetName &&
                        slot.sheet.sheetName !== "Sheet1" &&
                        slot.sheet.sheetName !== slot.file.name && (
                          <span
                            className="eq-intake-slot__sheet"
                            title="The sheet/tab name inside this file — not what we think it is"
                          >
                            sheet: {slot.sheet.sheetName}
                          </span>
                        )}
                    </div>

                    {slot.error && (
                      <div className="eq-intake-slot__error">{slot.error}</div>
                    )}
                    {isUnknown && !slot.error && (
                      <div className="eq-intake-slot__error">
                        Couldn't classify this file — check the column headers.
                      </div>
                    )}
                    {!isUnknown && !slot.error && (
                      <DetectionLine slot={slot} onPick={(role: RoleName) => setSlotRole(i, role)} />
                    )}
                  </div>

                  {/* Check against what's already there — only meaningful once
                      the sheet classified cleanly */}
                  {onCheckConflicts && slot.sheet && slot.role !== "unknown" && !slot.error && (
                    <button
                      type="button"
                      className="eq-intake-btn-ghost eq-intake-slot__check"
                      onClick={() => onCheckConflicts(slot, i)}
                      disabled={busy}
                    >
                      Check for conflicts
                    </button>
                  )}

                  {/* Remove */}
                  <button
                    type="button"
                    className="eq-intake-slot__remove"
                    onClick={() => removeSlot(i)}
                    disabled={busy}
                    aria-label={`Remove ${slot.file.name}`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          {slots.length > 1 && (
            <p className="eq-intake-slots__hint">order doesn't matter</p>
          )}
        </>
      )}
    </div>
  );
}
