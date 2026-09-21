/**
 * EQ Format - frontend (vanilla DOM, no framework).
 *
 * Three stages:
 *   1. Input    - drop / paste / sample
 *   2. Mapping  - instant heuristic match against schema source-aliases,
 *                 with a "Refine with AI" button for the harder columns
 *   3. Result   - valid / flagged / rejected from /api/validate
 */

interface ColumnMapping {
  sourceColumn: string;
  canonicalField: string | null;
  confidence: number;
  reason: string;
}

interface MapResult {
  mappings: ColumnMapping[];
  warnings: Array<{ type: string; message: string; affected: string[] }>;
  suggestions: Array<{ type: string; message: string; details: unknown }>;
  needsClarification: Array<{ question: string; sourceColumn: string; options: string[] }>;
}

interface ValidationResult {
  valid_rows: Array<{ source_row_index: number; canonical: Record<string, unknown> }>;
  flagged_rows: Array<{ source_row_index: number; canonical: Record<string, unknown>; flags: Array<{ kind: string; [k: string]: unknown }> }>;
  rejected_rows: Array<{ source_row_index: number; raw: Record<string, unknown>; errors: Array<{ kind: string; [k: string]: unknown }> }>;
  summary: { total: number; valid: number; flagged: number; rejected: number; by_field_errors: Record<string, number> };
}

const DQ = String.fromCharCode(34);

const state: {
  rawCsv: string;
  parsedHeader: string[];
  parsedRows: Record<string, string>[];
  entity: string;
  entities: string[];
  schema: { properties?: Record<string, { "x-eq-source-aliases"?: string[] }> } | null;
  canonicalFields: string[];
  mapping: Record<string, string | null>;
  result?: ValidationResult;
  activeBucket: "valid" | "flagged" | "rejected";
} = {
  rawCsv: "",
  parsedHeader: [],
  parsedRows: [],
  entity: "staff",
  entities: [],
  schema: null,
  canonicalFields: [],
  mapping: {},
  activeBucket: "valid",
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const lines = body.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (inQ) {
        if (c === DQ && line[i + 1] === DQ) { cur += DQ; i++; }
        else if (c === DQ) inQ = false;
        else cur += c;
      } else {
        if (c === DQ) inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseRow(lines[0]!).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = parseRow(line);
    const r: Record<string, string> = {};
    header.forEach((h, i) => { r[h] = (cells[i] ?? "").trim(); });
    return r;
  });
  return { header, rows };
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return DQ + s.replace(new RegExp(DQ, "g"), DQ + DQ) + DQ;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(","));
  return lines.join("\n") + "\n";
}

function downloadText(filename: string, body: string) {
  const blob = new Blob([body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Heuristic mapper - instant, no network call. Uses x-eq-source-aliases
// from the schema. Handles 70-80% of common cases without AI.
// ---------------------------------------------------------------------------
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/[\s_\-]+/)
    .filter(Boolean);
}

function scoreMatch(srcTokens: string[], targetTokens: string[]): number {
  if (srcTokens.length === 0 || targetTokens.length === 0) return 0;
  const srcJoined = srcTokens.join("");
  const tgtJoined = targetTokens.join("");
  if (srcJoined === tgtJoined) return 1.0;
  const setA = new Set(srcTokens);
  const setB = new Set(targetTokens);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  if (common === 0) {
    if (srcJoined.length >= 3 && tgtJoined.includes(srcJoined)) return 0.65;
    if (tgtJoined.length >= 3 && srcJoined.includes(tgtJoined)) return 0.65;
    return 0;
  }
  return common / Math.max(setA.size, setB.size);
}

function buildHeuristicMappings(
  sourceColumns: string[],
  schema: { properties?: Record<string, { "x-eq-source-aliases"?: string[] }> } | null,
): ColumnMapping[] {
  if (!schema?.properties) {
    return sourceColumns.map((c) => ({
      sourceColumn: c,
      canonicalField: null,
      confidence: 0,
      reason: "no schema loaded",
    }));
  }

  type Candidate = { canonical: string; tokens: string[]; weight: number; via: string };
  const candidates: Candidate[] = [];
  for (const [canonical, fs] of Object.entries(schema.properties)) {
    candidates.push({ canonical, tokens: tokenize(canonical), weight: 1.0, via: "field name" });
    const aliases = (fs as { "x-eq-source-aliases"?: string[] })["x-eq-source-aliases"] ?? [];
    for (const a of aliases) {
      candidates.push({ canonical, tokens: tokenize(a), weight: 0.95, via: "alias \"" + a + "\"" });
    }
  }

  // First pass: score every source column against every candidate
  const scored = sourceColumns.map((src) => {
    const srcTokens = tokenize(src);
    let best: { canonical: string | null; score: number; via: string } = {
      canonical: null, score: 0, via: "no match",
    };
    for (const c of candidates) {
      const score = scoreMatch(srcTokens, c.tokens) * c.weight;
      if (score > best.score) {
        best = { canonical: c.canonical, score, via: c.via };
      }
    }
    return { src, best };
  });

  // Second pass: resolve duplicates by keeping the higher-confidence match.
  // The losing source columns drop (canonicalField=null).
  const winners = new Map<string, typeof scored[number]>();
  for (const s of scored) {
    if (!s.best.canonical || s.best.score < 0.5) continue;
    const existing = winners.get(s.best.canonical);
    if (!existing || s.best.score > existing.best.score) {
      winners.set(s.best.canonical, s);
    }
  }

  return scored.map(({ src, best }) => {
    const isWinner = best.canonical && winners.get(best.canonical)?.src === src;
    if (!isWinner) {
      const reason = best.canonical && best.score >= 0.5
        ? "skipped - " + best.canonical + " already claimed by another column with higher score"
        : (best.score < 0.5 && best.canonical
            ? "weak match (" + best.score.toFixed(2) + " via " + best.via + ") - dropped"
            : "no obvious match in schema aliases - dropped");
      return { sourceColumn: src, canonicalField: null, confidence: best.score, reason };
    }
    return {
      sourceColumn: src,
      canonicalField: best.canonical,
      confidence: best.score,
      reason: best.score >= 0.95 ? "exact match via " + best.via
            : best.score >= 0.7 ? "strong match via " + best.via
            : "partial match via " + best.via,
    };
  });
}

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------
function showStage(id: "stage-input" | "stage-mapping" | "stage-result") {
  for (const s of ["stage-input", "stage-mapping", "stage-result"] as const) {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("active", s === id);
  }
}

function showError(message: string) {
  const existing = document.querySelector(".error-banner");
  if (existing) existing.remove();
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = message;
  const main = document.querySelector("main");
  main?.insertBefore(banner, main.firstChild);
  setTimeout(() => banner.remove(), 8000);
}

// ---------------------------------------------------------------------------
// Stage 1: input
// ---------------------------------------------------------------------------
async function loadEntities() {
  const r = await fetch("/api/entities");
  if (!r.ok) throw new Error("Failed to fetch entities");
  const data = await r.json() as { entities: string[] };
  state.entities = data.entities;
}

async function loadSchema(entity: string) {
  const r = await fetch("/api/schema/" + entity);
  if (!r.ok) throw new Error("Failed to fetch schema for " + entity);
  state.schema = await r.json();
  state.canonicalFields = Object.keys(state.schema?.properties ?? {});
}

async function ingestCsv(text: string) {
  state.rawCsv = text;
  const { header, rows } = parseCsv(text);
  if (header.length === 0 || rows.length === 0) {
    showError("CSV looks empty - need at least a header row and one data row");
    return;
  }
  state.parsedHeader = header;
  state.parsedRows = rows;

  const guessEntity = (): string => {
    const all = header.join(" ").toLowerCase();
    if (/(part\s*number|description|cost\s*centre|item\s*type)/.test(all)) return "asset";
    if (/(first\s*name|last\s*name|employment|trade)/.test(all)) return "staff";
    if (/(address|suburb|postcode|site)/.test(all)) return "site";
    if (/(swms|hazard|control)/.test(all)) return "swms";
    if (/(prestart|pre-start)/.test(all)) return "prestart";
    return state.entities.includes("staff") ? "staff" : (state.entities[0] ?? "staff");
  };
  state.entity = guessEntity();
  await loadSchema(state.entity);
  const cacheHit = await checkTemplate();
  if (!cacheHit) runHeuristicMap();
}

// ---------------------------------------------------------------------------
// Template cache — local-file fallback for signature-hash caching.
// Hits the dev server's /api/templates/{find,save} which persists to
// eq-format-ui/.templates/<hash>.json. Same shape that
// `eq_intake_find_template_by_signature` will eventually serve from Supabase.
// ---------------------------------------------------------------------------
async function checkTemplate(): Promise<boolean> {
  const sample = state.parsedRows.slice(0, 10);
  try {
    const r = await fetch("/api/templates/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: state.entity,
        columns: state.parsedHeader,
        sampleRows: sample,
      }),
    });
    if (!r.ok) return false;
    const data = (await r.json()) as {
      hit: boolean;
      hash?: string;
      mapping?: Record<string, string | null>;
    };
    if (!data.hit || !data.mapping) return false;

    state.mapping = data.mapping;
    const mappings: ColumnMapping[] = state.parsedHeader.map((src) => ({
      sourceColumn: src,
      canonicalField: data.mapping?.[src] ?? null,
      confidence: 1.0,
      reason: "template cache hit",
    }));
    showStage("stage-mapping");
    renderMappingTable({ mappings, warnings: [], suggestions: [], needsClarification: [] });
    const summary = document.getElementById("mapping-summary")!;
    const shortHash = (data.hash ?? "").slice(0, 8);
    summary.innerHTML =
      '<span style="display:inline-block;padding:4px 8px;background:#e6f4ea;color:#0a6e3a;border-radius:4px;font-weight:600;">'
      + '✓ Template matched (' + escapeHtml(shortHash) + '…) — using your saved mapping. No AI call this time.</span>';
    return true;
  } catch {
    return false;
  }
}

async function saveTemplate(): Promise<void> {
  const sample = state.parsedRows.slice(0, 10);
  const btn = document.getElementById("btn-save-template") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }
  try {
    const r = await fetch("/api/templates/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: state.entity,
        columns: state.parsedHeader,
        sampleRows: sample,
        mapping: state.mapping,
      }),
    });
    if (!r.ok) {
      const errBody = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error ?? "save failed");
    }
    const data = (await r.json()) as { hash: string; savedAt: string };
    const summary = document.getElementById("mapping-summary")!;
    summary.innerHTML =
      '<span style="display:inline-block;padding:4px 8px;background:#e6f4ea;color:#0a6e3a;border-radius:4px;font-weight:600;">'
      + '✓ Template saved (' + escapeHtml(data.hash.slice(0, 8)) + '…). Next import of the same shape skips AI entirely.</span>';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError("Save failed: " + message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save as template"; }
  }
}

function runHeuristicMap() {
  showStage("stage-mapping");
  const mappings = buildHeuristicMappings(state.parsedHeader, state.schema);
  state.mapping = {};
  for (const m of mappings) state.mapping[m.sourceColumn] = m.canonicalField;
  renderMappingTable({ mappings, warnings: [], suggestions: [], needsClarification: [] });

  // Quick stats banner so the user knows how many columns auto-matched
  const matched = mappings.filter((m) => m.canonicalField !== null).length;
  const summary = document.getElementById("mapping-summary")!;
  summary.textContent = "Auto-matched " + matched + " of " + mappings.length + " columns against the " + state.entity + " schema. Edit any dropdown that's wrong, or click \"Refine with AI\" for the columns that didn't match.";
}

async function runAiMap() {
  const aiBtn = document.getElementById("btn-refine-ai") as HTMLButtonElement | null;
  if (aiBtn) { aiBtn.disabled = true; aiBtn.textContent = "Refining..."; }
  const summary = document.getElementById("mapping-summary")!;
  summary.innerHTML = '<span class="spinner"></span>Asking the AI mapper (typically 8-15s)...';

  const sample = state.parsedRows.slice(0, 8);
  try {
    const r = await fetch("/api/ai/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: state.entity,
        sourceColumns: state.parsedHeader,
        sampleRows: sample,
      }),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({})) as { error?: string; hint?: string };
      throw new Error((errBody.error ?? "AI map failed") + (errBody.hint ? " - " + errBody.hint : ""));
    }
    const aiResult = await r.json() as MapResult;

    // Merge: AI overrides heuristic where AI confidence is higher
    const heuristic = buildHeuristicMappings(state.parsedHeader, state.schema);
    const heuristicByCol = new Map(heuristic.map((m) => [m.sourceColumn, m]));
    const merged = aiResult.mappings.map((aiM) => {
      const h = heuristicByCol.get(aiM.sourceColumn);
      if (!h) return aiM;
      // Prefer AI when it's confident; keep heuristic for high-confidence local matches
      if (h.confidence >= 0.95 && aiM.confidence < 0.95) {
        return { ...h, reason: "kept local exact match (AI suggested " + (aiM.canonicalField ?? "drop") + ")" };
      }
      return aiM;
    });
    state.mapping = {};
    for (const m of merged) state.mapping[m.sourceColumn] = m.canonicalField;
    renderMappingTable({ ...aiResult, mappings: merged });
    summary.textContent = "Refined with AI. " + merged.filter((m) => m.canonicalField).length + " of " + merged.length + " columns mapped.";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError("AI mapping failed: " + message);
    summary.textContent = "AI refinement failed - keeping the heuristic mapping. Edit any dropdown that's wrong.";
  } finally {
    if (aiBtn) { aiBtn.disabled = false; aiBtn.textContent = "Refine with AI (~10s)"; }
  }
}

// ---------------------------------------------------------------------------
// Stage 2: mapping editor
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(new RegExp(DQ, "g"), "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMappingTable(mapResult: MapResult) {
  const wrap = document.getElementById("mapping-table-wrap")!;

  const optionsHtml = (current: string | null) => {
    const opts = ["", ...state.canonicalFields];
    return opts.map((o) => "<option value=\"" + escapeHtml(o) + "\"" + (o === (current ?? "") ? " selected" : "") + ">" + (o === "" ? "(drop column)" : escapeHtml(o)) + "</option>").join("");
  };

  const rowsHtml = mapResult.mappings.map((m) => {
    const conf = m.confidence ?? 0;
    const cls = conf < 0.5 ? "low" : conf < 0.8 ? "med" : "high";
    return "<tr>" +
      "<td>" + escapeHtml(m.sourceColumn) + "</td>" +
      "<td><select data-source=\"" + escapeHtml(m.sourceColumn) + "\">" + optionsHtml(m.canonicalField) + "</select></td>" +
      "<td class=\"confidence " + cls + "\">" + conf.toFixed(2) + "</td>" +
      "<td class=\"muted\">" + escapeHtml(m.reason) + "</td>" +
      "</tr>";
  }).join("");

  wrap.innerHTML = "<table><thead><tr><th>Source column</th><th>Canonical field</th><th>Conf</th><th>Reason</th></tr></thead><tbody>" + rowsHtml + "</tbody></table>";

  for (const el of wrap.querySelectorAll<HTMLSelectElement>("select[data-source]")) {
    el.addEventListener("change", () => {
      const src = el.getAttribute("data-source")!;
      const val = el.value;
      state.mapping[src] = val === "" ? null : val;
    });
  }
}

// ---------------------------------------------------------------------------
// Stage 3: result
// ---------------------------------------------------------------------------
async function runValidate() {
  const wrap = document.getElementById("result-table-wrap")!;
  showStage("stage-result");
  wrap.innerHTML = '<div class="notice"><span class="spinner"></span>Validating...</div>';

  try {
    const r = await fetch("/api/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: state.entity,
        mapping: state.mapping,
        rows: state.parsedRows,
      }),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(errBody.error ?? "Validate failed");
    }
    state.result = await r.json() as ValidationResult;
    renderResult();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError("Validation failed: " + message);
    showStage("stage-mapping");
  }
}

function renderResult() {
  const r = state.result!;
  const tiles = document.getElementById("summary-tiles")!;
  tiles.innerHTML =
    '<div class="tile valid"><div class="num">' + r.summary.valid + '</div><div class="label">valid</div></div>' +
    '<div class="tile flagged"><div class="num">' + r.summary.flagged + '</div><div class="label">flagged</div></div>' +
    '<div class="tile rejected"><div class="num">' + r.summary.rejected + '</div><div class="label">rejected</div></div>' +
    '<div class="tile"><div class="num">' + r.summary.total + '</div><div class="label">total</div></div>';
  renderBucket(state.activeBucket);
  void renderDerivedExports();
}

interface ProfileSummary {
  id: string;
  label: string;
  description: string;
  inputShape: "simpro-quote" | "canonical" | "raw";
}

function isSimproShape(): boolean {
  return state.parsedHeader.includes("Item Type") && state.parsedHeader.includes("Part Description");
}

async function renderDerivedExports() {
  const wrap = document.getElementById("derived-exports");
  if (!wrap) return;
  wrap.innerHTML = "";

  let profiles: ProfileSummary[];
  try {
    const r = await fetch("/api/format/profiles");
    if (!r.ok) return;
    const data = (await r.json()) as { profiles: ProfileSummary[] };
    profiles = data.profiles;
  } catch {
    return;
  }

  const simpro = isSimproShape();
  const applicable = profiles.filter((p) => {
    if (p.inputShape === "simpro-quote") return simpro;
    if (p.inputShape === "canonical") return true;
    return false;
  });
  if (applicable.length === 0) return;

  const heading = document.createElement("h3");
  heading.textContent = "Derived exports";
  wrap.appendChild(heading);

  const help = document.createElement("p");
  help.className = "muted";
  help.textContent = "Reshape this data into a useful format — procurement BOM, commissioning register, labour summary. One click each.";
  wrap.appendChild(help);

  const btnRow = document.createElement("div");
  btnRow.className = "actions";
  for (const p of applicable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "Download " + p.label;
    btn.title = p.description;
    btn.addEventListener("click", () => void downloadDerived(p));
    btnRow.appendChild(btn);
  }
  wrap.appendChild(btnRow);
}

async function downloadDerived(p: ProfileSummary) {
  const rows = p.inputShape === "canonical"
    ? (state.result?.valid_rows.map((r) => r.canonical) ?? [])
    : (state.parsedRows as unknown as Record<string, unknown>[]);
  try {
    const r = await fetch("/api/format/derive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: p.id, rows }),
    });
    if (!r.ok) {
      const errBody = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error ?? r.statusText);
    }
    const csv = await r.text();
    downloadText(p.id + ".csv", csv);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError("Derive failed: " + message);
  }
}

function renderBucket(bucket: "valid" | "flagged" | "rejected") {
  state.activeBucket = bucket;
  for (const el of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    el.classList.toggle("active", el.getAttribute("data-bucket") === bucket);
  }
  const r = state.result!;
  const wrap = document.getElementById("result-table-wrap")!;

  const renderCanonicalCell = (canonical: Record<string, unknown>) => {
    const entries = Object.entries(canonical);
    if (entries.length === 0) return "<span class=\"muted\">(no canonical data)</span>";
    return entries.map(([k, v]) => "<div><b>" + escapeHtml(k) + ":</b> " + escapeHtml(String(v ?? "")) + "</div>").join("");
  };

  if (bucket === "valid") {
    if (r.valid_rows.length === 0) { wrap.innerHTML = '<p class="notice">No valid rows.</p>'; return; }
    const rows = r.valid_rows.map((row) => "<tr><td>" + renderCanonicalCell(row.canonical) + "</td></tr>").join("");
    wrap.innerHTML = "<table><thead><tr><th>Canonical row</th></tr></thead><tbody>" + rows + "</tbody></table>";
  } else if (bucket === "flagged") {
    if (r.flagged_rows.length === 0) { wrap.innerHTML = '<p class="notice">No flagged rows.</p>'; return; }
    const rows = r.flagged_rows.map((row) => {
      const flags = "<ul>" + row.flags.map((f) => "<li>" + escapeHtml(f.kind) + " " + escapeHtml(JSON.stringify(f).slice(0, 200)) + "</li>").join("") + "</ul>";
      return "<tr><td>" + renderCanonicalCell(row.canonical) + "</td><td class=\"row-flags\">" + flags + "</td></tr>";
    }).join("");
    wrap.innerHTML = "<table><thead><tr><th>Canonical row</th><th>Flags</th></tr></thead><tbody>" + rows + "</tbody></table>";
  } else {
    if (r.rejected_rows.length === 0) { wrap.innerHTML = '<p class="notice">No rejected rows.</p>'; return; }
    const rows = r.rejected_rows.map((row) => {
      const errs = "<ul>" + row.errors.map((e) => "<li>" + escapeHtml(e.kind) + " " + escapeHtml(JSON.stringify(e).slice(0, 200)) + "</li>").join("") + "</ul>";
      const raw = Object.entries(row.raw).map(([k, v]) => "<div><b>" + escapeHtml(k) + ":</b> " + escapeHtml(String(v ?? "")) + "</div>").join("");
      return "<tr><td class=\"muted\">" + raw + "</td><td class=\"row-errors\">" + errs + "</td></tr>";
    }).join("");
    wrap.innerHTML = "<table><thead><tr><th>Raw row</th><th>Errors</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }
}

// ---------------------------------------------------------------------------
// Wire up DOM
// ---------------------------------------------------------------------------
function wireUp() {
  const dropZone = document.getElementById("drop-zone")!;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const pasteInput = document.getElementById("paste-input") as HTMLTextAreaElement;

  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragging"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, () => dropZone.classList.remove("dragging"));
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) await ingestCsv(await file.text());
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await ingestCsv(await file.text());
  });

  document.getElementById("btn-load-paste")!.addEventListener("click", async () => {
    const t = pasteInput.value.trim();
    if (!t) { showError("Paste box is empty"); return; }
    await ingestCsv(t);
  });

  document.getElementById("btn-load-sample")!.addEventListener("click", async () => {
    const r = await fetch("/sample-simpro.csv");
    if (!r.ok) { showError("Sample not available"); return; }
    await ingestCsv(await r.text());
  });

  document.getElementById("btn-refine-ai")!.addEventListener("click", () => runAiMap());
  document.getElementById("btn-save-template")!.addEventListener("click", () => saveTemplate());
  document.getElementById("btn-validate")!.addEventListener("click", () => runValidate());
  document.getElementById("btn-back-to-input")!.addEventListener("click", () => showStage("stage-input"));
  document.getElementById("btn-back-to-input-2")!.addEventListener("click", () => showStage("stage-input"));

  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => {
      const bucket = tab.getAttribute("data-bucket") as "valid" | "flagged" | "rejected";
      renderBucket(bucket);
    });
  }

  document.getElementById("btn-download-valid")!.addEventListener("click", () => {
    if (!state.result) return;
    const rows = state.result.valid_rows.map((r) => r.canonical);
    downloadText("eq-format-valid-" + state.entity + ".csv", rowsToCsv(rows));
  });
}

async function main() {
  wireUp();
  try {
    await loadEntities();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError("Couldn't reach the API server: " + message);
  }
}

main();
