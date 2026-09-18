/**
 * classifySheet tests.
 *
 * Builds a tiny schema registry inline (only the fields needed for matching
 * are present) and asserts that the classifier picks the right entity for
 * sheets with obvious column names. The AI fallback path is exercised with a
 * mock AIProvider that doesn't actually call any network.
 */

import { describe, it, expect } from "vitest";
import { classifySheet, type SchemaRegistry } from "../src/classify.js";
import type { ParsedSheet } from "../src/readers/csv.js";
import type { AIProvider, MapInput, MapResult, ExtractResult } from "@eq/ai";

const REGISTRY: SchemaRegistry = {
  staff: {
    "x-eq-entity": "staff",
    properties: {
      first_name: { "x-eq-source-aliases": ["first", "given_name", "fname"] },
      last_name: { "x-eq-source-aliases": ["surname", "lname"] },
      email: { "x-eq-source-aliases": ["email_address", "mail"] },
      phone: { "x-eq-source-aliases": ["mobile", "cell"] },
      employment_type: { "x-eq-source-aliases": ["type", "engagement"] },
    },
  },
  site: {
    "x-eq-entity": "site",
    properties: {
      name: { "x-eq-source-aliases": ["site_name", "location"] },
      code: { "x-eq-source-aliases": ["site_code", "ref"] },
      address: { "x-eq-source-aliases": ["street", "addr"] },
      latitude: { "x-eq-source-aliases": ["lat"] },
      longitude: { "x-eq-source-aliases": ["lng", "lon"] },
    },
  },
  asset: {
    "x-eq-entity": "asset",
    properties: {
      asset_name: { "x-eq-source-aliases": ["equipment", "tag", "description"] },
      asset_type: { "x-eq-source-aliases": ["category", "kind"] },
      serial_number: { "x-eq-source-aliases": ["sn", "serial"] },
      manufacturer: { "x-eq-source-aliases": ["make", "brand"] },
      model: { "x-eq-source-aliases": ["model_no"] },
    },
  },
};

function sheet(headers: string[]): ParsedSheet {
  return {
    sheetName: "test",
    headerRow: headers,
    rows: headers.map(() => ({})), // empty rows; classifier only looks at headers
    meta: {
      encoding: "utf-8",
      delimiter: ",",
      totalRows: 0,
      emptyRowsSkipped: 0,
      malformedRows: 0,
      bomDetected: false,
    },
  };
}

describe("classifySheet — heuristic matching", () => {
  it("picks staff for an obvious staff list", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["first_name", "last_name", "email", "phone", "employment_type"]),
    });
    expect(result.entity).toBe("staff");
    expect(result.method).toBe("heuristic");
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it("picks site for an obvious site list", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["name", "code", "address", "latitude", "longitude"]),
    });
    expect(result.entity).toBe("site");
    expect(result.method).toBe("heuristic");
  });

  it("picks asset for an obvious asset register", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["asset_name", "asset_type", "serial_number", "manufacturer", "model"]),
    });
    expect(result.entity).toBe("asset");
    expect(result.method).toBe("heuristic");
  });

  it("resolves aliases (Mobile → phone, Surname → last_name) for messy headers", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["First", "Surname", "Mail", "Mobile", "Type"]),
    });
    expect(result.entity).toBe("staff");
  });

  it("returns ambiguous_fallback when heuristic is inconclusive and no AI provided", async () => {
    // 'name' matches site.name; 'description' matches asset.asset_name
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["name", "description"]),
    });
    expect(["site", "asset", "staff"]).toContain(result.entity);
    expect(result.method).toBe("ambiguous_fallback");
  });

  it("includes every entity in scores", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["first_name", "last_name"]),
    });
    expect(Object.keys(result.scores)).toEqual(["staff", "site", "asset"]);
  });
});

describe("classifySheet — AI fallback", () => {
  it("calls AI provider when heuristic is ambiguous and returns the AI's pick", async () => {
    const aiCalls: MapInput[] = [];
    const mockAi: AIProvider = {
      async map(input: MapInput): Promise<MapResult> {
        aiCalls.push(input);
        const entity = input.targetSchema["x-eq-entity"] as string;
        // Pretend the AI maps every source column for "asset" but only 1 for others.
        const mappedCount = entity === "asset" ? input.sourceColumns.length : 1;
        return {
          mappings: input.sourceColumns.map((c, i) => ({
            sourceColumn: c,
            canonicalField: i < mappedCount ? "asset_name" : null,
            confidence: 0.9,
            reason: "mock",
          })),
          unmappedRequiredFields: [],
          warnings: [],
          suggestions: [],
          needsClarification: [],
          metrics: {
            provider: "mock",
            model: "mock",
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 0,
            success: true,
            retried: false,
            startedAt: new Date().toISOString(),
          },
        };
      },
      async extract(): Promise<ExtractResult> {
        throw new Error("not used");
      },
    };

    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["name", "description"]),
      ai: mockAi,
    });

    expect(aiCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.method).toBe("ai");
    expect(result.entity).toBe("asset");
  });

  it("falls back gracefully if every AI call throws", async () => {
    const mockAi: AIProvider = {
      async map(): Promise<MapResult> {
        throw new Error("AI down");
      },
      async extract(): Promise<ExtractResult> {
        throw new Error("not used");
      },
    };

    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["name", "description"]),
      ai: mockAi,
    });

    expect(result.method).toBe("ambiguous_fallback");
    // Returns top heuristic candidate as a best-effort answer
    expect(["site", "asset", "staff"]).toContain(result.entity);
  });
});

describe("classifySheet — edge cases", () => {
  it("throws when the registry is empty", async () => {
    await expect(
      classifySheet({ schemas: {}, sheet: sheet(["a"]) }),
    ).rejects.toThrow(/no schemas/i);
  });

  it("returns 0 confidence when no columns match any schema", async () => {
    const result = await classifySheet({
      schemas: REGISTRY,
      sheet: sheet(["xyz", "qwerty", "zzzzz"]),
    });
    expect(result.confidence).toBeLessThan(0.3);
  });
});

describe("classifySheet — fuzzy match length guard", () => {
  // A schema whose only source of "contact"-ish signal is a long compound
  // alias on an unrelated field — the shape that caused site/service_visit
  // to falsely crowd out customer for a bare "Contacts" column (Madagins
  // onboarding misroute, see classify_client_register_misroute memory).
  const REGISTRY_WITH_COMPOUND_ALIAS: SchemaRegistry = {
    widget: {
      "x-eq-entity": "widget",
      properties: {
        contact_position: { "x-eq-source-aliases": ["contact_position"] },
      },
    },
    person: {
      "x-eq-entity": "person",
      properties: {
        contact: { "x-eq-source-aliases": ["contact"] },
      },
    },
  };

  it("does not fuzzy-match a short header against a much longer compound alias that merely shares its prefix", async () => {
    const result = await classifySheet({
      schemas: REGISTRY_WITH_COMPOUND_ALIAS,
      sheet: sheet(["Contacts"]),
    });
    expect(result.scores.widget).toBe(0);
  });

  it("still fuzzy-matches a plural header against a near-length singular alias", async () => {
    const result = await classifySheet({
      schemas: REGISTRY_WITH_COMPOUND_ALIAS,
      sheet: sheet(["Contacts"]),
    });
    expect(result.scores.person).toBe(1);
  });
});

describe("classifySheet — real @eq/schemas corpus (regression fixture)", () => {
  // eq-solves-intake CLAUDE.md / classify_client_register_misroute memory:
  // a plain "Clients / Contacts / Sites" client register (customer name /
  // contact name / site name, one row per client) was scored against the
  // full canonical schema set and silently misrouted — site, contract_scope
  // and service_visit all crowded out customer via generic aliases. This
  // fixture locks in the safe behaviour: genuine multi-entity ambiguity
  // must surface as ambiguous_fallback, never a confident wrong pick.
  it("flags a Clients/Contacts/Sites register as ambiguous against the full eq-schemas registry, never confidently wrong", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaDir = join(here, "..", "..", "eq-schemas", "src", "schemas");
    const registry: SchemaRegistry = {};
    for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"))) {
      const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf-8"));
      const entity = (schema["x-eq-entity"] as string) ?? file.replace(/\.schema\.json$/, "");
      registry[entity] = schema;
    }

    const result = await classifySheet({
      schemas: registry,
      sheet: sheet(["col_1", "Clients", "Contacts", "Sites"]),
    });

    // The real bug: this used to come back as method "heuristic" (a
    // confident, silently wrong pick). A registry this broad genuinely
    // can't tell customer/contact/site apart from three bare entity-name
    // headers alone — the safe outcome is surfacing that, not guessing.
    expect(result.method).not.toBe("heuristic");
  });
});
