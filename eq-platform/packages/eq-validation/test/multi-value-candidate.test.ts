/**
 * multi_value_candidate flag — detects a delimited-looking value in a field
 * the schema explicitly marks x-eq-multi-value (e.g. site.name), without
 * ever auto-splitting it. Advisory only: canonical keeps the raw joined
 * string; a confirm-flow driver decides whether to fan the row out, via a
 * split_row resolution (see @eq/confirm-ui's site-multi-value-flow.test.ts).
 *
 * Real-world shape: hand-maintained client registers commonly comma-join
 * several site/suburb names into one cell for a given client (confirmed
 * against a real tenant's own customer list).
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/validate.js";

const __filename = fileURLToPath(import.meta.url);
const SCHEMAS_DIR = join(dirname(__filename), "..", "..", "eq-schemas", "src", "schemas");

async function loadSchema(name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(SCHEMAS_DIR, name + ".schema.json"), "utf8");
  return JSON.parse(raw);
}

const TENANT = "00000000-0000-4000-8000-000000000001";

const HINTED_SCHEMA = {
  $id: "https://schemas.eq.solutions/test/site-multivalue.json",
  type: "object",
  "x-eq-entity": "site",
  properties: {
    name: { type: "string", maxLength: 200, "x-eq-multi-value": true },
    notes: { type: ["string", "null"], maxLength: 2000 },
  },
  required: ["name"],
};

describe("multi_value_candidate — x-eq-multi-value hinted field", () => {
  it("flags a comma-joined value and reports each trimmed segment", async () => {
    const result = await validate({
      schema: HINTED_SCHEMA,
      mapping: { Sites: "name" },
      rows: [{ Sites: "Wollongong, Malabar" }],
      tenantId: TENANT,
    });

    expect(result.summary.rejected).toBe(0);
    const row = result.flagged_rows[0]!;
    expect(row.canonical.name).toBe("Wollongong, Malabar"); // unsplit — advisory only
    const flag = row.flags.find((f) => f.kind === "multi_value_candidate");
    expect(flag).toBeDefined();
    if (flag?.kind === "multi_value_candidate") {
      expect(flag.field).toBe("name");
      expect(flag.values).toEqual(["Wollongong", "Malabar"]);
    }
  });

  it("ignores a trailing/stray comma with only one real segment", async () => {
    const result = await validate({
      schema: HINTED_SCHEMA,
      mapping: { Sites: "name" },
      rows: [{ Sites: "Wollongong," }],
      tenantId: TENANT,
    });

    const row = result.valid_rows[0] ?? result.flagged_rows[0];
    expect(row!.canonical.name).toBe("Wollongong,");
    const flags = "flags" in row! ? row.flags : [];
    expect(flags.some((f) => f.kind === "multi_value_candidate")).toBe(false);
  });

  it("does not flag a single-value cell", async () => {
    const result = await validate({
      schema: HINTED_SCHEMA,
      mapping: { Sites: "name" },
      rows: [{ Sites: "Wollongong" }],
      tenantId: TENANT,
    });

    expect(result.valid_rows).toHaveLength(1);
    expect(result.flagged_rows).toHaveLength(0);
  });

  it("does not flag a field the schema hasn't marked x-eq-multi-value", async () => {
    // notes is a plain string field — a comma in free text is normal prose,
    // not a delimiter, and must never trigger a split suggestion.
    const result = await validate({
      schema: HINTED_SCHEMA,
      mapping: { Sites: "name", Notes: "notes" },
      rows: [{ Sites: "HQ", Notes: "Access via loading dock, ring bell twice" }],
      tenantId: TENANT,
    });

    expect(result.valid_rows).toHaveLength(1);
    expect(result.flagged_rows).toHaveLength(0);
  });
});

describe("multi_value_candidate — against the real site.schema.json", () => {
  // Guards against the x-eq-multi-value hint silently disappearing from the
  // canonical schema file (eq-platform/packages/eq-schemas/src/schemas/) —
  // every other test in this file uses a local mock schema and wouldn't
  // catch that regression.
  it("flags a comma-joined name using the shipped schema, not a mock", async () => {
    const siteSchema = await loadSchema("site");
    expect((siteSchema.properties as Record<string, Record<string, unknown>>).name["x-eq-multi-value"]).toBe(true);

    const result = await validate({
      schema: siteSchema,
      mapping: { Client: "client_name", Sites: "name" },
      rows: [{ Client: "Acme Pty Ltd", Sites: "Wollongong, Malabar" }],
      tenantId: TENANT,
    });

    const row = result.flagged_rows[0]!;
    const flag = row.flags.find((f) => f.kind === "multi_value_candidate");
    expect(flag).toBeDefined();
    if (flag?.kind === "multi_value_candidate") {
      expect(flag.values).toEqual(["Wollongong", "Malabar"]);
    }
  });
});
