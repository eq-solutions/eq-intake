/**
 * Tests for buildFieldMeta + groupFields — the schema-driven picker logic.
 *
 * Component rendering itself is verified by eye in the demo; these tests
 * pin the metadata + grouping logic so the picker shows the right shape.
 */

import { describe, it, expect } from "vitest";
import {
  buildFieldMeta,
  groupFields,
  classificationMismatchMessage,
} from "../src/components/MappingTable.js";
import type { ClassifyResult } from "@eq/intake";

describe("buildFieldMeta", () => {
  it("returns required=false and no description when no schema is supplied", () => {
    const meta = buildFieldMeta(["first_name", "last_name", "email"]);
    expect(meta).toEqual([
      { name: "first_name", description: undefined, required: false, section: undefined },
      { name: "last_name", description: undefined, required: false, section: undefined },
      { name: "email", description: undefined, required: false, section: undefined },
    ]);
  });

  it("pulls description and required flag from a JSON Schema", () => {
    const schema = {
      type: "object",
      required: ["first_name", "last_name"],
      properties: {
        first_name: { type: "string", description: "Given name. Required." },
        last_name: { type: "string", description: "Family name. Required." },
        email: { type: "string", description: "Primary email." },
        // present in schema but not in canonicalFields — should be ignored
        secret: { type: "string", description: "you shall not see" },
      },
    };
    const meta = buildFieldMeta(["first_name", "last_name", "email"], schema);
    expect(meta).toEqual([
      { name: "first_name", description: "Given name. Required.", required: true, section: undefined },
      { name: "last_name", description: "Family name. Required.", required: true, section: undefined },
      { name: "email", description: "Primary email.", required: false, section: undefined },
    ]);
  });

  it("captures x-eq-section when present on a property", () => {
    const schema = {
      properties: {
        first_name: { description: "given", "x-eq-section": "Identity" },
        phone: { description: "primary mobile", "x-eq-section": "Contact" },
        notes: { description: "free text" },
      },
    };
    const meta = buildFieldMeta(["first_name", "phone", "notes"], schema);
    expect(meta[0].section).toBe("Identity");
    expect(meta[1].section).toBe("Contact");
    expect(meta[2].section).toBeUndefined();
  });

  it("includes a field not present in the schema (no metadata, no crash)", () => {
    const schema = { properties: { first_name: { description: "given" } } };
    const meta = buildFieldMeta(["first_name", "rogue_field"], schema);
    expect(meta[1]).toEqual({
      name: "rogue_field",
      description: undefined,
      required: false,
      section: undefined,
    });
  });
});

describe("groupFields", () => {
  it("returns a single empty-label group when no field has a section", () => {
    const groups = groupFields([
      { name: "zebra", required: false },
      { name: "alpha", required: false },
      { name: "mike", required: true },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("");
    // Alphabetical within the single group
    expect(groups[0].fields.map((f) => f.name)).toEqual(["alpha", "mike", "zebra"]);
  });

  it("groups by section and sorts sections alphabetically", () => {
    const groups = groupFields([
      { name: "phone", required: false, section: "Contact" },
      { name: "first_name", required: true, section: "Identity" },
      { name: "last_name", required: true, section: "Identity" },
      { name: "email", required: false, section: "Contact" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Contact", "Identity"]);
    expect(groups[0].fields.map((f) => f.name)).toEqual(["email", "phone"]);
    expect(groups[1].fields.map((f) => f.name)).toEqual(["first_name", "last_name"]);
  });

  it("puts unsectioned fields last under the 'Other' label", () => {
    const groups = groupFields([
      { name: "first_name", required: true, section: "Identity" },
      { name: "ad_hoc", required: false },
      { name: "email", required: false, section: "Contact" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Contact", "Identity", "Other"]);
    expect(groups[2].fields.map((f) => f.name)).toEqual(["ad_hoc"]);
  });

  it("works against a realistic staff-shape schema", () => {
    // Mirrors @eq/schemas staff.schema.json — required fields, no sections.
    const schema = {
      required: ["first_name", "last_name", "employment_type", "active"],
      properties: {
        first_name: { description: "Given name. Required." },
        last_name: { description: "Family name. Required." },
        email: { description: "Primary email." },
        phone: { description: "Primary mobile. E.164 where possible." },
        employment_type: { description: "Engagement type." },
        trade: { description: "Primary trade discipline." },
        active: { description: "Currently employed." },
      },
    };
    const canonicalFields = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "employment_type",
      "trade",
      "active",
    ];
    const meta = buildFieldMeta(canonicalFields, schema);
    const groups = groupFields(meta);

    // No sections in the staff schema today → one flat group
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("");

    // The four required fields carry required=true
    const requiredNames = meta.filter((f) => f.required).map((f) => f.name);
    expect(requiredNames.sort()).toEqual(
      ["active", "employment_type", "first_name", "last_name"],
    );

    // Descriptions land on every field that has one in the schema
    expect(meta.find((f) => f.name === "phone")?.description).toBe(
      "Primary mobile. E.164 where possible.",
    );

    // Alphabetical
    expect(groups[0].fields.map((f) => f.name)).toEqual([
      "active",
      "email",
      "employment_type",
      "first_name",
      "last_name",
      "phone",
      "trade",
    ]);
  });
});

describe("classificationMismatchMessage", () => {
  function classified(
    entity: string,
    confidence: number,
    scores: Record<string, number> = {},
    method: ClassifyResult["method"] = "heuristic",
  ): ClassifyResult {
    return {
      entity,
      confidence,
      method,
      scores: { [entity]: confidence, ...scores },
      reason: "test",
    };
  }

  it("returns null when no classification is available", () => {
    expect(classificationMismatchMessage(undefined, "staff")).toBeNull();
  });

  it("returns null when no target entity is configured", () => {
    expect(classificationMismatchMessage(classified("staff", 0.8), undefined)).toBeNull();
  });

  it("returns null when classification matches the target", () => {
    expect(classificationMismatchMessage(classified("staff", 0.8), "staff")).toBeNull();
  });

  it("warns when classification picked a confident different entity", () => {
    const msg = classificationMismatchMessage(
      classified("asset", 0.7, { staff: 0.1 }),
      "staff",
    );
    expect(msg?.severity).toBe("warn");
    // Article picker: "asset" starts with a vowel → "an asset"
    expect(msg?.title).toMatch(/looks like an asset register, not staff/);
    expect(msg?.body).toMatch(/70%/);
  });

  it("gives a soft info when no entity scored high enough", () => {
    const msg = classificationMismatchMessage(
      classified("staff", 0.12, { staff: 0.12, asset: 0.08 }),
      "asset",
    );
    expect(msg?.severity).toBe("info");
    expect(msg?.title).toMatch(/Couldn't tell what this file is/);
  });

  it("gives a middle-confidence hint when scores are close", () => {
    const msg = classificationMismatchMessage(
      classified("asset", 0.4, { staff: 0.3 }),
      "staff",
    );
    expect(msg?.severity).toBe("info");
    expect(msg?.title).toMatch(/might be an asset, not staff/);
    expect(msg?.body).toMatch(/40%/);
    expect(msg?.body).toMatch(/30%/);
  });

  it("uses 'a' for consonant-starting entity names", () => {
    const msg = classificationMismatchMessage(
      classified("staff", 0.6, { asset: 0.1 }),
      "asset",
    );
    expect(msg?.title).toMatch(/looks like a staff register, not asset/);
  });

  it("warns when the entity matches but only via an unresolved heuristic tie", () => {
    // The gap this closes: store.ts's classify() never checks result.method,
    // so an ambiguous_fallback that happens to land on the right entity was
    // previously indistinguishable from a clean heuristic match — silence
    // either way. See classify.ts's own ClassifyResult.method docs.
    const msg = classificationMismatchMessage(
      classified("staff", 1, { customer: 1 }, "ambiguous_fallback"),
      "staff",
    );
    expect(msg?.severity).toBe("info");
    expect(msg?.title).toMatch(/Not fully sure.*looks like a staff file/);
    expect(msg?.body).toMatch(/no AI provider configured/);
  });

  it("warns when the entity matches but only via an AI tie-break", () => {
    const msg = classificationMismatchMessage(
      classified("staff", 1, { customer: 1 }, "ai"),
      "staff",
    );
    expect(msg?.severity).toBe("info");
    expect(msg?.title).toMatch(/Not fully sure.*looks like a staff file/);
    expect(msg?.body).toMatch(/AI pass was used to decide/);
  });

  it("still returns null for a decisive heuristic match (unchanged behaviour)", () => {
    expect(
      classificationMismatchMessage(classified("staff", 0.8, {}, "heuristic"), "staff"),
    ).toBeNull();
  });
});
