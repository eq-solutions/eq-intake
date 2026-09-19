/**
 * precommit-warnings tests — pure helper coverage, no rendering needed. This
 * package has no component-testing infra; the established pattern here
 * (mirrors @eq/confirm-ui's classificationMismatchMessage) is to test the
 * exported logic directly rather than the JSX that consumes it.
 */

import { describe, it, expect } from "vitest";
import {
  collectPreCommitWarnings,
  describeWarning,
  warningsFingerprint,
  type PreCommitWarning,
} from "../src/shared/precommit-warnings.js";
import type { FileSlot } from "../src/shared/intake-bundle.js";
import type { ParsedSheet } from "@eq/intake";

function fakeFile(name: string): File {
  return { name } as unknown as File;
}

function siteSheet(rows: Record<string, unknown>[]): ParsedSheet {
  return {
    sheetName: "csv",
    headerRow: ["Site Name"],
    rows,
    meta: {
      encoding: "utf-8",
      delimiter: ",",
      totalRows: rows.length,
      emptyRowsSkipped: 0,
      malformedRows: 0,
      malformed: [],
      bomDetected: false,
    },
  };
}

function slot(overrides: Partial<FileSlot>): FileSlot {
  return {
    file: fakeFile("test.csv"),
    role: "site",
    ...overrides,
  };
}

describe("collectPreCommitWarnings", () => {
  it("returns nothing for a confidently-classified slot with no multi-value cells", () => {
    const slots = [slot({ method: "heuristic", sheet: siteSheet([{ "Site Name": "Wollongong" }]) })];
    expect(collectPreCommitWarnings(slots)).toEqual([]);
  });

  it("flags a non-heuristic classification", () => {
    const slots = [
      slot({ method: "ambiguous_fallback", sheet: siteSheet([{ "Site Name": "Wollongong" }]) }),
    ];
    const warnings = collectPreCommitWarnings(slots);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "low_confidence",
      role: "site",
      method: "ambiguous_fallback",
    });
  });

  it("flags a multi-value cell via the real site schema", () => {
    const slots = [
      slot({ method: "heuristic", sheet: siteSheet([{ "Site Name": "Wollongong, Malabar" }]) }),
    ];
    const warnings = collectPreCommitWarnings(slots);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "multi_value", field: "name", affectedRowCount: 1 });
  });

  it("skips unknown-role and sheetless slots entirely", () => {
    const slots = [
      slot({ role: "unknown", method: "ambiguous_fallback" }),
      slot({ method: "ai", sheet: undefined }),
    ];
    expect(collectPreCommitWarnings(slots)).toEqual([]);
  });

  it("aggregates warnings across multiple slots", () => {
    const slots = [
      // siteSheet's one header ("Site Name") maps to nothing on the customer
      // schema, so this slot also picks up an unmapped_required warning —
      // a real gap, not a fixture artifact: it genuinely has no name column.
      slot({ file: fakeFile("customers.csv"), role: "customer", method: "ai", sheet: siteSheet([{}]) }),
      slot({
        file: fakeFile("sites.csv"),
        role: "site",
        method: "heuristic",
        sheet: siteSheet([{ "Site Name": "A, B" }]),
      }),
    ];
    const warnings = collectPreCommitWarnings(slots);
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.kind).sort()).toEqual([
      "low_confidence",
      "multi_value",
      "unmapped_required",
    ]);
  });

  it("flags a required field with no mapped column, via the real site schema", () => {
    const slots = [slot({ method: "heuristic", sheet: siteSheet([{ "Site Name": "Wollongong" }]) })];
    // Override the header to something site.schema.json has no alias for.
    slots[0]!.sheet = { ...slots[0]!.sheet!, headerRow: ["Location Label"] };
    const warnings = collectPreCommitWarnings(slots);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "unmapped_required",
      role: "site",
      field: "name",
      reason: "required",
      availableHeaders: ["Location Label"],
    });
  });

  it("does not flag site_id/tenant_id — required, but generated on commit, not sourced from a column", () => {
    // A clean, fully-mapped site sheet has no unmapped_required warnings at
    // all, even though site_id/tenant_id/active are all in schema.required —
    // this is the false-positive this test guards against regressing.
    const slots = [slot({ method: "heuristic", sheet: siteSheet([{ "Site Name": "Wollongong" }]) })];
    expect(collectPreCommitWarnings(slots)).toEqual([]);
  });

  it("flags customer's cross-field name rule when neither company nor person name mapped", () => {
    const slots = [
      slot({
        role: "customer",
        method: "heuristic",
        sheet: {
          sheetName: "csv",
          headerRow: ["Phone"],
          rows: [{ Phone: "0400000000" }],
          meta: {
            encoding: "utf-8",
            delimiter: ",",
            totalRows: 1,
            emptyRowsSkipped: 0,
            malformedRows: 0,
            malformed: [],
            bomDetected: false,
          },
        },
      }),
    ];
    const warnings = collectPreCommitWarnings(slots);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "unmapped_required",
      role: "customer",
      field: "company_name",
      reason: "customer_needs_a_name",
    });
  });

  it("a manual mapping resolves an unmapped_required warning instead of just acknowledging it", () => {
    const slots = [slot({ method: "heuristic", sheet: siteSheet([{ "Site Name": "Wollongong" }]) })];
    slots[0]!.sheet = { ...slots[0]!.sheet!, headerRow: ["Location Label"] };
    expect(collectPreCommitWarnings(slots)).toHaveLength(1);

    const resolved = collectPreCommitWarnings(slots, { site: { "Location Label": "name" } });
    expect(resolved).toEqual([]);
  });
});

describe("describeWarning", () => {
  it("describes a low-confidence classification in plain English", () => {
    const msg = describeWarning({
      kind: "low_confidence",
      slotLabel: "sites.csv",
      role: "site",
      method: "ai",
    });
    expect(msg).toContain("sites.csv");
    expect(msg).toContain("sites");
    expect(msg.toLowerCase()).toContain("ai");
  });

  it("describes an unmapped required field, naming it in plain English", () => {
    const msg = describeWarning({
      kind: "unmapped_required",
      slotLabel: "sites.csv",
      role: "site",
      field: "name",
      reason: "required",
      availableHeaders: ["Location Label"],
    });
    expect(msg).toContain("sites.csv");
    expect(msg).toContain("name");
    expect(msg).not.toContain("_");
  });

  it("describes customer's cross-field name rule distinctly from a plain required field", () => {
    const msg = describeWarning({
      kind: "unmapped_required",
      slotLabel: "customers.csv",
      role: "customer",
      field: "company_name",
      reason: "customer_needs_a_name",
      availableHeaders: ["Phone"],
    });
    expect(msg).toContain("company name");
    expect(msg).toContain("person's name");
  });

  it("describes a multi-value warning with row count and examples", () => {
    const msg = describeWarning({
      kind: "multi_value",
      slotLabel: "sites.csv",
      field: "name",
      sourceColumn: "Site Name",
      affectedRowCount: 2,
      sampleValues: ["Wollongong, Malabar", "Artarmon, Alexandria"],
    });
    expect(msg).toContain("2 rows");
    expect(msg).toContain("Site Name");
    expect(msg).toContain("Wollongong, Malabar");
  });
});

describe("warningsFingerprint", () => {
  it("is stable for the same warning set and changes when it does", () => {
    const a: PreCommitWarning[] = [
      { kind: "low_confidence", slotLabel: "x.csv", role: "site", method: "ai" },
    ];
    const b: PreCommitWarning[] = [
      { kind: "low_confidence", slotLabel: "x.csv", role: "site", method: "ambiguous_fallback" },
    ];
    expect(warningsFingerprint(a)).toBe(warningsFingerprint(a));
    expect(warningsFingerprint(a)).not.toBe(warningsFingerprint(b));
    expect(warningsFingerprint([])).toBe("");
  });

  it("changes when an unmapped_required warning resolves, so an old acknowledgment doesn't carry over", () => {
    const before: PreCommitWarning[] = [
      {
        kind: "unmapped_required",
        slotLabel: "sites.csv",
        role: "site",
        field: "name",
        reason: "required",
        availableHeaders: ["Location Label"],
      },
    ];
    expect(warningsFingerprint(before)).not.toBe(warningsFingerprint([]));
  });
});
