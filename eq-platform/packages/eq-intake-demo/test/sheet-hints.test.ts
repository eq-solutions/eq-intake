/**
 * Regression coverage for the hand-kept staff list that Intake could not place
 * (demo run 2026-11-14): header row below title rows, "Full Name" instead of
 * first/last, "Mob" / "Email addr" / "Emp type" headers, a duplicate person,
 * and a second tab called "old - ignore".
 */

import { describe, it, expect } from "vitest";
import { classifySheet, type ParsedSheet } from "@eq/intake";
import { CUSTOMER_SCHEMA, CONTACT_SCHEMA, SITE_SCHEMA, STAFF_SCHEMA } from "../src/simpro-schemas.js";
import type { RoleName } from "../src/rollup/roles.js";
import { isLikelyIgnoredSheet, splitFullNameColumn, splitPersonName } from "../src/shared/sheet-hints.js";
import { previewDuplicateRows } from "../src/canonical/commit-canonical.js";

const ROLE_REGISTRY: Record<RoleName, Record<string, unknown>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  staff: STAFF_SCHEMA,
};

function sheetOf(headers: string[], rows: Record<string, unknown>[], sheetName = "Sheet1"): ParsedSheet {
  return {
    sheetName,
    headerRow: headers,
    rows,
    meta: { encoding: "utf-8", delimiter: ",", totalRows: rows.length, emptyRowsSkipped: 0, malformedRows: 0, bomDetected: false },
  };
}

const HEADERS = ["Full Name", "Mob", "Email addr", "Emp type", "Lic #", "Start", "Notes"];
const ROWS = [
  { "Full Name": "Sam Okoro", Mob: "0491 570 156", "Email addr": "sam.okoro@example.com", "Emp type": "Perm" },
  { "Full Name": "Priya Nair", Mob: "+61491570157", "Email addr": "priya.nair@example.com", "Emp type": "perm" },
  { "Full Name": "Liam Dacosta", Mob: "491570158", "Email addr": "liam@example.com", "Emp type": "Casual" },
  { "Full Name": "Jack Moretti", Mob: "0491570110", "Email addr": "jack.moretti@example.com", "Emp type": "Perm" },
  { "Full Name": "Sam Okoro", Mob: "0491 570 199", "Email addr": "sam.okoro@example.com", "Emp type": "Perm" },
];

describe("isLikelyIgnoredSheet", () => {
  it.each(["old - ignore", "Archive", "Staff (backup)", "do not use", "Contacts_OLD", "former staff"])(
    "skips %s",
    (name) => expect(isLikelyIgnoredSheet(name)).toBe(true),
  );
  it.each(["Sheet1", "Staff", "Oldham sites", "Holder list", "Bakery", "Roster"])(
    "keeps %s",
    (name) => expect(isLikelyIgnoredSheet(name)).toBe(false),
  );
  it("keeps a missing name", () => {
    expect(isLikelyIgnoredSheet(undefined)).toBe(false);
    expect(isLikelyIgnoredSheet("")).toBe(false);
  });
});

describe("splitPersonName", () => {
  it("splits first and last", () => expect(splitPersonName("Sam Okoro")).toEqual({ first: "Sam", last: "Okoro" }));
  it("handles 'Last, First'", () => expect(splitPersonName("Okoro, Sam")).toEqual({ first: "Sam", last: "Okoro" }));
  it("keeps name particles with the surname", () =>
    expect(splitPersonName("Jan van der Berg")).toEqual({ first: "Jan", last: "van der Berg" }));
  it("keeps a middle name with the first name", () =>
    expect(splitPersonName("Mary Anne Smith")).toEqual({ first: "Mary Anne", last: "Smith" }));
  it("leaves one word as a first name only, so the required-field check still fires", () =>
    expect(splitPersonName("Cher")).toEqual({ first: "Cher", last: "" }));
  it("handles blanks", () => expect(splitPersonName("   ")).toEqual({ first: "", last: "" }));
});

describe("splitFullNameColumn", () => {
  const sheet = sheetOf(HEADERS, ROWS);

  it("adds First name and Last name and keeps the original column", () => {
    const out = splitFullNameColumn(sheet, "staff");
    expect(out.headerRow).toEqual([...HEADERS, "First name", "Last name"]);
    expect((out.rows[0] as Record<string, unknown>)["Full Name"]).toBe("Sam Okoro");
    expect((out.rows[0] as Record<string, unknown>)["First name"]).toBe("Sam");
    expect((out.rows[0] as Record<string, unknown>)["Last name"]).toBe("Okoro");
  });

  it("does nothing for customers or sites", () => {
    expect(splitFullNameColumn(sheet, "customer")).toBe(sheet);
    expect(splitFullNameColumn(sheet, "site")).toBe(sheet);
  });

  it("does nothing when first or last name columns already exist", () => {
    const has = sheetOf(["First name", "Surname", "Name"], []);
    expect(splitFullNameColumn(has, "staff")).toBe(has);
  });

  it("does nothing with no name column", () => {
    const none = sheetOf(["Mob", "Email"], []);
    expect(splitFullNameColumn(none, "staff")).toBe(none);
  });
});

describe("the messy staff list, end to end", () => {
  const probe = splitFullNameColumn(sheetOf(HEADERS, ROWS), "staff");

  it("is recognised as staff, decisively", async () => {
    const result = await classifySheet({ schemas: ROLE_REGISTRY, sheet: probe });
    expect(result.entity).toBe("staff");
    expect(result.method).toBe("heuristic");
  });

  it("flags the two Sam Okoro rows as the same person", () => {
    const dupes = previewDuplicateRows(probe, "staff");
    expect(dupes.length).toBe(1);
    expect(dupes[0]!.rowIndices).toEqual([0, 4]);
  });
});
