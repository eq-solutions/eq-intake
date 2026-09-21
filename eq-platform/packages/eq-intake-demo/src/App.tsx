/**
 * EQ Intake — demo App.
 *
 * Drops <ParserDropZone> into a real browser. Drag a CSV/XLSX in, watch it
 * flow through parse → map → validate → commit.
 *
 * No real Anthropic call (uses MockAi by default). No real Supabase commit
 * (logs to the commit panel). Schema is hard-coded to a permissive staff
 * shape so the demo runs offline.
 */

import { useEffect, useMemo, useState } from "react";
import { ParserDropZone } from "@eq/confirm-ui";
import type { CommitFn, CommittableRow } from "@eq/confirm-ui";
import { pickAi } from "./ai-picker.js";
import { CUSTOMER_SCHEMA, CONTACT_SCHEMA, SITE_SCHEMA } from "./simpro-schemas.js";
import { RollupDropZone } from "./rollup/RollupDropZone.js";
import { IntakeModule } from "./module/IntakeModule.js";
import { ReconcileModule } from "./module/ReconcileModule.js";
import { createMockSupabase } from "./mock-supabase.js";

type Mode = "single" | "bundle" | "intake" | "reconcile";

const STAFF_SCHEMA = {
  $id: "https://schemas.eq.solutions/demo/staff.json",
  title: "Staff (demo)",
  "x-eq-entity": "staff",
  type: "object",
  required: ["first_name", "last_name", "employment_type", "active"],
  properties: {
    first_name: {
      type: "string",
      description: "Given name. Required.",
      maxLength: 80,
      "x-eq-source-aliases": ["first", "given_name", "fname", "firstname"],
    },
    last_name: {
      type: "string",
      description: "Family name. Required.",
      maxLength: 80,
      "x-eq-source-aliases": ["last", "surname", "lname", "family_name"],
    },
    email: {
      type: ["string", "null"],
      format: "email",
      description: "Primary email. Used for invitations and notifications.",
      "x-eq-source-aliases": ["email_address", "mail"],
    },
    phone: {
      type: ["string", "null"],
      description: "Primary mobile. Stored as E.164 where possible (e.g. +61412345678).",
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["mobile", "cell", "ph", "phone_number"],
    },
    employment_type: {
      type: "string",
      enum: ["employee", "subcontractor", "labour_hire", "casual", "apprentice"],
      description: "Engagement type. Drives leave, charge-out, and compliance handling.",
      "x-eq-source-aliases": ["type", "engagement", "employment"],
      "x-eq-enum-aliases": {
        employee: ["full-time", "ft", "permanent"],
        subcontractor: ["sub", "subbie", "contractor"],
        labour_hire: ["agency", "labour-hire"],
        casual: ["pt", "part-time"],
        apprentice: ["appy", "trainee"],
      },
    },
    trade: {
      type: ["string", "null"],
      description: "Primary trade discipline. Free text; sparkie / mech / fire / hydraulic / civil etc.",
      "x-eq-source-aliases": ["discipline", "skill"],
    },
    start_date: {
      type: ["string", "null"],
      format: "date",
      description: "Date the person started with the business. ISO 8601 (YYYY-MM-DD).",
      "x-eq-coerce": "date",
      "x-eq-source-aliases": ["hire_date", "started", "commenced"],
    },
    active: {
      type: "boolean",
      default: true,
      description: "Whether this person is currently active. Defaults true on import.",
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": ["is_active", "current"],
    },
  },
};

type TargetKey = keyof typeof TARGETS;

/**
 * Target schemas the user can pick from the selector at the top of the
 * demo. Each one is a complete canonical-shape schema with required
 * fields, source-aliases, coercion hints — drop a real export at the
 * matching target and it should fly through clean.
 */
const TARGETS: Record<string, { schema: Record<string, unknown>; label: string }> = {
  staff: { schema: STAFF_SCHEMA, label: "Staff" },
  customer: { schema: CUSTOMER_SCHEMA, label: "Customer (SimPRO)" },
  contact: { schema: CONTACT_SCHEMA, label: "Contact (SimPRO)" },
  site: { schema: SITE_SCHEMA, label: "Site (SimPRO)" },
};

const SCHEMA_REGISTRY: Record<string, Record<string, unknown>> = {
  staff: STAFF_SCHEMA,
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  asset: {
    "x-eq-entity": "asset",
    type: "object",
    properties: {
      external_id: { "x-eq-source-aliases": ["asset_id", "tag", "tag_no", "asset_no", "ref"] },
      asset_type: { "x-eq-source-aliases": ["type", "category", "equipment_type", "kind"] },
      name: { "x-eq-source-aliases": ["description", "asset_name", "equipment"] },
      make: { "x-eq-source-aliases": ["manufacturer", "brand"] },
      model: { "x-eq-source-aliases": ["model_no", "model_number"] },
      serial_number: { "x-eq-source-aliases": ["serial", "serial_no", "sn"] },
      install_date: { "x-eq-source-aliases": ["installed", "commissioned"] },
      location_in_site: { "x-eq-source-aliases": ["location", "room", "level", "area"] },
      criticality: { "x-eq-source-aliases": ["priority", "risk_level"] },
      condition: { "x-eq-source-aliases": ["state", "rating"] },
      ppm_frequency: { "x-eq-source-aliases": ["service_frequency", "schedule", "ppm"] },
    },
  },
  prestart: {
    "x-eq-entity": "prestart",
    type: "object",
    properties: {
      site_id: { "x-eq-source-aliases": ["site", "location"] },
      plant_id: { "x-eq-source-aliases": ["plant", "equipment", "machine"] },
      check_date: { "x-eq-source-aliases": ["date", "performed_on"] },
      operator_name: { "x-eq-source-aliases": ["operator", "performed_by", "checker"] },
      fluid_levels_ok: { "x-eq-source-aliases": ["fluids", "oil", "coolant"] },
      tyres_ok: { "x-eq-source-aliases": ["tyres", "tires"] },
      lights_ok: { "x-eq-source-aliases": ["lights", "indicators"] },
    },
  },
  incident: {
    "x-eq-entity": "incident",
    type: "object",
    properties: {
      incident_date: { "x-eq-source-aliases": ["date", "occurred_on", "when"] },
      site_id: { "x-eq-source-aliases": ["site", "location"] },
      incident_type: { "x-eq-source-aliases": ["type", "category", "kind"] },
      severity: { "x-eq-source-aliases": ["impact", "level"] },
      description: { "x-eq-source-aliases": ["details", "what_happened"] },
      reported_by: { "x-eq-source-aliases": ["reporter", "logged_by"] },
      injury: { "x-eq-source-aliases": ["injured", "injury_y_n"] },
    },
  },
};

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [target, setTarget] = useState<TargetKey>("staff");
  const [mode, setMode] = useState<Mode>("intake");

  const picked = useMemo(() => pickAi(), []);
  const { ai } = picked;
  const mockSupabase = useMemo(() => createMockSupabase(), []);

  const targetSchema = TARGETS[target].schema;
  const canonicalFields = useMemo(
    () => Object.keys((targetSchema.properties ?? {}) as Record<string, unknown>),
    [targetSchema],
  );

  // Log the chosen provider once on mount. Never the key value.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(`[eq-intake-demo] ${picked.logLine}`);
  }, [picked.logLine]);

  /**
   * Log each "where is this going?" answer to localStorage so we can read
   * back the route map later. Just timestamped entries — no PII, no row
   * contents. The point is to see which destinations come up most often
   * across real-world drops, so we know which export profiles are worth
   * building first.
   */
  const onDestinationChange = useMemo(
    () => (value: string | undefined, source: "suggested" | "free_text") => {
      if (!value) return;
      const KEY = "eq-intake-demo:routes";
      try {
        const existing = localStorage.getItem(KEY);
        const log: Array<{ at: string; destination: string; source: string }> =
          existing ? JSON.parse(existing) : [];
        log.push({ at: new Date().toISOString(), destination: value, source });
        // Cap at 200 entries so the log doesn't grow forever on this machine.
        const trimmed = log.slice(-200);
        localStorage.setItem(KEY, JSON.stringify(trimmed));
        // eslint-disable-next-line no-console
        console.log(`[eq-intake-demo] route logged: → ${value} (${source}); total=${trimmed.length}`);
      } catch {
        // localStorage may be full / disabled — silently skip
      }
    },
    [],
  );

  const commit: CommitFn = useMemo(
    () => async (rows: CommittableRow[]) => {
      // Simulate a real commit by logging each row + a short delay
      await new Promise((r) => setTimeout(r, 800));
      const entries = [
        `--- commit @ ${new Date().toISOString()} ---`,
        `${rows.length} rows would be sent to eq_intake_commit_batch()`,
        ...rows.slice(0, 5).map(
          (r, i) =>
            `[${i + 1}] ${JSON.stringify(r.canonical, null, 0)}`,
        ),
        rows.length > 5 ? `... and ${rows.length - 5} more` : "",
      ].filter(Boolean);
      setLog((prev) => [...entries, "", ...prev]);
      return { committed: rows.length, failed: 0 };
    },
    [],
  );

  const config = useMemo(
    () => ({
      schema: targetSchema,
      tenantId: "00000000-0000-4000-8000-000000000001",
      ai,
      commit,
      schemaRegistry: SCHEMA_REGISTRY,
    }),
    [ai, commit, targetSchema],
  );

  return (
    <div className="eq-shell">
      <header className="eq-shell__header">
        <div className="eq-shell__brand">
          <h1>EQ Intake</h1>
          <p>Drop a sheet. AI learns its shape so you don't retype it into EQ — or out to the next system.</p>
        </div>
        <div className="eq-shell__pills">
          <span
            className={
              "eq-shell__pill eq-shell__pill--ai " +
              (picked.isReal ? "eq-shell__pill--ai-real" : "eq-shell__pill--ai-mock")
            }
            title={picked.logLine}
          >
            AI: {picked.label}
          </span>
          <span className="eq-shell__pill">demo · localhost only</span>
        </div>
      </header>

      <main className="eq-shell__main">
        <section className="eq-mode-primary">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "intake"}
            className={
              "eq-mode-primary__button" +
              (mode === "intake" ? " eq-mode-primary__button--active" : "")
            }
            onClick={() => setMode("intake")}
          >
            <span className="eq-mode-primary__title">One-screen Intake</span>
            <span className="eq-mode-primary__subtitle">
              The actual product — same screen embedded in Shell
            </span>
          </button>
        </section>

        <section className="eq-mode-secondary">
          <p className="eq-mode-secondary__label">
            Engineering scenarios below — parser test harnesses, not the product
          </p>
          <div
            className="eq-mode-tabs eq-mode-tabs--secondary"
            role="tablist"
            aria-label="Engineering scenarios"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              className={"eq-mode-tab" + (mode === "single" ? " eq-mode-tab--active" : "")}
              onClick={() => setMode("single")}
            >
              Single file → into EQ
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "bundle"}
              className={"eq-mode-tab" + (mode === "bundle" ? " eq-mode-tab--active" : "")}
              onClick={() => setMode("bundle")}
            >
              SimPRO bundle → SharePoint paste
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "reconcile"}
              className={"eq-mode-tab" + (mode === "reconcile" ? " eq-mode-tab--active" : "")}
              onClick={() => setMode("reconcile")}
            >
              Reconcile
            </button>
          </div>
        </section>

        {mode === "single" ? (
          <section className="eq-target-selector">
            <label htmlFor="target-select">
              <strong>Target schema:</strong>
            </label>
            <select
              id="target-select"
              value={target}
              onChange={(e) => setTarget(e.target.value as TargetKey)}
            >
              {Object.entries(TARGETS).map(([key, t]) => (
                <option key={key} value={key}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="eq-target-selector__hint">
              Pick the EQ entity you're aiming at. The mapper, classifier,
              and validator all retarget when you change this.
            </span>
          </section>
        ) : null}

        {mode !== "intake" && mode !== "reconcile" && (
        <section className="eq-info-panel">
          <strong>What you're looking at:</strong>
          {mode === "single" ? (
            <ul>
              <li>
                The dropzone is the <code>&lt;ParserDropZone&gt;</code> component from
                <code> @eq/confirm-ui</code> — drop it into any React app, configure with
                schema + AI + commit, done.
              </li>
              <li>
                Target is <strong>{TARGETS[target].label}</strong>. Switch above to retarget.
                {target === "staff" ? (
                  <> Try a column-name-perfect file or one with rough aliases (Mob, Surname, Sub, FT).</>
                ) : null}
                {target === "customer" || target === "contact" || target === "site" ? (
                  <> Drop a real SimPRO export here — the source-aliases match SimPRO's column names.</>
                ) : null}
              </li>
              <li>
                {picked.isReal ? (
                  <>
                    The AI is the <strong>real AnthropicProvider</strong> — calls
                    hit api.anthropic.com (CORS-permitting, otherwise point{" "}
                    <code>VITE_ANTHROPIC_BASE_URL</code> at a local proxy).
                  </>
                ) : (
                  <>
                    The AI is <strong>mocked</strong> (no API key needed). It does
                    identity-or-alias mapping with a fake 600ms delay so the spinner
                    is visible. Set <code>VITE_ANTHROPIC_API_KEY</code> in{" "}
                    <code>.env.local</code> to switch to real Anthropic.
                  </>
                )}
              </li>
              <li>
                The commit function is a console-log — no real Supabase call. The
                "committed" rows appear in the panel below.
              </li>
            </ul>
          ) : (
            <ul>
              <li>
                Drop your three SimPRO CSV exports below — <strong>customer</strong>,{" "}
                <strong>customer contacts</strong>, and <strong>site</strong>. Order
                doesn't matter; each file's role is auto-detected by the classifier.
              </li>
              <li>
                The join happens in-browser. Customer ID links customers ↔ contacts ↔
                sites. Output is one CSV row per customer, with sites + contacts
                rolled into pipe-separated cells.
              </li>
              <li>
                No SharePoint API call — the result downloads as a CSV you paste
                manually into your SharePoint list. No Microsoft Graph, no friction.
              </li>
            </ul>
          )}
          {mode === "single" ? (
            <div className="eq-samples">
              <button type="button" onClick={() => downloadSample()}>
                Download a sample CSV
              </button>
              <button type="button" onClick={() => downloadMessySample()}>
                Download a messy sample (alias mapping)
              </button>
            </div>
          ) : null}
        </section>
        )}

        {mode === "single" ? (
          <ParserDropZone
            key={target}
            config={config}
            canonicalFields={canonicalFields}
            onDestinationChange={onDestinationChange}
          />
        ) : mode === "bundle" ? (
          <RollupDropZone />
        ) : mode === "intake" ? (
          // canImport unlocks "Bring Data In" — without it the demo can only ever
          // reach Overview/To Do/Ask, so this playground couldn't demo the import
          // screen at all. canEditCanonical unlocks the ⚙/🔧 settings entries.
          <IntakeModule
            onDestinationChange={onDestinationChange}
            canImport
            canEditCanonical
            canQualifyTenders
            supabase={mockSupabase}
            tenantId="00000000-0000-4000-8000-000000000001"
          />
        ) : (
          <ReconcileModule />
        )}

        {log.length > 0 && (
          <div className="eq-card">
            <h2>Commit log</h2>
            <p>Each commit appears here. The real RPC would talk to <code>eq_intake_commit_batch()</code>.</p>
            <pre className="eq-commit-log">{log.join("\n")}</pre>
          </div>
        )}
      </main>

      <footer className="eq-shell__footer">
        EQ Intake demo · @eq/confirm-ui + @eq/intake + @eq/validation
      </footer>
    </div>
  );
}

// =========================================================================
// Sample-download helpers (keep the demo self-contained)
// =========================================================================

function downloadSample() {
  const csv =
    "first_name,last_name,email,phone,employment_type,trade,start_date,active\n" +
    "James,Patel,james.patel@example.com.au,+61412345678,employee,electrical,2022-03-01,true\n" +
    "Sarah,O'Brien,sarah.obrien@example.com.au,+61413555111,subcontractor,electrical,2023-06-15,true\n" +
    "Lien,Tran,lien.tran@example.com.au,+61415444222,apprentice,electrical,2024-01-22,true\n" +
    "Kofi,Asante,k.asante@example.com.au,+61416777888,employee,fire,2020-11-05,true\n";
  download("staff-clean.csv", csv);
}

function downloadMessySample() {
  // Aliases force the mock AI to do alias-resolution rather than identity match.
  const csv =
    "First,Surname,Mail,Mob,Type,Discipline,Started,Is Active\n" +
    "James,Patel,james.patel@example.com.au,0412 345 678,FT,electrical,1/3/2022,Y\n" +
    "Sarah,O'Brien,sarah.obrien@example.com.au,(04) 1355 5111,Sub,electrical,15/06/23,Y\n" +
    "Michael,Henderson,m.henderson@example.com.au,0414-222-333,Permanent,mechanical,12-Sep-21,Y\n" +
    "Tom,O'Sullivan,,no mobile,FT,electrical,5/5/22,Y\n";
  download("staff-messy.csv", csv);
}

function download(name: string, body: string) {
  const blob = new Blob([body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
