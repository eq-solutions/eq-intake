/**
 * Test double for eq_tidy_read_entity_columns that behaves like the real one:
 * returns every requested column the table has (null where the fixture row
 * doesn't set it), withholds PII_COLUMNS unless `canViewPii`, and errors on
 * any other RPC name — so a regression back to the 1-arg eq_tidy_read_entity
 * fails loudly instead of reading as "no rows".
 */

import { ENTITY_COLUMNS, PII_COLUMNS, isEntityTable } from "../src/entity-columns.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

export interface FakeEntityRpcCall {
  table:   string;
  columns: string[];
}

export function fakeEntityRpc(
  tables: Partial<Record<string, Record<string, unknown>[]>>,
  opts: { canViewPii?: boolean; errorFor?: string } = {},
): { client: SupabaseLikeClient; calls: FakeEntityRpcCall[] } {
  const calls: FakeEntityRpcCall[] = [];
  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== "eq_tidy_read_entity_columns") {
        return { data: null, error: { message: `mock: no handler for rpc "${name}"` } };
      }
      const table   = String(params.p_table);
      const columns = params.p_columns as string[];
      calls.push({ table, columns });
      if (opts.errorFor === table) {
        return { data: null, error: { message: `mock: ${table} refused` } };
      }
      if (!isEntityTable(table)) {
        return { data: null, error: { message: `table "${table}" is not allowed` } };
      }
      const pii = new Set(opts.canViewPii ? [] : PII_COLUMNS[table]);
      const visible = columns.filter((c) => ENTITY_COLUMNS[table].includes(c) && !pii.has(c));
      if (visible.length === 0) return { data: [], error: null };
      const rows = (tables[table] ?? []).map((row) =>
        Object.fromEntries(visible.map((c) => [c, row[c] ?? null])),
      );
      return { data: rows, error: null };
    },
  } as unknown as SupabaseLikeClient;
  return { client, calls };
}
