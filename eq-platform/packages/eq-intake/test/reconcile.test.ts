/**
 * reconcile — fuzzy identity pass.
 *
 * Exact-key matching alone lets a near-duplicate slip through as an
 * unrelated "new row" (onlyInSource) next to an "untouched" canonical row
 * (onlyInCanonical) — e.g. a customer re-entered as "ACME P/L" when EQ
 * already has "Acme Pty Ltd" under a different ABN/id. Without an entity
 * hint, reconcileSheets keeps its original exact-key-only behaviour; with
 * one, leftover rows get a second fuzzy pass before being reported as
 * unrelated.
 */

import { describe, it, expect } from "vitest";
import { reconcileSheets } from "../src/reconcile.js";
import type { ParsedSheet } from "../src/readers/csv.js";

const EMPTY_META = {
  encoding: "utf-8",
  delimiter: ",",
  totalRows: 0,
  emptyRowsSkipped: 0,
  malformedRows: 0,
  malformed: [],
};

function sheet(headerRow: string[], rows: Record<string, unknown>[]): ParsedSheet {
  return { sheetName: "test", headerRow, rows, meta: { ...EMPTY_META, totalRows: rows.length } };
}

describe("reconcileSheets — exact key path (no entity supplied)", () => {
  it("matches on the detected key and reports field conflicts as before", () => {
    const source = sheet(
      ["email", "phone"],
      [{ email: "james@acme.com.au", phone: "0412345678" }],
    );
    const canonical = [{ email: "james@acme.com.au", phone: "0412000000" }];

    const result = reconcileSheets(source, canonical);

    expect(result.matched).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.matchedBy).toBeUndefined();
    expect(result.onlyInSource).toHaveLength(0);
    expect(result.onlyInCanonical).toHaveLength(0);
  });

  it("without an entity hint, a near-duplicate with no shared key stays split (old behaviour)", () => {
    const source = sheet(["company_name", "abn"], [{ company_name: "Acme Pty Ltd", abn: "" }]);
    const canonical = [{ customer_id: "cust-1", company_name: "ACME P/L", abn: "51824753556" }];

    const result = reconcileSheets(source, canonical);

    expect(result.conflicts).toHaveLength(0);
    expect(result.onlyInSource).toHaveLength(1);
    expect(result.onlyInCanonical).toHaveLength(1);
  });
});

describe("reconcileSheets — fuzzy identity pass (entity supplied)", () => {
  it("promotes a near-duplicate customer (different ABN, near-identical name) into conflicts", () => {
    const source = sheet(["company_name", "abn"], [{ company_name: "Acme Pty Ltd", abn: "" }]);
    const canonical = [{ customer_id: "cust-1", company_name: "ACME P/L", abn: "51824753556" }];

    const result = reconcileSheets(source, canonical, undefined, "customers");

    expect(result.onlyInSource).toHaveLength(0);
    expect(result.onlyInCanonical).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);

    const row = result.conflicts[0]!;
    expect(row.matchedBy).toBe("fuzzy");
    expect(row.sourceRow?.company_name).toBe("Acme Pty Ltd");
    expect(row.canonicalRow?.company_name).toBe("ACME P/L");
    // The synthetic name-similarity entry always leads, real field diffs (if any) follow.
    expect(row.conflicts[0]!.field).toBe("name similarity");
  });

  it("does not fuzzy-match genuinely different customers", () => {
    const source = sheet(["company_name", "abn"], [{ company_name: "Zephyr Roofing", abn: "" }]);
    const canonical = [{ customer_id: "cust-1", company_name: "ACME P/L", abn: "51824753556" }];

    const result = reconcileSheets(source, canonical, undefined, "customers");

    expect(result.conflicts).toHaveLength(0);
    expect(result.onlyInSource).toHaveLength(1);
    expect(result.onlyInCanonical).toHaveLength(1);
  });

  it("greedily pairs each source row with at most one canonical row", () => {
    const source = sheet(
      ["company_name", "abn"],
      [
        { company_name: "Acme Pty Ltd", abn: "" },
        { company_name: "Acme Electrical Pty Ltd", abn: "" },
      ],
    );
    const canonical = [
      { customer_id: "cust-1", company_name: "ACME P/L", abn: "51824753556" },
      { customer_id: "cust-2", company_name: "Acme Electrical P/L", abn: "99887766554" },
    ];

    const result = reconcileSheets(source, canonical, undefined, "customers");

    expect(result.conflicts).toHaveLength(2);
    expect(result.onlyInSource).toHaveLength(0);
    expect(result.onlyInCanonical).toHaveLength(0);
    const paired = new Set(result.conflicts.map((r) => r.canonicalRow?.customer_id));
    expect(paired).toEqual(new Set(["cust-1", "cust-2"]));
  });

  it("never leaves the fuzzy row eligible for an unsupervised 'use source' merge signal downstream", () => {
    // Not a UI test (that lives in eq-intake-demo) — just locking the
    // contract the UI depends on: matchedBy is the only signal it has to
    // withhold "use source", so it must always be set on a fuzzy row.
    const source = sheet(["company_name", "abn"], [{ company_name: "Acme Pty Ltd", abn: "" }]);
    const canonical = [{ customer_id: "cust-1", company_name: "ACME P/L", abn: "51824753556" }];

    const result = reconcileSheets(source, canonical, undefined, "customers");

    expect(result.conflicts.every((r) => r.matchedBy === "fuzzy")).toBe(true);
  });
});

describe("reconcileSheets — canonical columns withheld (viewer lacks entity.view_pii)", () => {
  const src = sheet(
    ["email", "external_id", "first_name"],
    [{ email: "a@x.au", external_id: "E1", first_name: "Ann" }],
  );
  // email stripped from the canonical row, as the RPC does for a viewer without view_pii
  const canonical = [{ external_id: "E1", first_name: "Ann" }];

  it("falls back to a key the canonical rows carry instead of matching nothing", () => {
    const r = reconcileSheets(src, canonical);
    expect(r.matchKey).toBe("external_id");
    expect(r.matchKeyUnavailable).toBe(false);
    expect(r.matched).toHaveLength(1);
    expect(r.onlyInSource).toHaveLength(0);
  });

  it("flags matchKeyUnavailable when no usable key exists", () => {
    const r = reconcileSheets(sheet(["email"], [{ email: "a@x.au" }]), [{ external_id: "E1" }]);
    expect(r.matchKeyUnavailable).toBe(true);
  });

  it("is not unavailable when there are no canonical rows (genuinely empty)", () => {
    expect(reconcileSheets(src, []).matchKeyUnavailable).toBe(false);
  });
});
