/**
 * @eq/validation — main orchestrator
 *
 * The public API. Takes a JSON Schema, a column mapping, raw rows, and a
 * tenant context. Coerces, validates, resolves FKs, evaluates cross-field
 * rules. Returns committed-ready rows + flagged rows + rejected rows.
 *
 * This is the function called by every intake pipeline (Cards, Import, Capture).
 */

import { coerceString } from './coerce-string';
import { coerceBoolean } from './coerce-boolean';
import { coerceNumber } from './coerce-number';
import { coerceDate } from './coerce-date';
import { coercePhoneAU } from './coerce-phone-au';
import { coerceAuState } from './coerce-au-state';
import { coerceCountry } from './coerce-country';
import { coerceEnumAlias } from './coerce-enum-alias';
import { resolveFk, FkLookup, FkResolution } from './fk-resolver';
import { compileRule } from './cross-field-eval';
import type { CoerceResult, Locale } from './types';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidateOpts {
  /** Canonical JSON Schema for the target entity */
  schema: any;
  /** Map of source-column → canonical-field. Null canonical means drop the column. */
  mapping: Record<string, string | null>;
  /** Per-column transforms suggested by the AI mapper or chosen by user */
  transformations?: Record<string, TransformSpec>;
  /** Source rows (array of objects keyed by source column name) */
  rows: Record<string, unknown>[];
  /** Tenant for FK lookups + audit */
  tenantId: string;
  /** FK lookup implementation */
  fkLookup?: FkLookup;
  /** Locale for ambiguous coercion */
  locale?: Locale;
  /** Fuzzy match threshold for FK resolution (0-1). Default 0.85. */
  fkFuzzyThreshold?: number;
  /** If true, warnings become errors. Default false. */
  treatWarningsAsErrors?: boolean;
  /** Cap on rows in result (defends against huge inputs). Default 100k. */
  maxRowsToReturn?: number;
  /**
   * Whether the schema passed is the current version for this entity.
   * Set by the caller (typically by checking eq_schema_registry.is_current).
   * Default true.
   */
  isCurrentSchema?: boolean;
  /**
   * If true, validation proceeds even when isCurrentSchema is false.
   * Used by historical re-validation jobs. Default false.
   */
  allowNonCurrentSchema?: boolean;
  /**
   * Pre-computed mapping from a signature-hash cache hit.
   * If supplied, the orchestrator does not need to invoke AI mapping.
   * Caller is responsible for fetching this from eq_intake_templates
   * via eq_intake_find_template_by_signature() before calling validate().
   */
  existingMapping?: { mapping: Record<string, string | null>; transformations?: Record<string, TransformSpec> };
}

export type TransformSpec =
  | { kind: 'split-name'; targets: [string, string] }
  | { kind: 'concat'; sources: string[]; separator: string }
  | { kind: 'currency-strip-aud' }
  | { kind: 'date-au' }
  | { kind: 'date-us' }
  | { kind: 'excel-serial-to-date' }
  | { kind: 'identity' };

export interface ValidationResult {
  valid_rows: ValidRow[];
  flagged_rows: FlaggedRow[];
  rejected_rows: RejectedRow[];
  summary: ValidationSummary;
}

export interface ValidRow {
  source_row_index: number;
  canonical: Record<string, unknown>;
}

export interface FlaggedRow {
  source_row_index: number;
  canonical: Record<string, unknown>;
  flags: Flag[];
}

export interface RejectedRow {
  source_row_index: number;
  raw: Record<string, unknown>;
  errors: ValidationError[];
}

export type Flag =
  | { kind: 'fk_fuzzy_match'; field: string; candidates: any[] }
  | { kind: 'date_ambiguous'; field: string; candidates: string[] }
  | { kind: 'sensitive_field'; field: string }
  | { kind: 'value_unusual'; field: string; reason: string }
  | { kind: 'cross_field_warning'; rule_id: string; message: string }
  | { kind: 'phone_kept_raw'; field: string }
  // Schema-hinted field (x-eq-multi-value) whose raw source cell looks like
  // 2+ delimited values (e.g. "Wollongong, Malabar") rather than one.
  // Advisory only: canonical keeps the raw joined string — nothing splits
  // until the confirm-flow driver sees a split_row resolution for this row.
  | { kind: 'multi_value_candidate'; field: string; values: string[] }
  // Attached post-validation by the confirm-flow driver, not by validate()
  // itself: an AI-suggested value for a field the source left empty.
  | { kind: 'ai_enrichment'; field: string; suggested: unknown; confidence: number; reason: string }
  // Likely duplicate of another row in the batch, or of an existing DB asset.
  | {
      kind: 'duplicate';
      reason: 'serial' | 'external_id_site';
      matchType: 'within_batch' | 'existing';
      key: string;
      duplicateOf?: number;
      existingAssetId?: string;
    };

export type ValidationError =
  | { kind: 'field_required'; field: string }
  | { kind: 'field_type_mismatch'; field: string; expected: string; got: unknown }
  | { kind: 'field_format_invalid'; field: string; format: string }
  | { kind: 'field_enum_invalid'; field: string; value: unknown; allowed: string[] }
  | { kind: 'field_pattern_mismatch'; field: string; pattern: string }
  | { kind: 'field_out_of_range'; field: string; value: number; min?: number; max?: number }
  | { kind: 'field_length_invalid'; field: string; length: number; min?: number; max?: number }
  | { kind: 'cross_field_error'; rule_id: string; message: string }
  | { kind: 'fk_no_match'; field: string; value: unknown }
  | { kind: 'date_ambiguous_strict'; field: string }
  | { kind: 'coerce_failed'; field: string; reason: string }
  | { kind: 'cap_exceeded'; field: string; reason: string };

export interface ValidationSummary {
  total: number;
  valid: number;
  flagged: number;
  rejected: number;
  by_field_errors: Record<string, number>;
}

// ============================================================================
// MAIN
// ============================================================================

export async function validate(opts: ValidateOpts): Promise<ValidationResult> {
  const {
    schema,
    mapping,
    transformations = {},
    rows,
    tenantId,
    fkLookup,
    locale = 'en-AU',
    fkFuzzyThreshold = 0.85,
    treatWarningsAsErrors = false,
    maxRowsToReturn = 100_000,
    isCurrentSchema = true,
    allowNonCurrentSchema = false,
  } = opts;

  if (!schema?.properties) {
    throw new Error('schema.properties is required');
  }

  // Schema currency guard — prevents silent forks against stale schemas.
  // Historical re-validation jobs must opt in explicitly.
  if (!isCurrentSchema && !allowNonCurrentSchema) {
    throw new Error(
      `validate() called against a non-current schema for entity ${schema['x-eq-entity'] ?? '(unknown)'}. ` +
      `Set allowNonCurrentSchema: true if this is intentional (e.g. historical re-validation).`
    );
  }

  // Compile cross-field rules once
  const crossRules: Array<{ id: string; severity: 'error' | 'warning'; message: string; eval: (d: any) => boolean }> = [];
  const xRules = schema['x-eq-cross-field-rules'] ?? [];
  for (const r of xRules) {
    try {
      crossRules.push({
        id: r.id,
        severity: r.severity === 'warning' ? 'warning' : 'error',
        message: r.message,
        eval: compileRule(r.rule),
      });
    } catch (e) {
      // Bad rule in schema — fail loud
      throw new Error(`Invalid cross-field rule ${r.id}: ${(e as Error).message}`);
    }
  }

  const valid_rows: ValidRow[] = [];
  const flagged_rows: FlaggedRow[] = [];
  const rejected_rows: RejectedRow[] = [];
  const by_field_errors: Record<string, number> = {};

  const limit = Math.min(rows.length, maxRowsToReturn);

  for (let rowIdx = 0; rowIdx < limit; rowIdx++) {
    const raw = rows[rowIdx]!;
    const errors: ValidationError[] = [];
    const flags: Flag[] = [];
    const canonical: Record<string, unknown> = {};

    // Apply transformations first (e.g. split-name into first_name + last_name)
    const transformed = applyTransforms(raw, transformations, errors);

    // Build canonical row by applying mapping + per-field coercion
    for (const [sourceCol, canonField] of Object.entries(mapping)) {
      if (canonField == null) continue;

      const fieldSchema = schema.properties[canonField];
      if (!fieldSchema) continue;

      const rawValue = transformed[sourceCol];
      const coerced = coerceField(rawValue, fieldSchema, locale);

      if (!coerced.ok) {
        errors.push({
          kind: 'coerce_failed',
          field: canonField,
          reason: coerced.message,
        });
        countErr(by_field_errors, canonField);
        continue;
      }

      // Capture flags from coercion
      if (coerced.note === 'phone_format_unrecognised_kept_raw') {
        flags.push({ kind: 'phone_kept_raw', field: canonField });
      }

      canonical[canonField] = coerced.value;

      // Sensitive field flag
      if (fieldSchema['x-eq-sensitive']) {
        flags.push({ kind: 'sensitive_field', field: canonField });
      }

      // Multi-value candidate — see the Flag type's own comment for why this
      // stays advisory (flag only) rather than splitting here.
      if (fieldSchema['x-eq-multi-value'] && typeof rawValue === 'string') {
        const segments = rawValue.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (segments.length >= 2) {
          flags.push({ kind: 'multi_value_candidate', field: canonField, values: segments });
        }
      }
    }

    // Apply schema defaults for fields the source didn't provide. This is
    // standard JSON Schema behaviour for the `default` keyword — e.g. `active`
    // defaults to true so a payroll export without an explicit Active column
    // still validates instead of being rejected as missing a required field.
    for (const [fieldName, fieldSchema] of Object.entries<any>(schema.properties)) {
      if (canonical[fieldName] === undefined && fieldSchema && 'default' in fieldSchema) {
        canonical[fieldName] = fieldSchema.default;
      }
    }

    // Required field check
    for (const reqField of schema.required ?? []) {
      const fs = schema.properties[reqField];
      if (fs?.['x-eq-system-managed']) continue;
      if (fs?.['x-eq-required-on-import'] === false) continue;
      if (canonical[reqField] === undefined || canonical[reqField] === null || canonical[reqField] === '') {
        errors.push({ kind: 'field_required', field: reqField });
        countErr(by_field_errors, reqField);
      }
    }

    // FK resolution FIRST — replaces source values like "Equinix SY-3" with the
    // canonical UUID (or null, with a fk_fuzzy_match flag) before the format
    // check runs. Otherwise a fuzzy-matchable source value would fail the
    // format:uuid validator and the row would never reach the FK resolver.
    if (fkLookup) {
      for (const [fieldName, fieldSchema] of Object.entries<any>(schema.properties)) {
        const fkRef = fieldSchema['x-eq-foreign-key'];
        if (!fkRef) continue;
        const v = canonical[fieldName];
        if (v == null || v === '') continue;

        const [entity = ''] = String(fkRef).split('.');
        const fuzzyFields = (fieldSchema['x-eq-fk-fuzzy-match-on'] ?? [])
          .map((f: string) => f.split('.').pop()!);

        const resolution = await resolveFk({
          entity,
          tenantId,
          rawValue: v,
          fuzzyFields,
          threshold: fkFuzzyThreshold,
          lookup: fkLookup,
        });

        applyFkResolution(canonical, fieldName, resolution, errors, flags, by_field_errors);
      }
    }

    // Type / format / enum / pattern / range / length checks — runs on resolved
    // values, so FK fields get checked as the canonical UUID/null, not as the
    // original source string.
    for (const [fieldName, fieldSchema] of Object.entries<any>(schema.properties)) {
      const v = canonical[fieldName];
      if (v === undefined || v === null) continue;
      validateField(fieldName, fieldSchema, v, errors, by_field_errors);
    }

    // Cross-field rules — only if no field-level errors yet (otherwise rules would
    // see partial data and fire confusingly)
    if (errors.length === 0) {
      for (const rule of crossRules) {
        let passed = false;
        try {
          passed = rule.eval(canonical);
        } catch (e) {
          // Rule eval failed (e.g. accessing a missing field) — treat as pass so
          // a broken rule doesn't reject valid data. Log so bad rules are visible.
          passed = true;
          console.warn(`[eq-validation] Rule "${rule.id}" threw during eval — treating as pass.`, e);
        }
        if (!passed) {
          if (rule.severity === 'error' || treatWarningsAsErrors) {
            errors.push({ kind: 'cross_field_error', rule_id: rule.id, message: rule.message });
            countErr(by_field_errors, `_rule:${rule.id}`);
          } else {
            flags.push({ kind: 'cross_field_warning', rule_id: rule.id, message: rule.message });
          }
        }
      }
    }

    // Bucket the row
    if (errors.length > 0) {
      rejected_rows.push({ source_row_index: rowIdx, raw, errors });
    } else if (flags.length > 0) {
      flagged_rows.push({ source_row_index: rowIdx, canonical, flags });
    } else {
      valid_rows.push({ source_row_index: rowIdx, canonical });
    }
  }

  // Rows beyond the cap get a SINGLE summary rejection entry — never silently
  // dropped, but we don't allocate N rejected-row objects just to say the same
  // thing. A 1M-row import would otherwise allocate 900k objects for the cap
  // alone, which defeats the purpose of having a cap.
  if (rows.length > limit) {
    const cappedCount = rows.length - limit;
    rejected_rows.push({
      source_row_index: limit,
      raw: { _note: `${cappedCount.toLocaleString()} rows not processed` },
      errors: [
        {
          kind: 'cap_exceeded',
          field: '_input',
          reason:
            `${cappedCount.toLocaleString()} rows exceed the ${maxRowsToReturn.toLocaleString()}-row ` +
            `limit (rows ${(limit + 1).toLocaleString()}–${rows.length.toLocaleString()} skipped). ` +
            `Split into smaller batches and re-import.`,
        },
      ],
    });
    countErr(by_field_errors, '_cap_exceeded');
  }

  return {
    valid_rows,
    flagged_rows,
    rejected_rows,
    summary: {
      total: rows.length,
      valid: valid_rows.length,
      flagged: flagged_rows.length,
      rejected: rejected_rows.length,
      by_field_errors,
    },
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function countErr(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

function applyTransforms(
  raw: Record<string, unknown>,
  transforms: Record<string, TransformSpec>,
  _errors: ValidationError[]
): Record<string, unknown> {
  const out = { ...raw };
  for (const [sourceCol, spec] of Object.entries(transforms)) {
    const v = raw[sourceCol];
    switch (spec.kind) {
      case 'split-name': {
        if (typeof v === 'string') {
          const parts = v.trim().split(/\s+/);
          if (parts.length >= 2) {
            out[spec.targets[0]] = parts[0];
            out[spec.targets[1]] = parts.slice(1).join(' ');
          } else if (parts.length === 1) {
            out[spec.targets[0]] = parts[0];
            out[spec.targets[1]] = '';
          }
        }
        break;
      }
      case 'concat': {
        const parts: string[] = [];
        for (const s of spec.sources) {
          const val = raw[s];
          if (val != null && val !== '') parts.push(String(val).trim());
        }
        out[sourceCol] = parts.join(spec.separator);
        break;
      }
      case 'currency-strip-aud':
      case 'date-au':
      case 'date-us':
      case 'excel-serial-to-date':
      case 'identity':
        // Handled inline by the coercers — these are hints for coercer behaviour
        break;
    }
  }
  return out;
}

function coerceField(value: unknown, fieldSchema: any, locale: Locale): CoerceResult<unknown> {
  const coerceHint: string | undefined = fieldSchema['x-eq-coerce'];

  if (coerceHint === 'date' || coerceHint === 'datetime') {
    return coerceDate(value, { locale });
  }
  if (coerceHint === 'boolean') {
    return coerceBoolean(value);
  }
  if (coerceHint === 'phone-au') {
    // validate's design: phones are soft-required. Unparseable values get
    // kept raw and bubble up as a `phone_kept_raw` flag (handled below at
    // the `coerced.note === 'phone_format_unrecognised_kept_raw'` branch),
    // so the bookkeeper sees the row in confirm UI and fixes it there.
    // External callers of coercePhoneAU get strict-by-default; validate
    // opts INTO permissive on their behalf.
    return coercePhoneAU(value, { permissive: true });
  }
  if (coerceHint === 'au-state') {
    return coerceAuState(value);
  }
  if (coerceHint === 'country' || coerceHint === 'country-iso-alpha2') {
    return coerceCountry(value);
  }
  if (coerceHint === 'number') {
    return coerceNumber(value);
  }

  // Type-driven defaults
  const types = Array.isArray(fieldSchema.type) ? fieldSchema.type : [fieldSchema.type];

  if (types.includes('boolean')) return coerceBoolean(value);
  if (types.includes('number') || types.includes('integer')) return coerceNumber(value);

  if (types.includes('string')) {
    // Format hints
    if (fieldSchema.format === 'date' || fieldSchema.format === 'date-time') {
      return coerceDate(value, { locale });
    }
    // Enum with aliases
    if (fieldSchema.enum) {
      return coerceEnumAlias(value, {
        allowed: fieldSchema.enum,
        aliases: fieldSchema['x-eq-enum-aliases'],
      });
    }
    return coerceString(value, {
      maxLength: fieldSchema.maxLength,
      onTooLong: 'error',
    });
  }

  // Arrays / objects pass through (assumed already structured from upstream)
  return { ok: true, value, transformed: false };
}

function validateField(
  fieldName: string,
  fieldSchema: any,
  value: unknown,
  errors: ValidationError[],
  byField: Record<string, number>
): void {
  // Empty strings are null-equivalent for format and pattern checks. A CSV
  // cell that's blank for a nullable email/uri/uuid field shouldn't get
  // rejected as "invalid format" — it's "no value", not "wrong value".
  // Length checks still apply so minLength: 1 catches required empties.
  const isEmptyString = value === '';

  // Pattern
  if (fieldSchema.pattern && typeof value === 'string' && !isEmptyString) {
    const re = new RegExp(fieldSchema.pattern);
    if (!re.test(value)) {
      errors.push({ kind: 'field_pattern_mismatch', field: fieldName, pattern: fieldSchema.pattern });
      countErr(byField, fieldName);
    }
  }
  // Format (basic checks for email, uri, uuid)
  if (fieldSchema.format && typeof value === 'string' && !isEmptyString) {
    if (!checkFormat(value, fieldSchema.format)) {
      errors.push({ kind: 'field_format_invalid', field: fieldName, format: fieldSchema.format });
      countErr(byField, fieldName);
    }
  }
  // Number range
  if (typeof value === 'number') {
    if (fieldSchema.minimum != null && value < fieldSchema.minimum) {
      errors.push({ kind: 'field_out_of_range', field: fieldName, value, min: fieldSchema.minimum });
      countErr(byField, fieldName);
    }
    if (fieldSchema.maximum != null && value > fieldSchema.maximum) {
      errors.push({ kind: 'field_out_of_range', field: fieldName, value, max: fieldSchema.maximum });
      countErr(byField, fieldName);
    }
  }
  // String length
  if (typeof value === 'string') {
    if (fieldSchema.minLength != null && value.length < fieldSchema.minLength) {
      errors.push({ kind: 'field_length_invalid', field: fieldName, length: value.length, min: fieldSchema.minLength });
      countErr(byField, fieldName);
    }
    if (fieldSchema.maxLength != null && value.length > fieldSchema.maxLength) {
      errors.push({ kind: 'field_length_invalid', field: fieldName, length: value.length, max: fieldSchema.maxLength });
      countErr(byField, fieldName);
    }
  }
}

function checkFormat(value: string, format: string): boolean {
  switch (format) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
    case 'uri-reference':
      return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value) || /^\//.test(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T/.test(value);
    default:
      return true;
  }
}

function applyFkResolution(
  canonical: Record<string, unknown>,
  field: string,
  res: FkResolution,
  errors: ValidationError[],
  flags: Flag[],
  byField: Record<string, number>
): void {
  if (res.kind === 'exact_id' || res.kind === 'exact_match') {
    canonical[field] = res.id;
  } else if (res.kind === 'fuzzy_matches') {
    flags.push({ kind: 'fk_fuzzy_match', field, candidates: res.candidates });
    // Don't set canonical[field] yet — user must pick from candidates
    canonical[field] = null;
  } else {
    errors.push({ kind: 'fk_no_match', field, value: canonical[field] });
    countErr(byField, field);
  }
}
