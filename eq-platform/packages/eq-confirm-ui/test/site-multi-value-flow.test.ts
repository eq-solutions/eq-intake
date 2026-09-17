/**
 * Multi-value site cell — confirm-flow review.
 *
 * A comma-joined site cell (e.g. "Wollongong, Malabar") is surfaced as a
 * multi_value_candidate flag — never silently auto-split. Left unresolved,
 * it commits as-is (one row, the raw joined string) — a wrong guess would be
 * exactly as bad as not splitting at all, so the safe default is "do
 * nothing until confirmed". Only an explicit split_row resolution fans it
 * into N committable rows, which is the one place row count changes in the
 * whole pipeline — source_row_index/ValidationResult upstream stay 1:1 with
 * the source file throughout.
 */
import { describe, it, expect } from "vitest";
import { createConfirmFlow, computeCommitReady, buildCommittedCsv } from "../src/index.js";
import type { FlowConfig } from "../src/index.js";
import type { AIProvider, MapInput, MapResult } from "@eq/ai";

const TENANT = "00000000-0000-4000-8000-000000000001";

function metrics() {
  return { provider: "mock", model: "mock", tokensIn: 0, tokensOut: 0, latencyMs: 0, success: true, retried: false, startedAt: new Date().toISOString() };
}

/** Identity column mapping — source headers already match canonical field names. */
function identityAi(): AIProvider {
  return {
    async map(input: MapInput): Promise<MapResult> {
      return {
        mappings: input.sourceColumns.map((c) => ({
          sourceColumn: c,
          canonicalField: c,
          confidence: 1,
          reason: "test",
        })),
        unmappedRequiredFields: [],
        warnings: [],
        suggestions: [],
        needsClarification: [],
        metrics: metrics(),
      };
    },
    async extract() {
      throw new Error("not used");
    },
  };
}

const SITE_SCHEMA: Record<string, unknown> = {
  $id: "https://schemas.eq.solutions/test/site-multivalue-flow.json",
  type: "object",
  "x-eq-entity": "site",
  properties: {
    client_name: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 200, "x-eq-multi-value": true },
  },
  required: ["client_name", "name"],
};

function makeFlow(committed: { rows: { canonical: Record<string, unknown> }[] }) {
  const flow = createConfirmFlow();
  const config: FlowConfig = {
    schema: SITE_SCHEMA,
    tenantId: TENANT,
    ai: identityAi(),
    commit: async (rows) => {
      committed.rows = rows as { canonical: Record<string, unknown> }[];
      return { committed: rows.length, failed: 0 };
    },
  };
  flow.driver.configure(config);
  return flow;
}

describe("multi-value site flow", () => {
  it("surfaces a comma-joined cell as a flagged row, not an auto-split", async () => {
    const committed = { rows: [] as { canonical: Record<string, unknown> }[] };
    const flow = makeFlow(committed);
    const csv = "client_name,name\nAcme Pty Ltd,\"Wollongong, Malabar\"\n";
    await flow.driver.runToConfirmMapping({ name: "sites.csv", bytes: new TextEncoder().encode(csv) });
    await flow.driver.validate();

    const result = flow.useStore.getState().validationResult!;
    expect(result.valid_rows).toHaveLength(0);
    const row = result.flagged_rows[0]!;
    expect(row.canonical.name).toBe("Wollongong, Malabar");
    const flag = row.flags.find((f) => f.kind === "multi_value_candidate");
    expect(flag).toBeDefined();
  });

  it("unresolved: commits as one row with the raw joined value (safe default)", async () => {
    const committed = { rows: [] as { canonical: Record<string, unknown> }[] };
    const flow = makeFlow(committed);
    const csv = "client_name,name\nAcme Pty Ltd,\"Wollongong, Malabar\"\n";
    await flow.driver.runToConfirmMapping({ name: "sites.csv", bytes: new TextEncoder().encode(csv) });
    await flow.driver.validate();

    await flow.driver.commit();
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0]!.canonical.name).toBe("Wollongong, Malabar");
  });

  it("confirmed split_row: fans one flagged row into N committable rows", async () => {
    const committed = { rows: [] as { canonical: Record<string, unknown> }[] };
    const flow = makeFlow(committed);
    const csv = "client_name,name\nAcme Pty Ltd,\"Wollongong, Malabar\"\n";
    await flow.driver.runToConfirmMapping({ name: "sites.csv", bytes: new TextEncoder().encode(csv) });
    await flow.driver.validate();

    const state = flow.useStore.getState();
    const row = state.validationResult!.flagged_rows[0]!;
    state.resolveFlag(row.source_row_index, {
      kind: "split_row",
      field: "name",
      values: ["Wollongong", "Malabar"],
    });

    const ready = computeCommitReady(flow.useStore.getState());
    expect(ready.committable).toHaveLength(2);
    expect(ready.committable[0]).toMatchObject({
      source_row_index: row.source_row_index,
      split_index: 0,
      canonical: { client_name: "Acme Pty Ltd", name: "Wollongong" },
    });
    expect(ready.committable[1]).toMatchObject({
      source_row_index: row.source_row_index,
      split_index: 1,
      canonical: { client_name: "Acme Pty Ltd", name: "Malabar" },
    });

    await flow.driver.commit();
    expect(committed.rows).toHaveLength(2);
    expect(committed.rows.map((r) => r.canonical.name)).toEqual(["Wollongong", "Malabar"]);

    const csvOut = buildCommittedCsv(flow.useStore.getState())!;
    const lines = csvOut.content.trim().split("\n");
    expect(lines[0]).toBe("source_row_index,split_index,client_name,name");
    expect(lines[1]).toBe(`${row.source_row_index},0,Acme Pty Ltd,Wollongong`);
    expect(lines[2]).toBe(`${row.source_row_index},1,Acme Pty Ltd,Malabar`);
  });
});
