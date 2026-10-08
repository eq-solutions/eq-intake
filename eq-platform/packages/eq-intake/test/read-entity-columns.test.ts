/**
 * readEntityColumns — returns the projected RPC's result as-is. No fallback
 * to the 1-arg eq_tidy_read_entity: a real error (e.g. a 42501 role-gate
 * refusal) must reach the caller unchanged, not be replaced by a second call.
 */

import { describe, it, expect } from "vitest";
import { readEntityColumns } from "../src/read-entity-columns.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

interface RpcCall {
  name:   string;
  params: Record<string, unknown>;
}

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return result;
    },
  } as unknown as SupabaseLikeClient;
  return { client, calls };
}

describe("readEntityColumns", () => {
  it("calls the projected RPC once and returns its data", async () => {
    const rows = [{ id: "s-1", name: "Huon Henne" }];
    const { client, calls } = fakeClient({ data: rows, error: null });

    const result = await readEntityColumns(client, "staff", ["id", "name"]);

    expect(result).toEqual({ data: rows, error: null });
    expect(calls).toEqual([
      { name: "eq_tidy_read_entity_columns", params: { p_table: "staff", p_columns: ["id", "name"] } },
    ]);
  });

  it("returns the projected RPC's error unchanged, with no fallback call", async () => {
    const error = { message: "permission denied for function eq_tidy_read_entity_columns", code: "42501" };
    const { client, calls } = fakeClient({ data: null, error });

    const result = await readEntityColumns(client, "licences", ["licence_id"]);

    expect(result.error).toBe(error);
    expect(result.data).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("eq_tidy_read_entity_columns");
  });
});
