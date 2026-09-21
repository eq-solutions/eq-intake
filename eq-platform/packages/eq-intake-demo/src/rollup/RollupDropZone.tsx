/**
 * RollupDropZone — multi-file drop → template-driven CSV export.
 *
 * Drop your bundle (e.g. SimPRO customer + contact + site CSVs), pick
 * a destination template (or upload a sample CSV from your destination
 * for a custom mapping), tune output options if needed, download.
 *
 * Built as a demo-specific component (not in @eq/confirm-ui) because the
 * shape is bundle-specific. The reusable confirm-ui flow is for single
 * files → canonical → commit. The bundle flow is multi-file → join →
 * export with a destination template.
 */

import {
  useState,
  useRef,
  useMemo,
  type DragEvent,
  type ChangeEvent,
  type JSX,
} from "react";
import { parseFile, classifySheet, type ParsedSheet } from "@eq/intake";
import {
  CUSTOMER_SCHEMA,
  CONTACT_SCHEMA,
  SITE_SCHEMA,
  STAFF_SCHEMA,
} from "../simpro-schemas.js";
import type { RoleName } from "./roles.js";
import {
  renderTemplate,
  renderToCsv,
  type DestinationTemplate,
  type TemplateRenderResult,
  type TemplateRenderOptions,
} from "./template.js";
import { BUILTIN_TEMPLATES, buildUserTemplate } from "./templates.js";

interface FileSlot {
  file: File;
  role: RoleName | "unknown";
  sheet?: ParsedSheet;
  confidence?: number;
  error?: string;
}

const ROLE_REGISTRY: Record<RoleName, Record<string, unknown>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  staff: STAFF_SCHEMA,
};

/** Canonical-field options offered for user-template column mapping. */
const USER_TEMPLATE_FIELD_OPTIONS = [
  "simPRO Customer ID",
  "Company Name",
  "Type",
  "First Name",
  "Last Name",
  "Title",
  "ABN",
  "ACN",
  "Street Address",
  "Suburb",
  "State",
  "Postcode",
  "Country",
  "Postal Address",
  "Postal Suburb",
  "Postal State",
  "Postal Postcode",
  "Postal Country",
  "Primary Phone",
  "Mobile Phone",
  "Alt. Phone",
  "Company Fax",
  "Email",
  "Website",
  "Customer Group",
  "Customer Profile",
  "Account Manager",
  "Default Quote Method",
  "Default Invoice Method",
  "Currency",
  "Notes",
  "Create Date",
];

export function RollupDropZone(): JSX.Element {
  const [slots, setSlots] = useState<FileSlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [templateId, setTemplateId] = useState<string>("simpro-customer-rollup");
  const [userTemplates, setUserTemplates] = useState<DestinationTemplate[]>([]);

  const [skipEmpty, setSkipEmpty] = useState(false);
  const [normaliseCase, setNormaliseCase] = useState(false);
  const [orphanStrategy, setOrphanStrategy] = useState<"drop" | "include-as-pseudo-customer">("include-as-pseudo-customer");
  const [customiseOpen, setCustomiseOpen] = useState(false);

  // Inputs for "user-supplied template" wizard
  const [userTemplateModalOpen, setUserTemplateModalOpen] = useState(false);

  const [result, setResult] = useState<TemplateRenderResult | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...userTemplates],
    [userTemplates],
  );
  const selectedTemplate = allTemplates.find((t) => t.id === templateId) ?? allTemplates[0];

  const reset = () => {
    setSlots([]);
    setResult(null);
    setError(null);
    setSkipEmpty(false);
    setNormaliseCase(false);
    setOrphanStrategy("include-as-pseudo-customer");
  };

  const ingestFiles = async (files: File[]) => {
    setError(null);
    setBusy(true);
    try {
      const next: FileSlot[] = [];
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        try {
          const parsed = await parseFile({ bytes, fileName: file.name });
          if (!parsed.sheets.length) {
            next.push({ file, role: "unknown", error: "Parser returned no sheets" });
            continue;
          }
          // One slot per sheet so multi-tab workbooks work end-to-end.
          for (let sheetIdx = 0; sheetIdx < parsed.sheets.length; sheetIdx++) {
            const sheet = parsed.sheets[sheetIdx]!;
            // Use sheetName if available, otherwise fall back to a 1-based index label.
            const sheetLabel =
              sheet.sheetName && sheet.sheetName.trim()
                ? `"${sheet.sheetName}"`
                : `Sheet ${sheetIdx + 1}`;
            try {
              const classification = await classifySheet({
                schemas: ROLE_REGISTRY,
                sheet,
              });
              const role =
                classification.entity === "customer" ||
                classification.entity === "contact" ||
                classification.entity === "site"
                  ? (classification.entity as RoleName)
                  : "unknown";
              next.push({
                file,
                role,
                sheet,
                confidence: classification.confidence,
              });
            } catch (sheetErr) {
              // One bad sheet doesn't block the rest — surface a named error slot.
              const reason =
                sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
              next.push({
                file,
                role: "unknown",
                error: `Could not read ${sheetLabel}: ${reason}`,
              });
            }
          }
        } catch (e) {
          next.push({
            file,
            role: "unknown",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      setSlots((prev) => [...prev, ...next]);
    } finally {
      setBusy(false);
    }
  };

  const buildRollup = () => {
    setError(null);
    setResult(null);
    if (!selectedTemplate) {
      setError("Pick a destination template before rolling up.");
      return;
    }
    const byRole: Partial<Record<RoleName, ParsedSheet>> = {};
    for (const slot of slots) {
      if (slot.role === "unknown" || !slot.sheet) continue;
      if (byRole[slot.role]) {
        setError(
          `Two files classified as ${slot.role}. Manually set the role on one before rolling up.`,
        );
        return;
      }
      byRole[slot.role] = slot.sheet;
    }
    const missing = selectedTemplate.requiredRoles.filter((r) => !byRole[r]);
    if (missing.length > 0) {
      setError(
        `Template "${selectedTemplate.name}" needs ${missing.join(" + ")} but none of the dropped files matched. Drop the missing file(s) or change the template.`,
      );
      return;
    }
    const opts: TemplateRenderOptions = {
      skipEmpty,
      normaliseCase,
      orphanStrategy,
    };
    const r = renderTemplate(selectedTemplate, byRole, opts);
    setResult(r);
  };

  const downloadCsv = () => {
    if (!result) return;
    const csv = renderToCsv(result);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.template.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void ingestFiles(files);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void ingestFiles(files);
    e.target.value = "";
  };

  const setSlotRole = (idx: number, role: RoleName | "unknown") => {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, role } : s)));
  };

  const removeSlot = (idx: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  const onUserTemplateBuilt = (template: DestinationTemplate) => {
    setUserTemplates((prev) => [...prev, template]);
    setTemplateId(template.id);
    setUserTemplateModalOpen(false);
  };

  const hasAnyData = slots.some((s) => s.sheet);

  // Decide which customer-row-derived signals to surface inline.
  const allCustomerRows = slots.find((s) => s.role === "customer")?.sheet?.rows ?? [];
  const allCapsCount = allCustomerRows.filter((r) => {
    const v = typeof r["Company Name"] === "string" ? r["Company Name"] : "";
    const letters = v.replace(/[^A-Za-z]/g, "");
    return letters.length > 1 && letters === letters.toUpperCase();
  }).length;

  return (
    <div className="eq-rollup">
      <header className="eq-rollup__header">
        <h2>Bundle → destination paste</h2>
        <p>
          Drop your source files (e.g. SimPRO customers, contacts, sites). Pick
          a destination template — pre-built routes for Xero / MYOB / Outlook /
          SharePoint, or upload a sample CSV from your target list for a custom
          mapping. Output downloads as a CSV ready to paste / import.
        </p>
      </header>

      <div
        className={
          "eq-rollup__dropzone" +
          (dragOver ? " eq-rollup__dropzone--over" : "")
        }
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Drop one or more source CSVs"
      >
        <p className="eq-rollup__dropzone-title">
          {slots.length === 0
            ? "Drop your source CSVs here"
            : "Drop more files or click to add"}
        </p>
        <p className="eq-rollup__dropzone-hint">
          customer · contact · site — order doesn't matter
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.tsv,.xlsx,.xls,.xlsm"
          onChange={onInputChange}
          style={{ display: "none" }}
        />
      </div>

      {busy ? (
        <div className="eq-spinner" style={{ padding: "12px 0", border: "none", background: "transparent" }}>
          <span className="eq-spinner__dot" />
          <span className="eq-spinner__text">
            <span>Classifying files…</span>
            <span className="eq-spinner__hint">This uses AI — usually takes a few seconds per file.</span>
          </span>
        </div>
      ) : null}

      {slots.length > 0 ? (
        <table className="eq-rollup__slots">
          <thead>
            <tr>
              <th>File</th>
              <th>Detected role</th>
              <th>Rows</th>
              <th>Confidence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {slots.map((s, i) => (
              <tr key={i}>
                <td>
                  <strong>{s.file.name}</strong>
                </td>
                <td>
                  <select
                    value={s.role}
                    onChange={(e) => setSlotRole(i, e.target.value as RoleName)}
                    disabled={!s.sheet}
                  >
                    <option value="unknown">— pick role —</option>
                    <option value="customer">customer</option>
                    <option value="contact">contact</option>
                    <option value="site">site</option>
                  </select>
                </td>
                <td>{s.sheet ? s.sheet.rows.length : "—"}</td>
                <td>
                  {s.confidence != null ? `${Math.round(s.confidence * 100)}%` : "—"}
                  {s.confidence != null && s.confidence < 0.7 && s.role !== "unknown" && (
                    <span className="eq-rollup__confidence-warn">
                      Low — check the role
                    </span>
                  )}
                </td>
                <td>
                  <button type="button" onClick={() => removeSlot(i)} aria-label="Remove file">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {slots.some((s) => s.error) ? (
              <tr>
                <td colSpan={5} className="eq-rollup__row-error">
                  Errors during parse: {slots.filter((s) => s.error).map((s) => `${s.file.name}: ${s.error}`).join(" · ")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}

      {hasAnyData ? (
        <div className="eq-rollup__template-row">
          <label htmlFor="dest-template">
            <strong>Send to:</strong>
          </label>
          <select
            id="dest-template"
            value={templateId}
            onChange={(e) => {
              if (e.target.value === "__user__") {
                setUserTemplateModalOpen(true);
                return;
              }
              setTemplateId(e.target.value);
            }}
          >
            {BUILTIN_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {userTemplates.length > 0 ? (
              <optgroup label="Your custom templates">
                {userTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value="__user__">+ Upload a destination template…</option>
          </select>
          {selectedTemplate?.description ? (
            <span className="eq-rollup__template-desc">{selectedTemplate.description}</span>
          ) : null}
        </div>
      ) : null}

      {hasAnyData ? (
        <div className="eq-rollup__orphan-warning">
          <span className="eq-rollup__orphan-label">
            Orphan sites/contacts
          </span>
          <span className="eq-rollup__orphan-desc">
            Sites or contacts whose Customer ID doesn't match anything in the customers file.
          </span>
          <select
            value={orphanStrategy}
            onChange={(e) =>
              setOrphanStrategy(e.target.value as "drop" | "include-as-pseudo-customer")
            }
            className="eq-rollup__orphan-select"
          >
            <option value="include-as-pseudo-customer">
              Include as pseudo-customer rows (recommended)
            </option>
            <option value="drop">Drop them — lose those rows</option>
          </select>
        </div>
      ) : null}

      {hasAnyData ? (
        <details
          className="eq-rollup__customise"
          open={customiseOpen}
          onToggle={(e) => setCustomiseOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>More options</summary>
          <div className="eq-rollup__customise-body">
            <label>
              <input
                type="checkbox"
                checked={skipEmpty}
                onChange={(e) => setSkipEmpty(e.target.checked)}
              />
              Skip customers with no sites and no contacts
            </label>
            {allCapsCount > 0 ? (
              <label>
                <input
                  type="checkbox"
                  checked={normaliseCase}
                  onChange={(e) => setNormaliseCase(e.target.checked)}
                />
                Normalise ALL-CAPS company names + emails to standard case (
                {allCapsCount} rows look ALL-CAPS in this bundle)
              </label>
            ) : null}
          </div>
        </details>
      ) : null}

      {slots.length > 0 ? (
        <div className="eq-rollup__actions">
          <button
            type="button"
            className="eq-primary"
            onClick={buildRollup}
            disabled={!hasAnyData || busy}
          >
            Roll up
          </button>
          <button type="button" onClick={reset} disabled={busy}>
            Start over
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="eq-rollup__error" role="alert">
          {error}
        </div>
      ) : null}

      {result ? <RollupPreview result={result} onDownload={downloadCsv} /> : null}

      {userTemplateModalOpen ? (
        <UserTemplateWizard
          fieldOptions={USER_TEMPLATE_FIELD_OPTIONS}
          onCancel={() => setUserTemplateModalOpen(false)}
          onBuilt={onUserTemplateBuilt}
        />
      ) : null}
    </div>
  );
}

function RollupPreview({
  result,
  onDownload,
}: {
  result: TemplateRenderResult;
  onDownload: () => void;
}): JSX.Element {
  const preview = result.rows.slice(0, 10);
  return (
    <div className="eq-rollup__preview">
      <header className="eq-rollup__preview-header">
        <h3>
          Preview · {result.rows.length.toLocaleString()} row
          {result.rows.length === 1 ? "" : "s"} → {result.template.destinationLabel ?? "CSV"}
        </h3>
        <button type="button" className="eq-primary" onClick={onDownload}>
          Download CSV
        </button>
      </header>
      <ul className="eq-rollup__stats">
        <li>{result.stats.customers.toLocaleString()} customers in source</li>
        {result.template.requiredRoles.includes("site") ? (
          <li>{result.stats.customersWithSite.toLocaleString()} have at least one site</li>
        ) : null}
        {result.template.requiredRoles.includes("contact") ? (
          <li>{result.stats.customersWithContact.toLocaleString()} have at least one contact</li>
        ) : null}
        {result.stats.customersSkippedEmpty > 0 ? (
          <li>
            {result.stats.customersSkippedEmpty.toLocaleString()} skipped (no sites or contacts)
          </li>
        ) : null}
        {result.stats.orphanSites > 0 ? (
          <li className="eq-rollup__stats-warn">
            {result.stats.orphanSites.toLocaleString()} orphan sites (customer ID not in customers file)
          </li>
        ) : null}
        {result.stats.orphanContacts > 0 ? (
          <li className="eq-rollup__stats-warn">
            {result.stats.orphanContacts.toLocaleString()} orphan contacts
          </li>
        ) : null}
      </ul>
      <div className="eq-rollup__preview-table-wrap">
        <table className="eq-rollup__preview-table">
          <thead>
            <tr>
              {result.headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, i) => (
              <tr key={i}>
                {result.headers.map((h) => (
                  <td key={h}>
                    <span title={row[h] ?? ""}>{truncate(row[h] ?? "", 80)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length > preview.length ? (
          <p className="eq-rollup__preview-more">
            … and {(result.rows.length - preview.length).toLocaleString()} more rows in the download.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ============================================================================
// User-template wizard
// ============================================================================

function UserTemplateWizard({
  fieldOptions,
  onCancel,
  onBuilt,
}: {
  fieldOptions: string[];
  onCancel: () => void;
  onBuilt: (t: DestinationTemplate) => void;
}): JSX.Element {
  const [templateName, setTemplateName] = useState("");
  const [destLabel, setDestLabel] = useState("");
  const [columnHeaders, setColumnHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [pasteInput, setPasteInput] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const parsed = await parseFile({ bytes, fileName: file.name });
    const sheet = parsed.sheets[0];
    if (sheet) {
      setColumnHeaders(sheet.headerRow);
      seedMapping(sheet.headerRow);
      if (!templateName) setTemplateName(file.name.replace(/\.[^.]+$/, ""));
    }
    e.target.value = "";
  };

  const seedMapping = (headers: string[]) => {
    const m: Record<string, string | null> = {};
    for (const h of headers) {
      m[h] = guessCanonical(h, fieldOptions);
    }
    setMapping(m);
  };

  const applyPaste = () => {
    const headers = pasteInput
      .split(/[,\n\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (headers.length === 0) return;
    setColumnHeaders(headers);
    seedMapping(headers);
    setPasteInput("");
  };

  const build = () => {
    const id = `user-${Date.now()}`;
    const template = buildUserTemplate({
      id,
      name: templateName || "Custom template",
      destinationLabel: destLabel || undefined,
      columnNames: columnHeaders,
      canonicalFieldMap: mapping,
    });
    onBuilt(template);
  };

  return (
    <div className="eq-rollup__modal" role="dialog" aria-labelledby="user-tpl-title">
      <div className="eq-rollup__modal-body">
        <header className="eq-rollup__modal-header">
          <h3 id="user-tpl-title">Upload a destination template</h3>
          <button type="button" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="eq-rollup__modal-hint">
          Drop a sample CSV from your destination list (one row is enough — we
          only read the headers), or paste the column names comma-separated.
          Each target column gets mapped to a canonical source field.
        </p>

        <div className="eq-rollup__modal-input">
          <label>
            <strong>Template name:</strong>
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g. Cowork quoting project"
            />
          </label>
          <label>
            <strong>Destination label:</strong>
            <input
              type="text"
              value={destLabel}
              onChange={(e) => setDestLabel(e.target.value)}
              placeholder="e.g. SharePoint"
            />
          </label>
        </div>

        <div className="eq-rollup__modal-source">
          <button type="button" onClick={() => fileRef.current?.click()}>
            Upload sample CSV from destination
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv"
            onChange={onFileChange}
            style={{ display: "none" }}
          />
          <span className="eq-rollup__modal-or">or</span>
          <input
            type="text"
            value={pasteInput}
            onChange={(e) => setPasteInput(e.target.value)}
            placeholder="Paste comma-separated column names"
          />
          <button type="button" onClick={applyPaste} disabled={!pasteInput.trim()}>
            Use these
          </button>
        </div>

        {columnHeaders.length > 0 ? (
          <>
            <p className="eq-rollup__modal-hint">
              <strong>{columnHeaders.length} columns detected.</strong> Map each
              to a canonical field — leave on "— don't map —" for columns you'd
              fill in manually after pasting.
            </p>
            <table className="eq-rollup__modal-table">
              <thead>
                <tr>
                  <th>Target column</th>
                  <th>Map from canonical field</th>
                </tr>
              </thead>
              <tbody>
                {columnHeaders.map((h) => (
                  <tr key={h}>
                    <td>
                      <strong>{h}</strong>
                    </td>
                    <td>
                      <select
                        value={mapping[h] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [h]: e.target.value === "" ? null : e.target.value,
                          }))
                        }
                      >
                        <option value="">— don't map —</option>
                        {fieldOptions.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <footer className="eq-rollup__modal-footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="eq-primary"
            onClick={build}
            disabled={columnHeaders.length === 0 || !templateName.trim()}
          >
            Use this template
          </button>
        </footer>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function guessCanonical(targetCol: string, options: string[]): string | null {
  // Heuristic: normalised exact match, then alias-style partial match.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const target = norm(targetCol);
  // Exact match first
  for (const o of options) {
    if (norm(o) === target) return o;
  }
  // Contains
  for (const o of options) {
    if (target.includes(norm(o)) || norm(o).includes(target)) return o;
  }
  // Hardcoded aliases for common SharePoint column names
  const aliases: Record<string, string> = {
    accountnumber: "simPRO Customer ID",
    accountno: "simPRO Customer ID",
    title: "Company Name",
    customer: "Company Name",
    contactname: "Company Name",
    phone: "Primary Phone",
    address: "Street Address",
    city: "Suburb",
    postcode: "Postcode",
  };
  if (aliases[target]) return aliases[target]!;
  return null;
}
