import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { extractText } from "npm:unpdf@1.8.0";

// ---------------------------------------------------------------------------
// parse-maximo-pdf-wo — real HTTP endpoint for the `maximo-pdf-wo` skill.
//
// Deployed to: sks-canonical (ehowgjardagevnrluult)
// Requires:    ANTHROPIC_API_KEY secret set on the project
//
// Why this exists as an edge function rather than an eq-service API route:
// eq-service deploys to Netlify, whose synchronous functions cap out at
// ~26s (site is on nf_team_pro). Vision extraction of one Maximo WO PDF
// takes 28-80s (see docs/MAXIMO-PDF-CUTOVER-PLAN.md in this repo, written
// 2026-05-21 after a live demo run hit this exact wall). Supabase Edge
// Functions have a much longer wall-clock budget, and this project already
// runs one Anthropic-calling function (eq-ai-assist) with the API key
// configured — so this follows that proven path instead of standing up a
// new Netlify site/background-function migration.
//
// Multi-file requests: text extraction runs SEQUENTIALLY per file, vision
// fallback runs CONCURRENTLY across whichever files need it — see the
// TEXT-FIRST, VISION-FALLBACK note below for why (memory, not wall-clock,
// turned out to be the binding constraint for the fast path).
//
// This is a from-scratch HTTP-shaped port of the logic in
// eq-platform/packages/eq-intake/src/skills/maximo-pdf-wo/ (extract.ts,
// to-canonical.ts, group.ts) in THIS repo, plus the field-mapping helpers in
// eq-platform/packages/eq-validation/src/parse-{frequency-suffix,job-plan-code,
// site-prefix}.ts. It is not a direct import of that package — Deno edge
// functions can't resolve local pnpm workspace packages, only jsr:/npm:/http
// specifiers — so the pure-logic pieces are vendored inline below rather than
// wired through @eq/ai's AIProvider abstraction. The vision call itself is
// reimplemented directly against the Anthropic Messages API using tool-use
// to force structured JSON output (more reliable than the free-text-JSON
// parsing @eq/ai's extract() uses).
//
// Response shape matches eq-solves-service's own wire contract exactly
// (lib/import/maximo-pdf-client.ts's MaximoPdfWoResultSchema) — NOT the
// eq-intake package's internal MaintenanceCheckBundle/CheckAssetInsert
// shape, which is richer than eq-service currently consumes. Keeping the
// wire shape stable here means eq-service's client + mapping code (already
// merged, already tested) never needs to change when this endpoint swaps
// in for the dev mock — only the env var does.
//
// TEXT-FIRST, VISION-FALLBACK (added 2026-07-28): every real Equinix Maximo
// export inspected so far (ATS, ACB/breaker, PDU/transformer, switchgear,
// emergency lighting — 5 job-plan families, 393 pages total) turned out to
// be a real digitally-generated PDF, not a scan: every WO prints an
// identical 19-label "Field: value" header block on its own page (one WO
// per page, occasionally one extra continuation page when the task list is
// long — the header is never split across pages). That means the header
// fields we actually need can be pulled with a plain-text parse instead of
// a vision call — no page-count cap, no token budget, no per-PDF Anthropic
// cost, no 28-80s vision latency. The Deno.serve handler below tries the
// text parse first (extractWorkOrdersFromText, via unpdf) for every file and
// only routes whichever files come back null (a scanned export, or a page
// that doesn't match this known label format — a different customer's
// template, or Maximo changing its export layout) through the original
// chunked-vision path (extractWorkOrdersViaVision) — so an unfamiliar PDF
// degrades to the slower/costlier path instead of silently mis-parsing.
// Text extraction across a batch runs sequentially, not concurrently: each
// file alone is fast, but running unpdf's pdf.js-based parser on several
// large PDFs AT ONCE spiked memory past this function's resource limit
// (WORKER_RESOURCE_LIMIT / 546, found live 2026-07-28 on a real 5-file
// batch). Vision fallback stays concurrent since that subset is normally
// empty or small.
//
// verify_jwt is OFF at the gateway: it rejects the legacy-format HS256 JWTs
// this project's callers hold (UNAUTHORIZED_LEGACY_JWT, found live
// 2026-07-28). The function checks the caller itself instead — see "Caller
// check (SEC-109)" below. Without a signed-in caller's token it returns 401
// before any Anthropic call.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Caller check (SEC-109). verify_jwt stays OFF at the gateway (it rejects
// legacy HS256 tokens, and eq-service's Shell-bridged session token is HS256
// signed with this project's JWT secret, so JWKS cannot verify it either).
// Instead the function asks this project's own PostgREST to vouch for the
// caller: PostgREST checks the token signature, and the tm_select RLS policy
// only returns rows to an `authenticated` token whose tenant has members here.
// A token from another tenant's project fails the signature check; the anon
// key and a missing or malformed token return no rows. No new secret: uses
// the SUPABASE_URL / SUPABASE_ANON_KEY the platform injects. Fails closed.
// ---------------------------------------------------------------------------

// The only callers are eq-service server actions (no browser Origin); the
// allowlist exists so a browser from any other site gets no CORS grant.
const ALLOWED_ORIGINS = new Set(["https://service.eq.solutions", "https://core.eq.solutions"]);

function corsFor(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

async function callerIsSignedIn(req: Request): Promise<boolean> {
  const m = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    console.error("caller check cannot run: SUPABASE_URL / SUPABASE_ANON_KEY missing");
    return false;
  }
  try {
    const res = await fetch(`${url}/rest/v1/tenant_members?select=user_id&is_active=eq.true&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${m[1]}`, "Accept-Profile": "service" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_MAX_TOKENS = 8192;
// Anthropic's Messages API hard limit for a single PDF document block is 100
// pages, but the binding constraint in practice is the 200k-token context
// window: a dense scanned chunk of 100 pages measured at 217,359 tokens on
// a real upload (ELEC TRNSFMR.pdf, found live 2026-07-28) — well over budget
// once tool schema + output tokens are counted too. 40 pages/chunk keeps even
// a worst-case-density chunk (~2,200 tokens/page observed) comfortably under
// 200k with room to spare.
const ANTHROPIC_MAX_PDF_PAGES = 40;

// ============================================================================
// WIRE TYPES (must match lib/import/maximo-pdf-client.ts in eq-solves-service)
// ============================================================================

interface WireCheckAsset {
  work_order_number: string;
  asset_external_id: string | null;
  asset_name: string | null;
  location: string | null;
  priority: string | null;
  work_type: string | null;
  crew_id: string | null;
  target_start: string | null;
  target_finish: string | null;
  failure_code: string | null;
  problem: string | null;
  cause: string | null;
  remedy: string | null;
  ir_scan_result: string | null;
  classification: string | null;
}

interface WireBundle {
  group_key: string;
  site_code: string;
  plan_code: string;
  plan_code_raw: string;
  frequency: string | null;
  start_date: string;
  check_assets: WireCheckAsset[];
}

interface WireWarning {
  code: string;
  message: string;
  bundle_group_key?: string | null;
  work_order_number?: string | null;
}

interface WireResult {
  bundles: WireBundle[];
  warnings: WireWarning[];
  sources: { fileName: string; workOrderCount: number }[];
}

// ============================================================================
// VENDORED PURE HELPERS
// (ported from eq-platform/packages/eq-validation/src/parse-*.ts and
//  eq-platform/packages/eq-intake/src/skills/maximo-pdf-wo/to-canonical.ts —
//  see file header. Kept 1:1 with those originals; if they drift, re-sync
//  by diffing this block against the source files.)
// ============================================================================

const FREQUENCY_SUFFIX_MAP: Readonly<Record<string, string>> = Object.freeze({
  A: "annual",
  Q: "quarterly",
  "3": "quarterly",
  M: "monthly",
  S: "semi_annual",
  "6": "semi_annual",
  W: "weekly",
  "2": "2yr",
  "5": "5yr",
  // Maximo revision-lettered variant seen on real SY3 LVACB exports (e.g.
  // "LVACB-5A") — confirmed 2026-07-28 as 5-yearly, the "A" being a job-plan
  // revision letter rather than a second frequency indicator.
  "5A": "5yr",
  "10": "10yr",
});

function mapFrequencySuffix(suffix: string | null | undefined): string | null {
  const key = (suffix ?? "").trim().toUpperCase();
  if (key === "") return null;
  return FREQUENCY_SUFFIX_MAP[key] ?? null;
}

function splitJobPlanCode(raw: string | null | undefined): { code: string; suffix: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { code: "", suffix: "" };
  const idx = trimmed.lastIndexOf("-");
  if (idx === -1) return { code: trimmed, suffix: "" };
  return { code: trimmed.slice(0, idx).trim(), suffix: trimmed.slice(idx + 1).trim() };
}

const SITE_PREFIX_RE = /^AU\d{2}-/;

function stripSitePrefix(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(SITE_PREFIX_RE, "");
}

interface JobPlanParts {
  prefix: string;
  canonicalCode: string;
  description: string | null;
}

function parseJobPlan(raw: string | null | undefined): JobPlanParts {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { prefix: "", canonicalCode: "", description: null };
  const sepIdx = trimmed.indexOf(" - ");
  if (sepIdx === -1) return { prefix: "", canonicalCode: trimmed, description: null };
  const prefix = trimmed.slice(0, sepIdx).trim();
  const remainder = trimmed.slice(sepIdx + 3).trim();
  if (!remainder) return { prefix, canonicalCode: "", description: null };
  const firstSpaceIdx = remainder.search(/\s/);
  if (firstSpaceIdx === -1) return { prefix, canonicalCode: remainder, description: null };
  return {
    prefix,
    canonicalCode: remainder.slice(0, firstSpaceIdx).trim(),
    description: remainder.slice(firstSpaceIdx + 1).trim() || null,
  };
}

function parseAssetCell(raw: string): { externalId: string | null; name: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { externalId: null, name: "" };
  const dashMatch = trimmed.match(/^([^\s—–-]+)\s*[—–-]\s*(.+)$/);
  if (dashMatch) {
    const lead = dashMatch[1]!.trim();
    const rest = dashMatch[2]!.trim();
    if (/^\d+$/.test(lead)) return { externalId: lead, name: rest };
  }
  return { externalId: null, name: trimmed };
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function coerceMaximoDate(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const monthMatch = trimmed.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (monthMatch) {
    const day = parseInt(monthMatch[1]!, 10);
    const monthName = monthMatch[2]!.toLowerCase().slice(0, 3);
    const year = parseInt(monthMatch[3]!, 10);
    const monthIdx = MONTH_ABBR.indexOf(monthName);
    if (monthIdx !== -1) {
      return `${year.toString().padStart(4, "0")}-${(monthIdx + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1]!, 10);
    const month = parseInt(slashMatch[2]!, 10);
    const year = parseInt(slashMatch[3]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].+)?$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  return null;
}

function nullIfBlank(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

// ============================================================================
// RAW EXTRACTED RECORD (one per WO, as returned by the vision tool call)
// ============================================================================

interface RawWorkOrder {
  wo_number: string;
  site: string;
  asset: string;
  status?: string | null;
  location?: string | null;
  work_type?: string | null;
  priority?: string | number | null;
  job_plan: string;
  crew_id?: string | null;
  target_start?: string | null;
  target_finish?: string | null;
  classification?: string | null;
  failure_code?: string | null;
  problem?: string | null;
  cause?: string | null;
  remedy?: string | null;
  ir_scan_result?: string | null;
}

const EXTRACT_TOOL_SCHEMA = {
  name: "extract_work_orders",
  description:
    "Record every distinct IBM Maximo work order found in this PDF. Each PDF may contain 1-N stapled WOs; emit one array entry per WO.",
  input_schema: {
    type: "object",
    properties: {
      work_orders: {
        type: "array",
        items: {
          type: "object",
          required: ["wo_number", "site", "asset", "job_plan"],
          properties: {
            wo_number: { type: "string", description: "Maximo WO number from the top of the header table, e.g. '4501310'." },
            site: { type: "string", description: "Site code as printed, e.g. 'AU01-CA1'." },
            asset: {
              type: "string",
              description:
                "Asset row exactly as printed. Two known shapes: '1070 — CA1-TS-AC-29-ATS' (numeric Maximo ID + descriptive name) or 'CA1-PTP - CA1-Comprehensive Utility Failure Test (PTP)' (no leading ID).",
            },
            status: { type: ["string", "null"], description: "Maximo status code, e.g. 'INPRG', 'WAPPROV', 'COMP'." },
            location: { type: ["string", "null"], description: "Sub-location within site." },
            work_type: { type: ["string", "null"], description: "Maximo work type: 'PM', 'CM', 'EM', 'CAL', 'INSP'." },
            priority: { type: ["string", "number", "null"], description: "Maximo priority, usually 1-4." },
            job_plan: { type: "string", description: "Job plan as printed, e.g. 'ATS-3 - E1.8 ATS-Automatic Transfer Switches'." },
            crew_id: { type: ["string", "null"] },
            target_start: { type: ["string", "null"], description: "Target start date as printed, e.g. '20-May-2026'." },
            target_finish: { type: ["string", "null"], description: "Target finish date as printed." },
            classification: { type: ["string", "null"] },
            failure_code: { type: ["string", "null"] },
            problem: { type: ["string", "null"] },
            cause: { type: ["string", "null"] },
            remedy: { type: ["string", "null"] },
            ir_scan_result: { type: ["string", "null"], description: "IR scan tick-box result — usually blank when scheduling." },
          },
        },
      },
    },
    required: ["work_orders"],
  },
};

// ============================================================================
// ANTHROPIC VISION CALL
// ============================================================================

async function extractWorkOrdersFromPdf(
  apiKey: string,
  fileBytes: Uint8Array,
  fileName: string,
): Promise<{ records: RawWorkOrder[]; warning?: string }> {
  const base64 = encodeBase64(fileBytes);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            {
              type: "text",
              text:
                "This is an IBM Maximo work order PDF export. Extract every WO header table found in the document using the extract_work_orders tool.",
            },
          ],
        },
      ],
      tools: [EXTRACT_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: "extract_work_orders" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status} for '${fileName}': ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { content: Array<{ type: string; input?: unknown }> };
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
    return { records: [], warning: `No work orders extracted from '${fileName}' — vision call returned no tool result.` };
  }

  const workOrders = (toolUse.input as Record<string, unknown>)["work_orders"];
  if (!Array.isArray(workOrders)) {
    return { records: [], warning: `'${fileName}' — extract tool result had no work_orders array.` };
  }

  return { records: workOrders as RawWorkOrder[] };
}

/**
 * Split a PDF into <= maxPages-page chunks. Returns [bytes] unchanged when
 * the PDF is already within the limit — the common case.
 *
 * Known limitation: if a single WO's header table happens to straddle a
 * chunk boundary (spans two pages), that WO may extract incompletely. Not
 * handled — Maximo WO header tables are one-page-each in every fixture seen
 * so far, so this is a theoretical edge case, not an observed one.
 */
async function splitPdfIntoChunks(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes);
  const pageCount = doc.getPageCount();
  if (pageCount <= maxPages) return [bytes];

  const chunks: Uint8Array[] = [];
  for (let start = 0; start < pageCount; start += maxPages) {
    const end = Math.min(start + maxPages, pageCount);
    const chunkDoc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await chunkDoc.copyPages(doc, indices);
    for (const page of copiedPages) chunkDoc.addPage(page);
    chunks.push(await chunkDoc.save());
  }
  return chunks;
}

// ============================================================================
// TEXT-FIRST EXTRACTION (see file header — TEXT-FIRST, VISION-FALLBACK)
// ============================================================================

// The 19 fields every real Maximo WO export prints on its header page, as
// "Label: value" pairs. Order in the PDF doesn't matter here — we require
// ALL 19 to be found before trusting the page as a header (rather than a
// task-list continuation page, which has none of them). This is a strict
// binary check on purpose: partial matches (some labels present, some not)
// were never observed across 393 real pages, so treating a partial match as
// "not this template" and falling back to vision is safer than guessing at
// which fields to trust.
//
// Matching is POSITION-based across the whole page, not line-based: unpdf's
// text extraction (pdf.js under the hood) merges multiple "Label: value"
// pairs from this PDF's 2-column header grid onto a single line (e.g.
// "Site: AU01-SY3 Asset: 2615 - ..."), unlike PyMuPDF, which was used to
// validate this format and preserves one field per line (found live
// 2026-07-28 — the line-based version of this parser silently matched
// nothing and fell back to vision on every real file). Slicing between
// consecutive label match positions is agnostic to whichever line-wrapping
// a given PDF-text-extraction library chooses.
const HEADER_LABELS = [
  "Site", "Asset", "Status", "Serial #", "Work Type", "Location", "Priority",
  "Job Plan", "CrewID", "Target Start", "Target Finish", "Failure",
  "Actual Start", "Actual Finish", "Problem", "Classification", "IR Scan p/f",
  "Cause", "Remedy",
] as const;

const LABEL_RE = new RegExp(
  `(${HEADER_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):\\s*`,
  "g",
);

const WO_NUMBER_RE = /^\d{5,}$/;

function parseHeaderPage(text: string): { wo_number: string; fields: Record<string, string> } | null {
  const matches: { label: string; start: number; valueStart: number }[] = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(text)) !== null) {
    matches.push({ label: m[1]!, start: m.index, valueStart: m.index + m[0].length });
  }
  if (matches.length === 0) return null;

  // "Tasks" is the section title immediately after the header block on every
  // real page — bounds the last field's value so it doesn't swallow the
  // entire task-list table that follows.
  const tasksIdx = text.indexOf("\nTasks");
  const hardEnd = tasksIdx === -1 ? text.length : tasksIdx;

  const fields: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const end = i + 1 < matches.length ? Math.min(matches[i + 1]!.start, hardEnd) : hardEnd;
    fields[cur.label] = text.slice(cur.valueStart, end).trim();
  }
  if (HEADER_LABELS.some((l) => !(l in fields))) return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const woLine = lines.find((l) => WO_NUMBER_RE.test(l));
  if (!woLine) return null;

  return { wo_number: woLine, fields };
}

/**
 * Try to extract every WO on this file from its text layer alone — no
 * Anthropic call. Returns null (not a failure — a signal to fall back to
 * vision) when no page in the file matches the known header format, which
 * covers both "this is a scanned PDF with no text layer" and "this is a
 * template we don't recognise yet".
 */
async function extractWorkOrdersFromText(fileBytes: Uint8Array, fileName: string): Promise<{ records: RawWorkOrder[] } | null> {
  let pageTexts: string[];
  try {
    const { text } = await extractText(fileBytes, { mergePages: false });
    pageTexts = Array.isArray(text) ? text : [text];
  } catch {
    return null; // not a parseable PDF text stream — let vision take it
  }

  const records: RawWorkOrder[] = [];
  for (const pageText of pageTexts) {
    if (!pageText.includes("Work Order Details")) continue;
    const parsed = parseHeaderPage(pageText);
    if (!parsed) continue; // continuation/task-list page — no header data needed
    const f = parsed.fields;
    records.push({
      wo_number: parsed.wo_number,
      site: f["Site"]!,
      asset: f["Asset"]!,
      status: nullIfBlank(f["Status"]),
      location: nullIfBlank(f["Location"]),
      work_type: nullIfBlank(f["Work Type"]),
      priority: nullIfBlank(f["Priority"]),
      job_plan: f["Job Plan"]!,
      crew_id: nullIfBlank(f["CrewID"]),
      target_start: nullIfBlank(f["Target Start"]),
      target_finish: nullIfBlank(f["Target Finish"]),
      classification: nullIfBlank(f["Classification"]),
      failure_code: nullIfBlank(f["Failure"]),
      problem: nullIfBlank(f["Problem"]),
      cause: nullIfBlank(f["Cause"]),
      remedy: nullIfBlank(f["Remedy"]),
      ir_scan_result: nullIfBlank(f["IR Scan p/f"]),
    });
  }

  // Zero header pages found across the whole file means this isn't the known
  // template (or has no text layer at all) — not a partial win worth keeping,
  // fall back to vision for the whole file rather than return an empty result.
  if (records.length === 0) return null;
  return { records };
}

/**
 * Vision fallback for one file that text extraction couldn't handle (a
 * scan, or an unrecognised template) — transparently splitting first if it
 * exceeds Anthropic's per-document page limit. Chunks of the SAME file are
 * also extracted concurrently — a 300-page PDF costs ~one chunk's worth of
 * wall-clock, not three sequential ones.
 */
async function extractWorkOrdersViaVision(
  apiKey: string,
  fileBytes: Uint8Array,
  fileName: string,
): Promise<{ records: RawWorkOrder[]; warning?: string }> {
  let chunks: Uint8Array[];
  try {
    chunks = await splitPdfIntoChunks(fileBytes, ANTHROPIC_MAX_PDF_PAGES);
  } catch {
    // pdf-lib couldn't parse it (encrypted/corrupt/etc.) — send as-is and
    // let Anthropic return its own clear error rather than guessing here.
    chunks = [fileBytes];
  }

  if (chunks.length === 1) {
    return extractWorkOrdersFromPdf(apiKey, chunks[0]!, fileName);
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk, i) => extractWorkOrdersFromPdf(apiKey, chunk, `${fileName} (part ${i + 1}/${chunks.length})`)),
  );

  const records = chunkResults.flatMap((r) => r.records);
  const chunkWarnings = chunkResults.map((r) => r.warning).filter((w): w is string => Boolean(w));
  return {
    records,
    warning: chunkWarnings.length > 0 ? chunkWarnings.join(" ") : undefined,
  };
}

// ============================================================================
// MAPPING: raw WO -> wire check_asset + the group it belongs to
// ============================================================================

interface MappedRow {
  groupKey: string;
  siteCode: string;
  planCode: string;
  planCodeRaw: string;
  frequency: string | null;
  groupStartDate: string | null;
  checkAsset: WireCheckAsset;
  warnings: WireWarning[];
}

function mapWorkOrder(raw: RawWorkOrder, fileName: string): MappedRow {
  const warnings: WireWarning[] = [];
  const wo = String(raw.wo_number ?? "").trim();

  const siteCodeRaw = (raw.site ?? "").trim();
  const siteCode = stripSitePrefix(siteCodeRaw);
  if (!siteCode) {
    warnings.push({ code: "missing_field", message: `WO ${wo}: site code missing or unrecognised ('${siteCodeRaw}').`, work_order_number: wo });
  }

  const planParts = parseJobPlan(raw.job_plan);
  if (!planParts.canonicalCode) {
    warnings.push({ code: "missing_field", message: `WO ${wo}: could not parse job plan ('${raw.job_plan}').`, work_order_number: wo });
  }

  // job_plans.code in EQ is the short mnemonic ("LVACB", "ATS", "SWBD") —
  // NOT the E-number ("E1.25", "E1.8"), which lives in job_plans.name.
  // Maximo prints "LVACB-A - E1.25 Low Voltage Air Circuit Breaker (ACB)",
  // so the mnemonic is the PREFIX before the frequency suffix, not
  // planParts.canonicalCode (which is the E-number). Using canonicalCode
  // here made every real WO import show every plan as "not found in EQ",
  // regardless of the plan actually existing — found live 2026-07-29.
  // Falls back to canonicalCode only for the rare/theoretical case where
  // the raw string has no " - " separator to split a prefix from at all.
  const { code: prefixCode, suffix: prefixSuffix } = splitJobPlanCode(planParts.prefix);
  const jobPlanMnemonic = prefixCode || planParts.canonicalCode;
  const frequency = mapFrequencySuffix(prefixSuffix);
  if (!frequency && prefixSuffix !== "") {
    warnings.push({
      code: "unknown_frequency_suffix",
      message: `WO ${wo}: unknown frequency suffix '${prefixSuffix}' on plan prefix '${planParts.prefix}'.`,
      work_order_number: wo,
    });
  }

  const targetStartIso = coerceMaximoDate(raw.target_start);
  const targetFinishIso = coerceMaximoDate(raw.target_finish);
  if (raw.target_start && !targetStartIso) {
    warnings.push({ code: "invalid_date", message: `WO ${wo}: target_start '${raw.target_start}' is not a recognised date.`, work_order_number: wo });
  }

  const { externalId, name } = parseAssetCell(raw.asset);

  const checkAsset: WireCheckAsset = {
    work_order_number: wo,
    asset_external_id: externalId,
    asset_name: nullIfBlank(name),
    location: nullIfBlank(raw.location),
    priority: raw.priority === null || raw.priority === undefined ? null : String(raw.priority).trim(),
    work_type: nullIfBlank(raw.work_type),
    crew_id: nullIfBlank(raw.crew_id),
    target_start: targetStartIso,
    target_finish: targetFinishIso,
    failure_code: nullIfBlank(raw.failure_code),
    problem: nullIfBlank(raw.problem),
    cause: nullIfBlank(raw.cause),
    remedy: nullIfBlank(raw.remedy),
    ir_scan_result: nullIfBlank(raw.ir_scan_result),
    classification: nullIfBlank(raw.classification),
  };

  // Group on (site, plan, frequency, target_start date) — matches the Delta
  // xlsx importer's groupKey (lib/import/delta-wo-parser.ts::groupKey) so
  // both intake paths collapse identically-dated same-site-same-plan rows
  // into one maintenance_check.
  const groupStartDate = targetStartIso;
  const groupKey = [siteCode, jobPlanMnemonic, frequency ?? "", groupStartDate ?? ""].join("|");

  return {
    groupKey,
    siteCode,
    planCode: jobPlanMnemonic,
    planCodeRaw: planParts.prefix,
    frequency,
    groupStartDate,
    checkAsset,
    warnings,
  };
}

function groupMappedRows(rows: MappedRow[]): WireBundle[] {
  const byKey = new Map<string, WireBundle>();
  const sorted = [...rows].sort((a, b) => {
    if (a.groupKey !== b.groupKey) return a.groupKey.localeCompare(b.groupKey);
    return a.checkAsset.work_order_number.localeCompare(b.checkAsset.work_order_number);
  });

  for (const row of sorted) {
    let bundle = byKey.get(row.groupKey);
    if (!bundle) {
      bundle = {
        group_key: row.groupKey,
        site_code: row.siteCode,
        plan_code: row.planCode,
        plan_code_raw: row.planCodeRaw,
        frequency: row.frequency,
        // Fallback when no WO in the group had a parseable target_start —
        // today's date, so the UI never renders "Invalid Date". The missing
        // date is still surfaced via the warnings array above.
        start_date: row.groupStartDate ?? new Date().toISOString().slice(0, 10),
        check_assets: [],
      };
      byKey.set(row.groupKey, bundle);
    }
    bundle.check_assets.push(row.checkAsset);
  }

  const out = Array.from(byKey.values());
  out.sort((a, b) => [a.site_code, a.plan_code, a.start_date].join("|").localeCompare([b.site_code, b.plan_code, b.start_date].join("|")));
  return out;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

Deno.serve(async (req: Request) => {
  const CORS = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (!(await callerIsSignedIn(req))) {
    return new Response(
      JSON.stringify({ error: "Sign in required" }),
      { status: 401, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY secret not set on this project" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "Expected multipart/form-data with one or more 'files' entries" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: "No files uploaded — expected multipart 'files' field(s)" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  try {
    const allRows: MappedRow[] = [];
    const warnings: WireWarning[] = [];
    const sources: { fileName: string; workOrderCount: number }[] = [];

    const fileEntries = await Promise.all(
      files.map(async (file) => ({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })),
    );

    // Phase 1 (text): SEQUENTIAL on purpose. Each file's text parse alone is
    // sub-5s, but running unpdf's pdf.js-based parser on several large PDFs
    // CONCURRENTLY spiked memory past this function's limit — found live
    // 2026-07-28 (WORKER_RESOURCE_LIMIT / 546) uploading 5 real files
    // (BREAKER 133pp + TRNSFMR 90pp + SWCHGEAR 77pp + 2 more) in one request.
    // One PDF's parse state in memory at a time keeps the peak bounded
    // regardless of batch size, at negligible added wall-clock.
    const textPhase: { fileName: string; bytes: Uint8Array; textResult: { records: RawWorkOrder[] } | null }[] = [];
    for (const entry of fileEntries) {
      textPhase.push({ ...entry, textResult: await extractWorkOrdersFromText(entry.bytes, entry.fileName) });
    }

    // Phase 2 (vision): CONCURRENT — only for files text extraction couldn't
    // handle (a scan, or an unrecognised template). This subset is typically
    // empty, so the memory/CPU cost of concurrent vision calls stays bounded
    // by how many files actually need it, not how many were uploaded.
    // Tracked by original array INDEX, not filename — two uploaded files can
    // share a name (e.g. the same export re-attached), and a filename-keyed
    // map would silently collapse them onto one result.
    const needsVisionIndices: number[] = [];
    textPhase.forEach((f, i) => { if (!f.textResult) needsVisionIndices.push(i); });
    const visionResults = await Promise.all(
      needsVisionIndices.map((i) => extractWorkOrdersViaVision(apiKey, textPhase[i]!.bytes, textPhase[i]!.fileName)),
    );
    const visionByIndex = new Map(needsVisionIndices.map((i, j) => [i, visionResults[j]!]));

    const perFile = textPhase.map((f, i) => {
      if (f.textResult) return { fileName: f.fileName, records: f.textResult.records, warning: undefined as string | undefined };
      const v = visionByIndex.get(i)!;
      return { fileName: f.fileName, records: v.records, warning: v.warning };
    });

    for (const result of perFile) {
      sources.push({ fileName: result.fileName, workOrderCount: result.records.length });
      if (result.warning) {
        warnings.push({ code: "no_records_extracted", message: result.warning });
      }
      for (const raw of result.records) {
        const mapped = mapWorkOrder(raw, result.fileName);
        allRows.push(mapped);
        warnings.push(...mapped.warnings);
      }
    }

    const bundles = groupMappedRows(allRows);

    const body: WireResult = { bundles, warnings, sources };
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
