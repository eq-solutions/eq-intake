/**
 * @eq/intake — natural language query over canonical data
 *
 * askCanonical() sends a plain-English question to the eq-ai-assist Edge
 * Function. Claude Haiku interprets the question and returns a structured
 * "intent" describing which entity to query and which filters to apply.
 * The client then fetches the entity rows and applies the filters locally —
 * no raw SQL is executed server-side, no schema is exposed to the model.
 *
 * Examples:
 *   "Which staff have no trade?"
 *   → { entity: 'staff', filters: [{ field: 'trade', op: 'is_null' }], ... }
 *
 *   "Customers in NSW without an ABN"
 *   → { entity: 'customers', filters: [{ field: 'state', op: 'eq', value: 'NSW' },
 *                                       { field: 'abn', op: 'is_null' }], ... }
 */

import type { EdgeFnCaller } from './ai-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterOp =
  | 'is_null'
  | 'is_not_null'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'lt';

export interface AskFilter {
  field: string;
  op:    FilterOp;
  value?: unknown;
}

export interface AskIntent {
  entity:          string;
  filters:         AskFilter[];
  display_columns: string[];
  description:     string;
}

export interface AskResult {
  question:    string;
  intent:      AskIntent;
  rows:        Record<string, unknown>[];
  total:       number;
}

// ---------------------------------------------------------------------------
// Client-side filter application
// ---------------------------------------------------------------------------

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return typeof v === 'string' && v.trim() === '';
}

function applyFilter(row: Record<string, unknown>, f: AskFilter): boolean {
  const v = row[f.field];
  switch (f.op) {
    case 'is_null':       return isBlank(v);
    case 'is_not_null':   return !isBlank(v);
    case 'eq':            return String(v ?? '').toLowerCase() === String(f.value ?? '').toLowerCase();
    case 'neq':           return String(v ?? '').toLowerCase() !== String(f.value ?? '').toLowerCase();
    case 'contains':      return String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
    case 'not_contains':  return !String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
    case 'gt':            return Number(v) > Number(f.value);
    case 'lt':            return Number(v) < Number(f.value);
    default:              return true;
  }
}

/** Exported so callers with their own row set (e.g. EntityDrillDown, re-applying
 * an Ask question's filters after the user drills into an entity) can reuse
 * the exact same filter semantics instead of reimplementing them. */
export function applyFilters(
  rows: Record<string, unknown>[],
  filters: AskFilter[],
): Record<string, unknown>[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => applyFilter(row, f)));
}

// ---------------------------------------------------------------------------
// Public: askCanonical
// ---------------------------------------------------------------------------

/**
 * @param question      The natural language question from the user.
 * @param callEdgeFn    Injected Edge Function caller (see ai-client.ts).
 * @param fetchEntity   Async function that returns all rows for a given entity
 *                      (typically readEntityColumns with ENTITY_COLUMNS).
 */
export async function askCanonical(
  question:    string,
  callEdgeFn:  EdgeFnCaller,
  fetchEntity: (entity: string) => Promise<Record<string, unknown>[]>,
): Promise<AskResult> {
  // 1. Parse intent via AI
  const response = await callEdgeFn('ask_canonical', { question });

  if (response.error) {
    throw new Error(`Ask canonical failed: ${response.error.message}`);
  }

  const intent = response.data as AskIntent;

  // 2. Fetch entity rows and apply filters client-side
  const allRows = await fetchEntity(intent.entity);
  const filtered = applyFilters(
    allRows.filter((r) => r['active'] !== false),
    intent.filters,
  );

  return {
    question,
    intent,
    rows:  filtered,
    total: filtered.length,
  };
}
