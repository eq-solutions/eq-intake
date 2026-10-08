/**
 * @eq/intake — shared column-projected entity reader
 *
 * Wraps eq_tidy_read_entity_columns (0303_tidy_read_entity_columns.sql) and
 * returns its result — data or error — exactly as the RPC gave it.
 *
 * There used to be a fallback here to the unprojected, 1-arg
 * eq_tidy_read_entity on ANY error, for tenants the projected RPC hadn't
 * reached yet. Removed 2026-10-09: verified live that every active tenant
 * data plane (eq/zaap, sks/ehow, graft) has eq_tidy_read_entity_columns, and
 * zaap/graft don't have the 1-arg eq_tidy_read_entity at all — so the
 * fallback never rescued a read, it only masked real errors (e.g. a 42501
 * role-gate refusal came back as a second call's different error, or on ehow
 * as an unprojected full row).
 *
 * duplicate-detect.ts deliberately does NOT use this — its completeness
 * tie-break needs every column on the row, so it keeps calling
 * eq_tidy_read_entity directly, unprojected.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

type RpcClient = {
  rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function readEntityColumns(
  supabase: SupabaseLikeClient,
  table: string,
  columns: string[],
): Promise<{ data: unknown; error: { message: string } | null }> {
  const client = supabase as unknown as RpcClient;
  return client.rpc('eq_tidy_read_entity_columns', { p_table: table, p_columns: columns });
}
