/**
 * mock-supabase — an offline stand-in for the Supabase client the "Bring
 * Data In" tab needs to actually save.
 *
 * Same reasoning as mock-ai.ts: the demo's whole point is running the real
 * IntakeModule without any backend. Before this, "Bring Data In" could
 * classify and preview a file but never commit — the SupabaseLikeClient
 * prop was simply omitted, so CommitView rendered its "EQ isn't connected
 * yet" strip and stopped there. This fills that gap: a fake
 * eq_intake_commit_batch that mints a uuid per row (in input order, same
 * as the real SQL function — see sql/008_decompose_intake_commit_batch.sql),
 * kept in an in-memory table so the same tenant/session sees consistent
 * data across a run. Nothing here talks to a network.
 */

import type { SupabaseLikeClient } from "./canonical/commit-canonical.js";

let uuidCounter = 0;
function fakeUuid(): string {
  uuidCounter += 1;
  return `demo-${uuidCounter.toString(36).padStart(8, "0")}`;
}

export function createMockSupabase(): SupabaseLikeClient {
  const tables = new Map<string, Record<string, unknown>[]>();

  return {
    from: (table: string) => ({
      insert: async (row: unknown) => {
        const rows = tables.get(table) ?? [];
        rows.push(row as Record<string, unknown>);
        tables.set(table, rows);
        return { data: row, error: null };
      },
      update: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
    }),

    rpc: async (name: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;

      if (name === "eq_read_customers_by_intake") {
        // No prior customers in this offline session — every FK lookup misses,
        // same as a brand-new tenant. Real behaviour, not faked leniency.
        return { data: [], error: null };
      }

      if (name === "eq_queue_list") {
        // No steward process runs against this offline session, so the
        // remediation queue is genuinely empty — same brand-new-tenant logic
        // as eq_read_customers_by_intake above.
        return { data: [], error: null };
      }

      if (name === "eq_intake_commit_batch") {
        const rows = (p.p_rows as Record<string, unknown>[] | undefined) ?? [];
        const table = String(p.p_table ?? "rows");
        const existing = tables.get(table) ?? [];
        const ids = rows.map(() => fakeUuid());
        rows.forEach((row, i) => existing.push({ ...row, id: ids[i] }));
        tables.set(table, existing);
        return {
          data: [{ committed_count: rows.length, committed_ids: ids }],
          error: null,
        };
      }

      return { data: null, error: { message: `mock-supabase: no handler for rpc "${name}"` } };
    },

    auth: {
      getUser: async () => ({ data: { user: { id: "demo-user" } }, error: null }),
    },
  };
}
