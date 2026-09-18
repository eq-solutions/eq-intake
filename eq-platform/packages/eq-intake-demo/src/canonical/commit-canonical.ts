/**
 * commit-canonical — bundle → canonical Supabase tables, with audit trail.
 *
 * Takes a SimPRO bundle (parsed customer + site + contact sheets) and:
 *   1. Per entity, in FK order (customer → site → contact):
 *      a. Creates an eq_intake_events row (status: 'committing'), returns intake_id.
 *      b. Maps source columns → canonical fields via x-eq-source-aliases.
 *      c. Validates against the canonical JSON Schema (`@eq/validation`'s
 *         validate()) — produces valid_rows + flagged_rows + rejected_rows.
 *      d. Resolves cross-batch FKs: sites/contacts both have customer_id that
 *         must point at a real customer UUID. We use the customer row's
 *         external_id (SimPRO Customer ID) as the join key.
 *      e. Calls supabase.rpc('eq_intake_commit_batch', { p_intake_id,
 *         p_tenant_id, p_table, p_rows }).
 *      f. Updates the eq_intake_events row to 'completed' or 'failed'.
 *
 *   2. Returns a per-entity result with committed_count, rejected rows,
 *      and the intake_ids so the UI can render the audit trail.
 *
 * The Supabase client type is kept structural (SupabaseLikeClient interface
 * below) so this package doesn't take a hard dependency on
 * `@supabase/supabase-js`. The shell's `getSupabase()` returns a client that
 * satisfies the interface.
 */

import { validate } from "@eq/validation";
import type { ParsedSheet } from "@eq/intake";

// Real canonical JSON Schemas (the same ones used to generate the DB tables).
// Imported as JSON modules — Vite + tsc both handle this via resolveJsonModule.
import customerJsonSchema from "@eq/schemas/schemas/customer.schema.json";
import contactJsonSchema from "@eq/schemas/schemas/contact.schema.json";
import siteJsonSchema from "@eq/schemas/schemas/site.schema.json";
import staffJsonSchema from "@eq/schemas/schemas/staff.schema.json";
import licenceJsonSchema from "@eq/schemas/schemas/licence.schema.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural interface for a Supabase-compatible client.
 *
 * insert() and update().eq() use PromiseLike rather than Promise so that the
 * real @supabase/supabase-js PostgrestFilterBuilder (which is thenable but not
 * a plain Promise) satisfies this interface without a double cast in the shell.
 */
export interface SupabaseLikeClient {
  from: (table: string) => {
    insert: (row: unknown) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    update: (row: unknown) => {
      eq: (
        col: string,
        val: unknown,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
  rpc: (
    name: string,
    params: unknown,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  auth: {
    getUser: () => Promise<{
      data: { user: { id: string } | null };
      error: { message: string } | null;
    }>;
  };
}

export type CanonicalEntity = "customer" | "site" | "contact" | "staff" | "licence";

export interface BundleSheets {
  customer?: ParsedSheet;
  site?: ParsedSheet;
  contact?: ParsedSheet;
  staff?: ParsedSheet;
  licence?: ParsedSheet;
}

export interface EntityCommitResult {
  entity: CanonicalEntity;
  table: string;
  intakeId: string | null;
  committedCount: number;
  /** Rows a stageCommit call parked for human review instead of writing. 0 when no stageCommit is configured. */
  stagedCount: number;
  flaggedCount: number;
  rejectedCount: number;
  /** Per-row rejection reasons for the operator to see. */
  rejectedRows: Array<{ source_row_index: number; reasons: string[] }>;
  /**
   * Rows that saved but have flags the operator should review. `field` is the
   * first flag's field name (a row can carry more than one flag; the first is
   * what "Fix" targets). `recordId` is the row's real canonical primary key —
   * only present on the direct-commit path (eq_intake_commit_batch returns
   * committed_ids; the staged path doesn't, since staged rows land in the
   * review queue, not the table — see StageCommitResult). Undefined when the
   * RPC's returned id array didn't line up with the chunk sent, so a wrong id
   * is never guessed onto the wrong row.
   */
  flaggedRows: Array<{ source_row_index: number; reasons: string[]; field?: string; recordId?: string }>;
  /** If the whole entity commit failed (RPC error, network, etc.), the message. */
  fatalError?: string;
}

export interface StageCommitResult {
  /** Rows that landed immediately — clean, no conflict, no domain-rule flag. */
  committed_count: number;
  committed_ids: string[];
  /** Rows parked in the review queue instead of written. */
  staged_count: number;
}

/**
 * Host-supplied hook that routes a chunk of rows through the same
 * pre-commit health/conflict gate the EQ Shell "per-domain" importer uses
 * (netlify/functions/intake-stage.ts + app_data.eq_intake_staging) instead
 * of writing straight to the canonical table. When omitted, commit falls
 * back to the direct eq_intake_commit_batch RPC — no staging, no conflict
 * check beyond what validate() already flagged client-side. The standalone
 * Vite demo has no backend to stage against, so it never supplies this; the
 * EQ Shell host does.
 */
export type StageCommitFn = (args: {
  table: string;
  entity: CanonicalEntity;
  rows: Record<string, unknown>[];
  intakeId: string;
  schemaVersion: string;
  sourceFilename?: string;
}) => Promise<StageCommitResult>;

export interface CommitOptions {
  supabase: SupabaseLikeClient;
  bundle: BundleSheets;
  tenantId: string;
  /**
   * The user to stamp as created_by on every intake event. Required from
   * hosts whose SupabaseLikeClient never populates a real Supabase Auth
   * session — e.g. EQ Shell's tenant-data clients, which carry identity via
   * a manually-injected bearer JWT instead of supabase.auth.setSession()
   * (see eq-shell's connectTenantClient.ts). On those clients,
   * supabase.auth.getUser() always resolves to "no session", never a real
   * user, regardless of tenant or whether the caller is actually signed in.
   * When omitted, falls back to supabase.auth.getUser() — which is what the
   * standalone demo's mock client satisfies.
   */
  createdBy?: string;
  /** Filename to surface in eq_intake_events.source_filename — for the audit. */
  sourceFilename?: string;
  /** Override schemas — useful for testing. Production callers pass nothing. */
  schemas?: Partial<Record<CanonicalEntity, JsonSchema>>;
  /**
   * Optional progress callback. Called with a plain-English status message at
   * each major step so the UI can show live progress without polling.
   */
  onProgress?: (msg: string) => void;
  /**
   * When supplied, rows are routed through this instead of the direct
   * eq_intake_commit_batch RPC — see StageCommitFn.
   */
  stageCommit?: StageCommitFn;
  /**
   * Max rows per RPC call to the commit batch function. Defaults to 500 on
   * the direct-RPC path. Ignored when stageCommit is set — that path chunks
   * at intake-stage's own 10,000-row cap instead (see STAGE_CHUNK_SIZE).
   * Smaller chunks mean a mid-import failure loses at most chunkSize rows
   * rather than the entire entity. Increase only if the DB connection can
   * reliably handle larger payloads.
   */
  chunkSize?: number;
}

export interface CommitResult {
  bundleSuccess: boolean;
  perEntity: EntityCommitResult[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface JsonSchema {
  $id?: string;
  "x-eq-entity": string;
  "x-eq-table"?: string;
  "x-eq-primary-key"?: string;
  "x-eq-version"?: string;
  required?: string[];
  properties: Record<string, JsonSchemaField>;
}

interface JsonSchemaField {
  type?: string | string[];
  format?: string;
  "x-eq-source-aliases"?: string[];
  "x-eq-foreign-key"?: string;
  "x-eq-system-managed"?: boolean;
  [k: string]: unknown;
}

const CANONICAL_SCHEMAS: Record<CanonicalEntity, JsonSchema> = {
  customer: customerJsonSchema as unknown as JsonSchema,
  site: siteJsonSchema as unknown as JsonSchema,
  contact: contactJsonSchema as unknown as JsonSchema,
  staff: staffJsonSchema as unknown as JsonSchema,
  licence: licenceJsonSchema as unknown as JsonSchema,
};

const ENTITY_TABLE: Record<CanonicalEntity, string> = {
  customer: "customers",
  site: "sites",
  contact: "contacts",
  staff: "staff",
  licence: "licences",
};

// FK resolution order:
//   1. customers — no upstream FK
//   2. sites     — FK to customer
//   3. contacts  — FK to customer
//   4. staff     — no FK to customer (field entity, independent)
//   5. licences  — FK to staff
const COMMIT_ORDER: CanonicalEntity[] = ["customer", "site", "contact", "staff", "licence"];

// ---------------------------------------------------------------------------
// Mapping inference
// ---------------------------------------------------------------------------

/**
 * Build a source-header → canonical-field mapping by matching each header
 * against every field's `x-eq-source-aliases`. Falls back to a normalised
 * name match (lowercase, underscores) for fields the schema author didn't
 * list as an alias.
 */
export function inferMapping(
  headers: string[],
  schema: JsonSchema,
): Record<string, string | null> {
  const norm = (s: string): string =>
    s.toLowerCase().replace(/[\s\-./]+/g, "_").replace(/[^a-z0-9_]/g, "");
  const aliasIndex = new Map<string, string>();
  for (const [field, sub] of Object.entries(schema.properties)) {
    const aliases = sub["x-eq-source-aliases"] ?? [];
    for (const a of aliases) {
      aliasIndex.set(norm(a), field);
    }
    // Also let the canonical field name itself match a normalised header.
    aliasIndex.set(norm(field), field);
  }

  const mapping: Record<string, string | null> = {};
  for (const h of headers) {
    const hit = aliasIndex.get(norm(h));
    mapping[h] = hit ?? null;
  }
  return mapping;
}

export interface MultiValueCandidate {
  /** Canonical field carrying the schema's x-eq-multi-value hint. */
  field: string;
  /** Source column mapped to that field (via the same aliasing inferMapping uses at commit time). */
  sourceColumn: string;
  /** Rows whose raw cell for this column looks like 2+ comma-separated values. */
  affectedRowCount: number;
  /** A few of the raw (unsplit) cell values, for a review message. */
  sampleValues: string[];
}

const MULTI_VALUE_SAMPLE_LIMIT = 3;

/**
 * Pre-commit scan for likely multi-value cells (e.g. "Wollongong, Malabar" in
 * a site name column), mirroring @eq/validation's own x-eq-multi-value +
 * comma-split rule (validate.ts) so IntakeModule can warn before "Save into
 * EQ" — not just after, when validate() runs for real inside commitOneEntity.
 *
 * Deliberately independent of validate() itself: sites/contacts' customer_id
 * FK isn't resolved yet at this point in the flow (that only happens inside
 * commitOneEntity, after customers have committed), so a real validate() call
 * here would misfire fk_no_match on every row just to answer a question that
 * has no FK dependency at all.
 */
export function previewMultiValueCandidates(
  sheet: ParsedSheet,
  entity: CanonicalEntity,
  schemas?: Partial<Record<CanonicalEntity, JsonSchema>>,
): MultiValueCandidate[] {
  const schema = schemas?.[entity] ?? CANONICAL_SCHEMAS[entity];
  const mapping = inferMapping(sheet.headerRow, schema);

  const multiValueFields = new Map<string, string>(); // canonField -> sourceColumn
  for (const [sourceColumn, canonField] of Object.entries(mapping)) {
    if (!canonField) continue;
    if (schema.properties[canonField]?.["x-eq-multi-value"]) {
      multiValueFields.set(canonField, sourceColumn);
    }
  }
  if (multiValueFields.size === 0) return [];

  const candidates: MultiValueCandidate[] = [];
  for (const [field, sourceColumn] of multiValueFields) {
    let affectedRowCount = 0;
    const sampleValues: string[] = [];
    for (const row of sheet.rows as Record<string, unknown>[]) {
      const raw = row[sourceColumn];
      if (typeof raw !== "string") continue;
      const segments = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (segments.length >= 2) {
        affectedRowCount++;
        if (sampleValues.length < MULTI_VALUE_SAMPLE_LIMIT && !sampleValues.includes(raw)) {
          sampleValues.push(raw);
        }
      }
    }
    if (affectedRowCount > 0) {
      candidates.push({ field, sourceColumn, affectedRowCount, sampleValues });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatValidationError(e: {
  kind: string;
  field?: string;
  rule_id?: string;
  message?: string;
  reason?: string;
  value?: unknown;
  allowed?: string[];
  expected?: string;
  got?: unknown;
  format?: string;
}): string {
  const f = e.field ? `"${e.field}"` : e.rule_id ? `rule "${e.rule_id}"` : "this row";
  switch (e.kind) {
    case 'required_field_missing': return `${f}: required — fill this in`;
    case 'invalid_enum': return e.allowed?.length
      ? `${f}: must be one of ${e.allowed.join(", ")}`
      : `${f}: value not in the allowed list`;
    case 'type_error': return e.expected
      ? `${f}: expected ${e.expected}, got "${String(e.got)}"`
      : `${f}: wrong type`;
    case 'format_error': return e.format
      ? `${f}: expected format "${e.format}"`
      : `${f}: wrong format`;
    case 'cap_exceeded': return `Row limit reached — split the file and re-import`;
    case 'fk_no_match': return `${f}: no matching record found — check the ID`;
    case 'cross_field_error': return e.message ? `${f}: ${e.message}` : `${f}: cross-field validation failed`;
    default:
      if (e.message) return `${f}: ${e.message}`;
      if (e.reason) return `${f}: ${e.reason}`;
      if (e.allowed?.length) return `${f}: must be one of ${e.allowed.join(", ")}`;
      if (e.expected) return `${f}: expected ${e.expected}`;
      return `${f}: validation error (${e.kind})`;
  }
}

function formatFlag(f: {
  kind: string;
  field?: string;
  rule_id?: string;
  message?: string;
  reason?: string;
  candidates?: unknown[];
  values?: unknown[];
}): string {
  const where = f.field ? `"${f.field}"` : f.rule_id ? `rule "${f.rule_id}"` : "this row";
  switch (f.kind) {
    case 'phone_kept_raw': return `${where}: phone format not recognised — kept as-is, check before saving`;
    case 'sensitive_field': return `${where}: contains sensitive data — verify before sharing`;
    case 'fk_fuzzy_match': {
      const n = Array.isArray(f.candidates) ? f.candidates.length : 'multiple';
      return `${where}: ${n} possible match${n === 1 ? '' : 'es'} — needs a manual pick`;
    }
    case 'date_ambiguous': {
      const opts = Array.isArray(f.candidates) ? f.candidates.join(" or ") : "multiple formats";
      return `${where}: date is ambiguous — could be ${opts}`;
    }
    case 'value_unusual': return `${where}: ${f.reason ?? 'value looks unusual — check it'}`;
    case 'cross_field_warning': return f.message ?? `warning on ${where}`;
    case 'multi_value_candidate': {
      const n = Array.isArray(f.values) ? f.values.length : undefined;
      return n
        ? `${where}: looks like ${n} separate values — saved as one combined value for now, edit to split`
        : `${where}: looks like more than one value — saved as one combined value for now, edit to split`;
    }
    default: return f.message ? `${where}: ${f.message}` : `${where}: ${f.kind}`;
  }
}

// ---------------------------------------------------------------------------
// eq_intake_events lifecycle
// ---------------------------------------------------------------------------

interface CreateIntakeEventArgs {
  supabase: SupabaseLikeClient;
  tenantId: string;
  createdBy: string;
  entity: CanonicalEntity;
  schemaVersion: string;
  sourceFilename?: string;
  sourceKind?: string;
}

async function createIntakeEvent(args: CreateIntakeEventArgs): Promise<string> {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is not available in this environment — use a modern browser or Node 19+');
  }
  const intakeId = crypto.randomUUID();
  // shell_control is not in the Supabase exposed-schemas list — direct
  // from("eq_intake_events").insert() fails with "Invalid schema: shell_control".
  // Use the public-schema SECURITY DEFINER wrapper added in migration 016.
  const { error } = await args.supabase.rpc("eq_create_intake_event", {
    p_intake_id: intakeId,
    p_tenant_id: args.tenantId,
    p_entity: args.entity,
    p_source_kind: args.sourceKind ?? "import_spreadsheet",
    p_source_filename: args.sourceFilename ?? null,
    p_schema_version: args.schemaVersion,
    p_status: "committing",
    p_import_mode: "upsert",
    p_created_by: args.createdBy,
  });
  if (error) {
    throw new Error(`Failed to create intake event for ${args.entity}: ${error.message}`);
  }
  return intakeId;
}

interface FinishIntakeEventArgs {
  supabase: SupabaseLikeClient;
  intakeId: string;
  status: "completed" | "failed";
  rowsCommitted: number;
  rowsFlagged: number;
  rowsRejected: number;
  errorMessage?: string;
}

async function finishIntakeEvent(args: FinishIntakeEventArgs): Promise<void> {
  // shell_control is not in the Supabase exposed-schemas list — direct
  // from("eq_intake_events").update() fails. Use the SECURITY DEFINER wrapper
  // added in migration 019.
  const { error } = await args.supabase.rpc("eq_finish_intake_event", {
    p_intake_id: args.intakeId,
    p_status: args.status,
    p_rows_committed: args.rowsCommitted,
    p_rows_flagged: args.rowsFlagged,
    p_rows_rejected: args.rowsRejected,
    p_error_message: args.errorMessage ?? null,
  });
  if (error) {
    // Don't throw — the data is already committed; logging this is best-effort.
    // eslint-disable-next-line no-console
    console.warn(`Failed to finalise intake event ${args.intakeId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// FK resolution between batches
// ---------------------------------------------------------------------------

/**
 * Build an external_id → canonical UUID map from a freshly-committed
 * customer batch. Sites/contacts use this to resolve their customer_id
 * before validate() runs.
 *
 * Reads back from the DB rather than relying on commit_batch's
 * committed_ids array (which we have, but we don't have the mapping
 * back to the input rows the customer rows came from).
 */
async function buildCustomerIdMap(
  supabase: SupabaseLikeClient,
  tenantId: string,
  intakeId: string,
): Promise<Map<string, string>> {
  // We need (external_id, customer_id) pairs for rows just committed.
  // Cannot use supabase.from("customers") directly — the default Supabase
  // client schema is "public" and customers live in "app_data". The
  // SupabaseLikeClient interface doesn't expose .schema() chaining.
  // Use the SECURITY DEFINER wrapper added in migration 019 instead.
  const map = new Map<string, string>();
  const { data, error } = await supabase.rpc("eq_read_customers_by_intake", {
    p_intake_id: intakeId,
  });
  if (error) {
    throw new Error(`Failed to read back customers for FK resolution: ${(error as { message: string }).message}`);
  }
  for (const row of (data as Array<{ customer_id: string; external_id: string }> | null) ?? []) {
    if (row.external_id) {
      map.set(row.external_id, row.customer_id);
    }
  }
  // Tenant ID is in scope via the original commit, but RLS would scope this
  // automatically. Keeping the unused param for future hardening.
  void tenantId;
  return map;
}

/**
 * Build an external_id → staff UUID map from a freshly-committed staff batch.
 * Licences use this to resolve their staff_id FK before validate() runs.
 * Requires eq_read_staff_by_intake RPC (migration 027).
 */
async function buildStaffIdMap(
  supabase: SupabaseLikeClient,
  intakeId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await supabase.rpc("eq_read_staff_by_intake", {
    p_intake_id: intakeId,
  });
  if (error) {
    throw new Error(`Failed to read back staff for FK resolution: ${(error as { message: string }).message}`);
  }
  for (const row of (data as Array<{ staff_id: string; external_id: string }> | null) ?? []) {
    if (row.external_id) {
      map.set(row.external_id, row.staff_id);
    }
  }
  return map;
}

/**
 * Resolve the staff_id FK for licence rows. The source spreadsheet carries
 * an external staff identifier (payroll number, HR ID, etc.) under
 * `external_staff_id` or `staff_id`. Rows that resolve become `resolved`
 * with `staff_id` stamped as a UUID; unresolvable rows go to `missedIndices`.
 */
function resolveStaffFk(
  rows: Record<string, unknown>[],
  staffIdMap: Map<string, string>,
): { resolved: Record<string, unknown>[]; missedIndices: number[] } {
  const resolved: Record<string, unknown>[] = [];
  const missedIndices: number[] = [];
  rows.forEach((row, idx) => {
    const out = { ...row };
    // Source column might map to `external_staff_id` or arrive as `staff_id`
    // (a non-UUID string before FK resolution). Try both.
    const externalStaffId = String(
      row["external_staff_id"] ?? row["staff_id"] ?? row["payroll_no"] ?? "",
    ).trim();
    if (!externalStaffId) {
      missedIndices.push(idx);
      return;
    }
    // Skip if it's already a UUID (e.g. importing from another EQ extract).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(externalStaffId)) {
      out["staff_id"] = externalStaffId;
      resolved.push(out);
      return;
    }
    const staffId = staffIdMap.get(externalStaffId);
    if (staffId) {
      out["staff_id"] = staffId;
      resolved.push(out);
    } else {
      missedIndices.push(idx);
    }
  });
  return { resolved, missedIndices };
}

/**
 * Apply a customerId map to a list of pre-validation rows. Rows whose
 * external_customer_id resolves to a known UUID are returned in `resolved`
 * with `customer_id` stamped. Rows with no match are tracked in `missedIndices`
 * so the caller can emit them as explicit fk_no_match rejections — never
 * silently passed through to validate() where system-managed field skipping
 * would let them land as valid rows with a null FK.
 */
function resolveCustomerFk(
  rows: Record<string, unknown>[],
  customerIdMap: Map<string, string>,
): { resolved: Record<string, unknown>[]; missedIndices: number[] } {
  const resolved: Record<string, unknown>[] = [];
  const missedIndices: number[] = [];
  rows.forEach((row, idx) => {
    const out = { ...row };
    const externalCustomerId = String(
      row["external_customer_id"] ?? row["simPRO Customer ID"] ?? "",
    ).trim();
    if (!externalCustomerId) {
      // No external customer ID on this row — cannot resolve the FK.
      // Treat as a missed FK so the caller emits an explicit rejection
      // rather than letting the row through with a null customer_id.
      missedIndices.push(idx);
      return;
    }
    // Multi-customer cell: "31, 32, 208" → take the first.
    const firstId = externalCustomerId.split(",")[0]?.trim();
    if (!firstId) {
      // Malformed ID cell — treat as unresolvable FK, same as above.
      // eslint-disable-next-line no-console
      console.error(`resolveCustomerFk: row ${idx} has malformed customer ID cell "${externalCustomerId}" — rejecting.`);
      missedIndices.push(idx);
      return;
    }
    const customerId = customerIdMap.get(firstId);
    if (customerId) {
      out["customer_id"] = customerId;
      resolved.push(out);
    } else {
      missedIndices.push(idx);
    }
  });
  return { resolved, missedIndices };
}

// ---------------------------------------------------------------------------
// Per-entity commit
// ---------------------------------------------------------------------------

interface CommitOneEntityArgs {
  supabase: SupabaseLikeClient;
  entity: CanonicalEntity;
  schema: JsonSchema;
  sheet: ParsedSheet;
  tenantId: string;
  createdBy: string;
  sourceFilename?: string;
  customerIdMap?: Map<string, string>;
  staffIdMap?: Map<string, string>;
  /** Max rows per RPC call. Defaults to 500 on the direct-RPC path. */
  chunkSize?: number;
  /** Progress callback forwarded from CommitOptions. */
  onProgress?: (msg: string) => void;
  /** Forwarded from CommitOptions — see StageCommitFn. */
  stageCommit?: StageCommitFn;
}

// intake-stage.ts hard-caps a single call at 10,000 rows (see intake-stage.ts's
// batch_too_large check). Chunk to that instead of the direct-RPC path's
// smaller default — a stage call is meant to be one shot per entity.
const STAGE_CHUNK_SIZE = 10_000;

async function commitOneEntity(args: CommitOneEntityArgs): Promise<EntityCommitResult> {
  const table = args.schema["x-eq-table"] ?? ENTITY_TABLE[args.entity];
  const schemaVersion = args.schema["x-eq-version"] ?? "1.0.0";

  // Audit-row first — even if validation rejects every row, we want a
  // record that "this intake was attempted at this time".
  let intakeId: string;
  try {
    intakeId = await createIntakeEvent({
      supabase: args.supabase,
      tenantId: args.tenantId,
      createdBy: args.createdBy,
      entity: args.entity,
      schemaVersion,
      sourceFilename: args.sourceFilename,
    });
  } catch (e) {
    return {
      entity: args.entity,
      table,
      intakeId: null,
      committedCount: 0,
      stagedCount: 0,
      flaggedCount: 0,
      rejectedCount: args.sheet.rows.length,
      rejectedRows: [],
      flaggedRows: [],
      fatalError: e instanceof Error ? e.message : String(e),
    };
  }

  // Resolve customer FKs for site/contact before validation. Rows that
  // can't be resolved are separated out and emitted as explicit fk_no_match
  // rejections — they must never reach validate() where x-eq-system-managed
  // on customer_id would let them pass as valid rows with a null FK.
  let preValidatedRows = args.sheet.rows as Record<string, unknown>[];
  const fkMissedRejections: Array<{ source_row_index: number; reasons: string[] }> = [];
  // Maps validate()-array index → original sheet row index (needed after filtering).
  const resolvedToOriginalIndex: number[] = [];

  if ((args.entity === "site" || args.entity === "contact") && args.customerIdMap) {
    const { resolved, missedIndices } = resolveCustomerFk(preValidatedRows, args.customerIdMap);
    const missedSet = new Set(missedIndices);
    for (const idx of missedIndices) {
      const row = preValidatedRows[idx]!;
      const rawId = String(row["external_customer_id"] ?? row["simPRO Customer ID"] ?? "").trim();
      const firstId = rawId.split(",")[0]?.trim() ?? rawId;
      const reason = firstId
        ? `fk_no_match on customer_id: no customer found for ID "${firstId}"`
        : `fk_no_match on customer_id: row has no customer ID — cannot resolve FK`;
      fkMissedRejections.push({
        source_row_index: idx,
        reasons: [reason],
      });
    }
    let cursor = 0;
    for (let i = 0; i < preValidatedRows.length; i++) {
      if (!missedSet.has(i)) resolvedToOriginalIndex[cursor++] = i;
    }
    preValidatedRows = resolved;
  }

  if (args.entity === "licence" && args.staffIdMap) {
    const { resolved, missedIndices } = resolveStaffFk(preValidatedRows, args.staffIdMap);
    const missedSet = new Set(missedIndices);
    for (const idx of missedIndices) {
      const row = preValidatedRows[idx]!;
      const rawId = String(
        row["external_staff_id"] ?? row["staff_id"] ?? row["payroll_no"] ?? "",
      ).trim();
      const reason = rawId
        ? `fk_no_match on staff_id: no staff found for ID "${rawId}"`
        : `fk_no_match on staff_id: row has no staff identifier — cannot resolve FK`;
      fkMissedRejections.push({
        source_row_index: idx,
        reasons: [reason],
      });
    }
    let cursor = resolvedToOriginalIndex.length;
    for (let i = 0; i < preValidatedRows.length; i++) {
      if (!missedSet.has(i)) resolvedToOriginalIndex[cursor++] = i;
    }
    preValidatedRows = resolved;
  }

  // Remap validate() source_row_index back to original sheet index.
  const remapIdx = (i: number): number =>
    resolvedToOriginalIndex.length > 0 ? (resolvedToOriginalIndex[i] ?? i) : i;

  // Header → canonical field mapping via x-eq-source-aliases.
  // Add `customer_id` as an identity mapping if we just stamped it during
  // resolveCustomerFk (it's not in the source headers but is in the row).
  const mapping = inferMapping(args.sheet.headerRow, args.schema);
  if (
    (args.entity === "site" || args.entity === "contact") &&
    !Object.values(mapping).includes("customer_id") &&
    preValidatedRows.some((r) => r["customer_id"] !== undefined)
  ) {
    mapping["customer_id"] = "customer_id";
  }

  // validate() against the canonical schema. We turn off allowNonCurrentSchema
  // because we just wrote the schema to the DB; the schema we have IS current.
  let validationResult;
  try {
    validationResult = await validate({
      schema: args.schema as unknown as Parameters<typeof validate>[0]["schema"],
      mapping,
      rows: preValidatedRows,
      tenantId: args.tenantId,
      allowNonCurrentSchema: true, // demo intake — don't fight the schema registry yet
    });
  } catch (e) {
    await finishIntakeEvent({
      supabase: args.supabase,
      intakeId,
      status: "failed",
      rowsCommitted: 0,
      rowsFlagged: 0,
      rowsRejected: args.sheet.rows.length,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return {
      entity: args.entity,
      table,
      intakeId,
      committedCount: 0,
      stagedCount: 0,
      flaggedCount: 0,
      rejectedCount: args.sheet.rows.length,
      rejectedRows: [],
      flaggedRows: [],
      fatalError: e instanceof Error ? e.message : String(e),
    };
  }

  type _ValidLike   = { canonical: Record<string, unknown> };
  type _FlaggedLike = { source_row_index: number; canonical: Record<string, unknown>; flags: Parameters<typeof formatFlag>[0][] };
  type _RejectedLike = { source_row_index: number; errors: Parameters<typeof formatValidationError>[0][] };

  const toCommit: Record<string, unknown>[] = [
    ...(validationResult.valid_rows as _ValidLike[]).map((r) => r.canonical),
    ...(validationResult.flagged_rows as _FlaggedLike[]).map((r) => r.canonical),
  ];

  if (toCommit.length === 0) {
    await finishIntakeEvent({
      supabase: args.supabase,
      intakeId,
      status: "completed",
      rowsCommitted: 0,
      rowsFlagged: validationResult.summary.flagged,
      rowsRejected: validationResult.summary.rejected + fkMissedRejections.length,
    });
    return {
      entity: args.entity,
      table,
      intakeId,
      committedCount: 0,
      stagedCount: 0,
      flaggedCount: validationResult.summary.flagged,
      rejectedCount: validationResult.summary.rejected + fkMissedRejections.length,
      rejectedRows: [
        ...fkMissedRejections,
        ...(validationResult.rejected_rows as _RejectedLike[]).map((r) => ({
          source_row_index: remapIdx(r.source_row_index),
          reasons: r.errors.map(formatValidationError),
        })),
      ],
      flaggedRows: (validationResult.flagged_rows as _FlaggedLike[]).map((r) => ({
        source_row_index: remapIdx(r.source_row_index),
        reasons: r.flags.map(formatFlag),
        field: r.flags[0]?.field,
      })),
    };
  }

  // Chunked calls — split toCommit into batches. A failure in one chunk emits
  // those rows as rejected and continues with the remaining chunks,
  // preserving partial progress instead of rolling back everything.
  const useStaging = !!args.stageCommit;
  const CHUNK_SIZE = useStaging ? STAGE_CHUNK_SIZE : (args.chunkSize ?? 500);
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < toCommit.length; i += CHUNK_SIZE) {
    chunks.push(toCommit.slice(i, i + CHUNK_SIZE));
  }

  let committedCount = 0;
  let stagedCount = 0;
  const chunkFailRejections: Array<{ source_row_index: number; reasons: string[] }> = [];
  let firstFatalError: string | undefined;
  // committed_ids for every entry in toCommit, direct-RPC path only (staged
  // rows never get a canonical id here — see StageCommitResult's doc comment).
  // Stays undefined for a row when a chunk's returned id array didn't match
  // that chunk's length — see the length check below for why.
  const committedIds: (string | undefined)[] = new Array(toCommit.length).fill(undefined);

  const progress = args.onProgress ?? (() => undefined);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    if (chunks.length > 1) {
      progress(
        `Saving ${table} — chunk ${ci + 1} of ${chunks.length} (${chunk.length} rows)…`,
      );
    }

    if (useStaging) {
      // Route through the same health/conflict gate the per-domain importer
      // uses instead of writing straight to the table — flagged/conflicting
      // rows park in the review queue rather than committing unreviewed.
      try {
        const staged = await args.stageCommit!({
          table,
          entity: args.entity,
          rows: chunk,
          intakeId,
          schemaVersion,
          sourceFilename: args.sourceFilename,
        });
        committedCount += staged.committed_count;
        stagedCount += staged.staged_count;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!firstFatalError) firstFatalError = message;
        const startIdx = ci * CHUNK_SIZE;
        for (let ri = 0; ri < chunk.length; ri++) {
          chunkFailRejections.push({
            source_row_index: remapIdx(startIdx + ri),
            reasons: [`Stage call failed: ${message}`],
          });
        }
      }
      continue;
    }

    const { data, error } = await args.supabase.rpc("eq_intake_commit_batch", {
      p_intake_id: intakeId,
      p_tenant_id: args.tenantId,
      p_table: table,
      p_rows: chunk,
    });

    const startIdx = ci * CHUNK_SIZE;

    if (error) {
      // This chunk failed — record the rows as rejected but continue with the
      // next chunk. The original row indices for this chunk span
      // [ci * CHUNK_SIZE, ci * CHUNK_SIZE + chunk.length).
      if (!firstFatalError) firstFatalError = error.message;
      for (let ri = 0; ri < chunk.length; ri++) {
        chunkFailRejections.push({
          source_row_index: remapIdx(startIdx + ri),
          reasons: [`Commit chunk failed: ${error.message}`],
        });
      }
    } else {
      const rpcRow = Array.isArray(data)
        ? (data[0] as { committed_count?: number; committed_ids?: string[] } | undefined)
        : undefined;
      committedCount += rpcRow?.committed_count ?? chunk.length;

      // eq_intake_commit_batch_* builds committed_ids by looping p_rows in
      // order and array_append-ing each row's id (sql/008_decompose_intake_
      // commit_batch.sql) — same order as the chunk we sent, so a straight
      // positional zip is safe. Only trust it when the lengths match: a
      // short array (the SQL only appends when a row's id came back non-null)
      // means we can no longer say which id belongs to which row, and a wrong
      // guess would point "Fix" at someone else's record.
      const ids = rpcRow?.committed_ids;
      if (ids && ids.length === chunk.length) {
        for (let ri = 0; ri < chunk.length; ri++) {
          committedIds[startIdx + ri] = ids[ri];
        }
      }
    }
  }

  const totalChunkRejected = chunkFailRejections.length;

  const totalRejected =
    validationResult.summary.rejected + fkMissedRejections.length + totalChunkRejected;

  // On the staging path, intake-stage.ts already finalised the event
  // (status: pending_review or completed) as part of the call that
  // succeeded — calling eq_finish_intake_event again here would stomp that
  // with a stale "completed". Only finalise ourselves when either the
  // direct-RPC path was used, or every stage call actually failed (so
  // intake-stage never got a chance to finalise it).
  if (!useStaging || (firstFatalError && committedCount === 0 && stagedCount === 0)) {
    await finishIntakeEvent({
      supabase: args.supabase,
      intakeId,
      status: firstFatalError && committedCount === 0 && stagedCount === 0 ? "failed" : "completed",
      rowsCommitted: committedCount,
      rowsFlagged: validationResult.summary.flagged,
      rowsRejected: totalRejected,
      errorMessage: firstFatalError,
    });
  }

  return {
    entity: args.entity,
    table,
    intakeId,
    stagedCount,
    committedCount,
    flaggedCount: validationResult.summary.flagged,
    rejectedCount: totalRejected,
    rejectedRows: [
      ...fkMissedRejections,
      ...(validationResult.rejected_rows as _RejectedLike[]).map((r) => ({
        source_row_index: remapIdx(r.source_row_index),
        reasons: r.errors.map(formatValidationError),
      })),
      ...chunkFailRejections,
    ],
    flaggedRows: (validationResult.flagged_rows as _FlaggedLike[]).map((r, i) => ({
      source_row_index: remapIdx(r.source_row_index),
      reasons: r.flags.map(formatFlag),
      field: r.flags[0]?.field,
      // Flagged rows are the tail of toCommit, after all valid rows — see
      // where toCommit is built above.
      recordId: committedIds[(validationResult.valid_rows as _ValidLike[]).length + i],
    })),
    fatalError: firstFatalError && committedCount === 0 ? firstFatalError : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fallback for hosts that don't supply CommitOptions.createdBy — resolves the
 * current user from the Supabase client's own Auth session. Only works when
 * that client actually has one (e.g. the demo's mock client, which fakes
 * auth.getUser() unconditionally); EQ Shell's real tenant-data clients never
 * do, so EQ Shell must always supply createdBy explicitly instead.
 */
async function resolveCreatedByFromAuthSession(supabase: SupabaseLikeClient): Promise<string> {
  const userResp = await supabase.auth.getUser();
  if (userResp.error || !userResp.data.user) {
    throw new Error(
      `Cannot commit canonical without an authenticated user: ${
        userResp.error?.message ?? "no user"
      }`,
    );
  }
  return userResp.data.user.id;
}

export async function commitBundleToCanonical(opts: CommitOptions): Promise<CommitResult> {
  // Resolve the user to stamp as created_by on every intake event. Hosts
  // whose SupabaseLikeClient carries identity via a bearer header instead of
  // a real Supabase Auth session (see CommitOptions.createdBy) must supply it
  // explicitly — auth.getUser() on those clients can never resolve a user.
  const createdBy = opts.createdBy ?? (await resolveCreatedByFromAuthSession(opts.supabase));

  const perEntity: EntityCommitResult[] = [];
  let customerIdMap: Map<string, string> | undefined;
  let staffIdMap: Map<string, string> | undefined;
  let bundleSuccess = true;

  const progress = opts.onProgress ?? (() => undefined);
  const entityLabels: Record<CanonicalEntity, string> = {
    customer: "customers",
    site: "sites",
    contact: "contacts",
    staff: "staff",
    licence: "licences",
  };

  for (const entity of COMMIT_ORDER) {
    const sheet = opts.bundle[entity];
    if (!sheet) continue;
    const schema = opts.schemas?.[entity] ?? CANONICAL_SCHEMAS[entity];
    const label = entityLabels[entity];
    const rowCount = sheet.rows.length;

    progress(`Reading ${label} (${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"})…`);

    const result = await commitOneEntity({
      supabase: opts.supabase,
      entity,
      schema,
      sheet,
      tenantId: opts.tenantId,
      createdBy,
      sourceFilename: opts.sourceFilename,
      customerIdMap,
      staffIdMap,
      chunkSize: opts.chunkSize,
      onProgress: opts.onProgress,
      stageCommit: opts.stageCommit,
    });
    perEntity.push(result);

    if (result.fatalError) {
      progress(`Failed on ${label}: ${result.fatalError}`);
      bundleSuccess = false;
      // Stop the bundle early — later entities depend on earlier ones via FK.
      break;
    }

    const parts: string[] = [`${result.committedCount} saved`];
    if (result.stagedCount > 0) parts.push(`${result.stagedCount} waiting for review`);
    if (result.flaggedCount > 0) parts.push(`${result.flaggedCount} need checking`);
    if (result.rejectedCount > 0) parts.push(`${result.rejectedCount} rejected`);
    progress(`${label.charAt(0).toUpperCase() + label.slice(1)} done — ${parts.join(", ")}.`);

    // Build the FK lookup for sites + contacts whenever any customer row was
    // attempted — not just when some committed. On the staging path a batch
    // can land entirely in review (committedCount 0, stagedCount > 0); if we
    // skipped this, customerIdMap would stay undefined, resolveCustomerFk
    // would never run for the dependent rows below, and their raw
    // external_customer_id would reach validate() unresolved — where
    // x-eq-system-managed on customer_id could let a null FK pass as valid.
    // Building the map here (even when it comes back empty) keeps that gate
    // in force, so unresolvable dependents get an explicit fk_no_match
    // rejection instead of a silent null FK.
    if (entity === "customer" && (result.committedCount > 0 || result.stagedCount > 0) && result.intakeId) {
      progress("Building customer links for sites and contacts…");
      try {
        customerIdMap = await buildCustomerIdMap(
          opts.supabase,
          opts.tenantId,
          result.intakeId,
        );
      } catch (e) {
        // FK map failed — mark bundle as failed so the caller knows downstream
        // entities (sites, contacts) will have missing FK rejections.
        bundleSuccess = false;
        // eslint-disable-next-line no-console
        console.error(
          `Failed to build customer FK map: ${e instanceof Error ? e.message : String(e)}`,
        );
        customerIdMap = new Map();
      }
    }

    // Same reasoning as the customer map above — build it whenever staff was
    // attempted, not just when some committed.
    if (entity === "staff" && (result.committedCount > 0 || result.stagedCount > 0) && result.intakeId) {
      progress("Building staff links for licences…");
      try {
        staffIdMap = await buildStaffIdMap(opts.supabase, result.intakeId);
      } catch (e) {
        bundleSuccess = false;
        // eslint-disable-next-line no-console
        console.error(
          `Failed to build staff FK map: ${e instanceof Error ? e.message : String(e)}`,
        );
        staffIdMap = new Map();
      }
    }
  }

  progress(bundleSuccess ? "All done." : "Finished with errors — check the results below.");
  return { bundleSuccess, perEntity };
}
