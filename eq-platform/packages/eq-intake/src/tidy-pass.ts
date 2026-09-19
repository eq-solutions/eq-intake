/**
 * @eq/intake — tidy-pass engine
 *
 * runTidyPass()    — reads all canonical rows for an entity, runs them through
 *                    @eq/validation, diffs original vs normalised values, and
 *                    produces a TidyReport (auto-fixes + gaps + review flags).
 *
 * commitTidyFixes() — takes the user-approved subset of TidyFix[] and writes
 *                     the corrections back to canonical via eq_tidy_commit_fixes
 *                     RPC. Creates an intake_id audit trail so the tidy pass
 *                     appears in the audit log and is rollback-able.
 *
 * This module is deliberately stateless — it produces reports and commits in
 * response to explicit calls. No background workers.
 */

import { validate } from '@eq/validation';
import type { ValidationError, Flag } from '@eq/validation';

import customerSchema from '@eq/schemas/schemas/customer.schema.json';
import siteSchema     from '@eq/schemas/schemas/site.schema.json';
import contactSchema  from '@eq/schemas/schemas/contact.schema.json';
import staffSchema    from '@eq/schemas/schemas/staff.schema.json';
import licenceSchema  from '@eq/schemas/schemas/licence.schema.json';

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';
import type {
  TidyEntity,
  TidyFix,
  TidyFixType,
  GapItem,
  ReviewFlag,
  TidyReport,
  TidyPassOpts,
  TidyCommitOpts,
  TidyCommitResult,
} from './tidy-types.js';

export { TIDY_ENTITY_TABLES } from './tidy-types.js';

// ---------------------------------------------------------------------------
// Schema registry for tidy pass
// ---------------------------------------------------------------------------

const SCHEMAS: Partial<Record<TidyEntity, unknown>> = {
  customer: customerSchema,
  site:     siteSchema,
  contact:  contactSchema,
  staff:    staffSchema,
  licence:  licenceSchema,
  // assets schema is not yet in @eq/schemas — skip for now
};

const ENTITY_TABLES: Record<TidyEntity, string> = {
  customer: 'customers',
  site:     'sites',
  contact:  'contacts',
  staff:    'staff',
  licence:  'licences',
  asset:    'assets',
};

/**
 * Schema-declared enum values for a field, if any. Used to render a closed
 * dropdown instead of a free-text input — independent of whether a gap
 * currently exists for that field (e.g. a blank required enum field should
 * still get a dropdown, not just a value that failed enum validation).
 */
export function getFieldEnumValues(entity: TidyEntity, field: string): string[] | null {
  const schema = SCHEMAS[entity] as { properties?: Record<string, { enum?: string[] }> } | undefined;
  const enumValues = schema?.properties?.[field]?.enum;
  return enumValues && enumValues.length > 0 ? enumValues : null;
}

/**
 * Schema-declared suggested values for a field, if any (`x-eq-suggested-
 * values` — a free-text field with a controlled-but-not-enforced vocabulary,
 * e.g. staff.trade). Unlike getFieldEnumValues this isn't a closed set the
 * validator enforces, just a code-level default list a caller can offer as
 * the starting point before any tenant customization.
 */
export function getFieldSuggestedValues(entity: TidyEntity, field: string): string[] | null {
  const schema = SCHEMAS[entity] as { properties?: Record<string, { 'x-eq-suggested-values'?: string[] }> } | undefined;
  const values = schema?.properties?.[field]?.['x-eq-suggested-values'];
  return values && values.length > 0 ? values : null;
}

// Fields used to build a human-readable row label for display.
// Uses actual DB column names (not schema aliases).
const ROW_LABEL_FIELDS: Record<TidyEntity, string[]> = {
  customer: ['company_name', 'email'],
  site:     ['name', 'suburb'],
  contact:  ['first_name', 'last_name', 'email'],
  staff:    ['first_name', 'last_name', 'email'],
  licence:  ['licence_type', 'licence_number'],
  asset:    ['name', 'asset_type', 'serial_number'],
};

// Primary key column name per entity table
const PK_FIELD: Record<TidyEntity, string> = {
  customer: 'customer_id',
  site:     'site_id',
  contact:  'contact_id',
  staff:    'staff_id',
  licence:  'licence_id',
  asset:    'asset_id',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowLabel(row: Record<string, unknown>, entity: TidyEntity): string {
  // For entities with split name fields, try combining first+last
  if (entity === 'contact' || entity === 'staff') {
    const first = stringify(row['first_name']).trim();
    const last  = stringify(row['last_name']).trim();
    const full  = `${first} ${last}`.trim();
    if (full) return full;
  }
  const candidates = ROW_LABEL_FIELDS[entity];
  for (const field of candidates) {
    const v = row[field];
    if (v && typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'Unknown';
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Snake_case → Title Case. Local to this module — avoids the tidy engine depending on the demo-UI label registry. */
function prettyField(field: string): string {
  return field
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Turn a structural ValidationError into a plain-English sentence. The
 * validator itself never builds messages for these (only cross_field_error
 * carries author-supplied text) — without this, the UI fell back to the raw
 * `.kind` code (e.g. "field_required") verbatim.
 */
function describeValidationError(e: ValidationError): string {
  if ('message' in e && e.message) return e.message;
  const f = 'field' in e ? prettyField(e.field) : 'This field';
  switch (e.kind) {
    case 'field_required':         return `${f} is required.`;
    case 'field_type_mismatch':    return `${f} should be a ${e.expected}.`;
    case 'field_format_invalid':   return `${f} isn't a valid ${e.format}.`;
    case 'field_enum_invalid':     return `"${String(e.value)}" isn't a recognised value for ${f}. Allowed: ${e.allowed.join(', ')}.`;
    case 'field_pattern_mismatch': return `${f} doesn't match the expected format.`;
    case 'field_out_of_range':
      if (e.min !== undefined && e.max !== undefined) return `${f} should be between ${e.min} and ${e.max}.`;
      if (e.min !== undefined) return `${f} should be at least ${e.min}.`;
      return `${f} should be at most ${e.max}.`;
    case 'field_length_invalid':
      if (e.min !== undefined && e.max !== undefined) return `${f} should be between ${e.min} and ${e.max} characters.`;
      if (e.min !== undefined) return `${f} should be at least ${e.min} characters.`;
      return `${f} should be at most ${e.max} characters.`;
    case 'fk_no_match':            return `${f} doesn't match an existing record.`;
    case 'date_ambiguous_strict':  return `${f} — the date format is ambiguous.`;
    case 'coerce_failed':          return e.reason;
    case 'cap_exceeded':           return e.reason;
    default:                       return `${f}: please check this value.`;
  }
}

/** Same idea as describeValidationError(), for the review-flag path. */
function describeFlag(flag: Flag): string {
  if ('message' in flag && flag.message) return flag.message;
  const f = 'field' in flag ? prettyField(flag.field) : 'This field';
  switch (flag.kind) {
    case 'phone_kept_raw': return `${f} couldn't be normalised automatically — kept as entered.`;
    case 'date_ambiguous': return `${f} — the date could be read more than one way; please confirm.`;
    case 'value_unusual':  return `${f}: ${flag.reason}`;
    default:                return `${f}: please review.`;
  }
}

/**
 * Infer what kind of fix a field change represents based on field name.
 * Crude heuristic — good enough for display bucketing.
 */
function inferFixType(field: string): TidyFixType {
  if (field.includes('phone'))  return 'phone';
  if (field === 'state' || field.includes('_state')) return 'au_state';
  if (field === 'email')        return 'email';
  if (field === 'abn' || field === 'acn') return 'abn';
  if (field.includes('date') || field.includes('_at') || field.includes('_on'))
    return 'date';
  if (field === 'active' || field.startsWith('is_')) return 'boolean';
  return 'other';
}

// Fields that are system-managed and should not be compared (they change on
// every intake commit and are not user-facing data quality issues).
const SYSTEM_FIELDS = new Set([
  'tenant_id', 'intake_id', 'imported_at', 'imported_from',
  'schema_version', 'created_at', 'updated_at',
  'customer_id', 'site_id', 'staff_id', 'contact_id', 'licence_id', 'asset_id',
  'parent_asset_id',
]);

// ---------------------------------------------------------------------------
// Per-entity tidy scan
// ---------------------------------------------------------------------------

interface EntityScanResult {
  entity:       TidyEntity;
  rowsScanned:  number;
  autoFixes:    TidyFix[];
  gaps:         GapItem[];
  reviewFlags:  ReviewFlag[];
}

async function scanEntity(
  supabase: SupabaseLikeClient,
  entity: TidyEntity,
  tenantId: string,
  onProgress?: (msg: string) => void,
): Promise<EntityScanResult> {
  const table = ENTITY_TABLES[entity];
  const schema = SCHEMAS[entity];

  if (!schema) {
    // Asset schema not yet in package — skip silently
    return { entity, rowsScanned: 0, autoFixes: [], gaps: [], reviewFlags: [] };
  }

  onProgress?.(`Scanning ${table}…`);

  // Read all rows via the tidy read RPC
  const { data, error } = await supabase.rpc('eq_tidy_read_entity', {
    p_table: table,
  });

  if (error) {
    throw new Error(`eq_tidy_read_entity(${table}) failed: ${error.message}`);
  }

  const rows = (data as Record<string, unknown>[] | null) ?? [];
  onProgress?.(`${table}: ${rows.length} rows read, validating…`);

  const autoFixes:   TidyFix[]    = [];
  const gaps:        GapItem[]    = [];
  const reviewFlags: ReviewFlag[] = [];

  // Build an identity mapping: each canonical field name maps to itself.
  // validate() will run coercions and return normalised canonical values.
  const schemaProps = (schema as { properties: Record<string, unknown> }).properties ?? {};
  const identityMapping: Record<string, string> = {};
  for (const field of Object.keys(schemaProps)) {
    identityMapping[field] = field;
  }

  // Run validation in one batch call (pure in-memory — no DB calls needed
  // because FK resolution is skipped; we're validating field values only).
  let result;
  try {
    result = await validate({
      schema:               schema as Parameters<typeof validate>[0]['schema'],
      mapping:              identityMapping,
      rows,
      tenantId,
      allowNonCurrentSchema: true,
      // Disable FK lookups — we're only checking field normalisation here,
      // not relational integrity (orphan-check handles that separately).
      fkLookup: {
        list:  async () => [],
        byId:  async () => null,
      },
    });
  } catch (e) {
    throw new Error(
      `Validation scan failed for ${table}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const pkField = PK_FIELD[entity];

  // --- valid_rows: no errors, but may have been coerced ---
  type ValidLike = { source_row_index: number; canonical: Record<string, unknown> };
  for (const vrow of result.valid_rows as ValidLike[]) {
    const original = rows[vrow.source_row_index] as Record<string, unknown>;
    if (!original) continue;

    const rowId    = stringify(original[pkField]);
    const label    = rowLabel(original, entity);

    for (const [field, newVal] of Object.entries(vrow.canonical)) {
      if (SYSTEM_FIELDS.has(field)) continue;
      const oldRaw = stringify(original[field]);
      const newRaw = stringify(newVal);
      if (oldRaw !== newRaw && newRaw !== '') {
        autoFixes.push({
          entity,
          table,
          row_id:    rowId,
          row_label: label,
          field,
          fix_type:  inferFixType(field),
          old_value: oldRaw,
          new_value: newRaw,
        });
      }
    }
  }

  // --- flagged_rows: coercion succeeded but has flags (phone_kept_raw, date_ambiguous…) ---
  type FlaggedLike = {
    source_row_index: number;
    canonical:        Record<string, unknown>;
    flags:            Flag[];
  };
  for (const frow of result.flagged_rows as FlaggedLike[]) {
    const original = rows[frow.source_row_index] as Record<string, unknown>;
    if (!original) continue;

    const rowId    = stringify(original[pkField]);
    const label    = rowLabel(original, entity);

    // Coercion diffs (same logic as valid_rows above)
    for (const [field, newVal] of Object.entries(frow.canonical)) {
      if (SYSTEM_FIELDS.has(field)) continue;
      const oldRaw = stringify(original[field]);
      const newRaw = stringify(newVal);
      if (oldRaw !== newRaw && newRaw !== '') {
        autoFixes.push({
          entity, table, row_id: rowId, row_label: label,
          field,
          fix_type:  inferFixType(field),
          old_value: oldRaw,
          new_value: newRaw,
        });
      }
    }

    // Surface flags as review items (need human attention)
    for (const flag of frow.flags) {
      const flagField = ('field' in flag && flag.field) || 'row';
      if (SYSTEM_FIELDS.has(flagField)) continue;
      reviewFlags.push({
        entity, table, row_id: rowId, row_label: label,
        field:     flagField,
        flag_type: flag.kind as ReviewFlag['flag_type'],
        message:   describeFlag(flag),
      });
    }
  }

  // --- rejected_rows: validation errors → gaps ---
  type RejectedLike = {
    source_row_index: number;
    errors:           ValidationError[];
  };
  for (const rrow of result.rejected_rows as RejectedLike[]) {
    const original = rows[rrow.source_row_index] as Record<string, unknown>;
    if (!original) continue;

    const rowId = stringify(original[pkField]);
    const label = rowLabel(original, entity);

    for (const e of rrow.errors) {
      const field = ('field' in e && e.field) || 'row';
      if (SYSTEM_FIELDS.has(field)) continue;

      let gapType: GapItem['gap_type'] = 'format_invalid';
      if (e.kind === 'field_required') gapType = 'required_missing';
      if (e.kind === 'fk_no_match')    gapType = 'fk_no_match';

      gaps.push({
        entity, table, row_id: rowId, row_label: label,
        field,
        gap_type: gapType,
        message:  describeValidationError(e),
        allowed_values: e.kind === 'field_enum_invalid' ? e.allowed : getFieldEnumValues(entity, field) ?? undefined,
      });
    }
  }

  onProgress?.(
    `${table}: ${autoFixes.length} fixes, ${gaps.length} gaps, ${reviewFlags.length} flags`,
  );

  return {
    entity,
    rowsScanned: rows.length,
    autoFixes,
    gaps,
    reviewFlags,
  };
}

// ---------------------------------------------------------------------------
// Public: runTidyPass
// ---------------------------------------------------------------------------

const DEFAULT_ENTITIES: TidyEntity[] = [
  'customer', 'site', 'contact', 'staff', 'licence',
];

export async function runTidyPass(opts: TidyPassOpts): Promise<TidyReport> {
  const entities = opts.entities ?? DEFAULT_ENTITIES;
  const progress = opts.onProgress ?? (() => undefined);

  progress('Starting tidy pass…');

  const allFixes:   TidyFix[]    = [];
  const allGaps:    GapItem[]    = [];
  const allFlags:   ReviewFlag[] = [];
  let   totalRows = 0;

  for (const entity of entities) {
    const scan = await scanEntity(
      opts.supabase,
      entity,
      opts.tenantId,
      progress,
    );
    allFixes.push(...scan.autoFixes);
    allGaps.push(...scan.gaps);
    allFlags.push(...scan.reviewFlags);
    totalRows += scan.rowsScanned;
  }

  progress('Tidy scan complete.');

  return {
    generated_at:  new Date().toISOString(),
    tenant_id:     opts.tenantId,
    auto_fixes:    allFixes,
    gaps:          allGaps,
    orphans:       [],   // caller merges orphan-check result into this
    review_flags:  allFlags,
    summary: {
      total_rows_scanned:  totalRows,
      auto_fixes_found:    allFixes.length,
      gaps_found:          allGaps.length,
      orphans_found:       0,
      review_flags_found:  allFlags.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Public: commitTidyFixes
// ---------------------------------------------------------------------------

export async function commitTidyFixes(opts: TidyCommitOpts): Promise<TidyCommitResult> {
  if (opts.fixes.length === 0) {
    return { intakeId: null, applied: 0, skipped: 0, errors: [] };
  }

  const progress = opts.onProgress ?? (() => undefined);
  progress(`Committing ${opts.fixes.length} fix${opts.fixes.length === 1 ? '' : 'es'}…`);

  // Local correlation id only — eq_create_intake_event/eq_finish_intake_event
  // (the audit-trail wrappers this used to call before and after the real
  // commit) were dropped from every tenant plane 2026-05-24; see
  // commit-canonical.ts's top-of-file comment for the full history. The
  // pre-commit auth.getUser() check existed solely to supply that dead call's
  // p_created_by — EQ Shell's real tenant client never carries a Supabase
  // Auth session (identity rides a proxied bearer header instead), so that
  // check unconditionally threw "Session expired" in production regardless
  // of whether the user was actually signed in.
  const intakeId = crypto.randomUUID();

  // Shape fixes into the RPC payload
  const rpcFixes = opts.fixes.map((f) => ({
    table:     f.table,
    row_id:    f.row_id,
    field:     f.field,
    new_value: f.new_value,
  }));

  const { data, error } = await opts.supabase.rpc('eq_tidy_commit_fixes', {
    p_intake_id: intakeId,
    p_fixes:     JSON.stringify(rpcFixes),
  });

  const errors: TidyCommitResult['errors'] = [];

  if (error) {
    throw new Error(`eq_tidy_commit_fixes failed: ${error.message}`);
  }

  const rpcResult = data as { applied: number; skipped: number } | null;
  const applied = rpcResult?.applied ?? 0;
  const skipped = rpcResult?.skipped ?? 0;

  progress(`Done — ${applied} fixed, ${skipped} skipped.`);

  return { intakeId, applied, skipped, errors };
}
