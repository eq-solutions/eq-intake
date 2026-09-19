/**
 * Fuzzy duplicate detection + reconciliation decision support.
 *
 * The SY9 regression is the load-bearing case: four `app_data.sites` rows for
 * one physical site, only one holding the correct customer link, and that one
 * retired (active = false). The detector must (a) still cluster it despite
 * being inactive, and (b) refuse to confidently auto-pick a survivor when two
 * rows each carry a customer link.
 */

import { describe, it, expect, vi } from "vitest";
import {
  _detectForEntity as detectForEntity,
  matchAgainstLiveRecords,
  identityKeyFor,
} from "../src/duplicate-detect.js";

// Mirrors the live ehow shapes seen on 2026-07-13 (ids/customers anonymised).
const SY9_ROWS = [
  {
    // correct customer link, but RETIRED — the row that must survive
    site_id: "2dfa57bb",
    name: "SY9",
    code: null,
    customer_id: "cust-correct",
    active: false,
    service_enabled: true,
    address_line_1: "8-10 Grand Ave",
    suburb: "Rosehill",
    state: "NSW",
  },
  {
    // active, but WRONG customer — carries the stray operational data
    site_id: "95cdc37d",
    name: "SY9",
    code: "SY9",
    customer_id: "cust-wrong",
    active: true,
    service_enabled: false,
    address_line_1: "8 Grand Avenue",
    suburb: "Camellia",
    state: "NSW",
    postcode: "2142",
  },
  {
    // active, no customer — code-only Service row
    site_id: "a60b8eed",
    name: "Equinix SY9",
    code: "SY9",
    customer_id: null,
    active: true,
    service_enabled: false,
    address_line_1: "8 Grand Ave, Rosehill NSW",
  },
];

describe("detectForEntity — sites: SY9 regression", () => {
  const report = detectForEntity("sites", SY9_ROWS);

  it("produces exactly one cluster covering the SY9 family", () => {
    expect(report.clusters).toHaveLength(1);
    const ids = report.clusters[0]!.record_ids.slice().sort();
    expect(ids).toEqual(["2dfa57bb", "95cdc37d", "a60b8eed"]);
  });

  it("does NOT drop the inactive-but-correct row (the silent-failure fix)", () => {
    const cluster = report.clusters[0]!;
    const retired = cluster.members.find((m) => m.id === "2dfa57bb");
    expect(retired).toBeDefined();
    expect(retired!.active).toBe(false);
    expect(retired!.has_customer_link).toBe(true);
  });

  it("flags the cluster as needing reconciliation", () => {
    expect(report.clusters[0]!.needs_reconcile).toBe(true);
    expect(report.needs_reconcile).toBe(1);
  });

  it("marks the survivor pick LOW confidence — two rows carry a customer link", () => {
    // Two customer links (one correct, one wrong) + two active rows: the engine
    // must not confidently auto-pick. Low confidence == "ask a human".
    expect(report.clusters[0]!.survivor_confidence).toBe("low");
  });

  it("clusters the code-only row despite its different name", () => {
    // 'Equinix SY9' shares code 'SY9' with '95cdc37d' — name fuzz alone would
    // not reliably reach it; the code exact-match signal does.
    expect(report.clusters[0]!.record_ids).toContain("a60b8eed");
  });
});

describe("detectForEntity — sites: already-resolved cluster is not noise", () => {
  const rows = [
    {
      site_id: "keep",
      name: "Depot North",
      customer_id: "cust-1",
      active: true,
      address_line_1: "1 Main St",
    },
    {
      site_id: "retired",
      name: "Depot North",
      customer_id: null,
      active: false,
      address_line_1: "1 Main St",
    },
  ];
  const report = detectForEntity("sites", rows);

  it("still detects the pair (inactive rows are included)", () => {
    expect(report.clusters).toHaveLength(1);
  });

  it("does NOT flag it — one active survivor that holds the link", () => {
    const cluster = report.clusters[0]!;
    expect(cluster.recommended_survivor_id).toBe("keep");
    expect(cluster.survivor_confidence).toBe("high");
    expect(cluster.needs_reconcile).toBe(false);
    expect(report.needs_reconcile).toBe(0);
  });
});

describe("detectForEntity — survivor selection", () => {
  it("prefers the customer-linked row even when it is retired", () => {
    const rows = [
      { site_id: "linked", name: "Site X", customer_id: "c1", active: false, address_line_1: "5 Elm Rd" },
      { site_id: "orphan", name: "Site X", customer_id: null, active: true, address_line_1: "5 Elm Rd" },
    ];
    const cluster = detectForEntity("sites", rows).clusters[0]!;
    expect(cluster.recommended_survivor_id).toBe("linked");
    // one link, one active-but-different: survivor is retired ⇒ needs reconcile
    expect(cluster.needs_reconcile).toBe(true);
  });

  it("breaks ties by completeness when link + active are equal", () => {
    const rows = [
      { site_id: "sparse", name: "Yard", customer_id: "c1", active: true, address_line_1: "9 Oak" },
      { site_id: "full", name: "Yard", customer_id: "c1", active: true, address_line_1: "9 Oak", suburb: "Ryde", state: "NSW", postcode: "2112" },
    ];
    const cluster = detectForEntity("sites", rows).clusters[0]!;
    // both linked + active ⇒ low confidence, but the fuller row is suggested
    expect(cluster.recommended_survivor_id).toBe("full");
    expect(cluster.survivor_confidence).toBe("low");
  });
});

describe("detectForEntity — backward compatibility + isolation", () => {
  it("keeps the original cluster fields", () => {
    const cluster = detectForEntity("sites", SY9_ROWS).clusters[0]!;
    expect(cluster).toHaveProperty("record_ids");
    expect(cluster).toHaveProperty("labels");
    expect(cluster).toHaveProperty("similarity");
    expect(cluster).toHaveProperty("match_field");
    expect(cluster).toHaveProperty("confidence");
  });

  it("returns no clusters for distinct sites", () => {
    const rows = [
      { site_id: "a", name: "North Depot", customer_id: "c1", active: true, address_line_1: "1 First Ave" },
      { site_id: "b", name: "Harbour Tower", customer_id: "c2", active: true, address_line_1: "200 Kent St" },
    ];
    const report = detectForEntity("sites", rows);
    expect(report.clusters).toHaveLength(0);
    expect(report.needs_reconcile).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchAgainstLiveRecords — intake-time "does this already exist"
// ---------------------------------------------------------------------------

const EXISTING_CUSTOMERS = [
  { customer_id: "cust-1", company_name: "ERGO GROUP PTY LTD", active: true },
  { customer_id: "cust-2", company_name: "Kilo Group", active: true },
];

describe("matchAgainstLiveRecords", () => {
  it("matches a new row against an existing one under trivially different spelling", async () => {
    const lookup = vi.fn(async () => EXISTING_CUSTOMERS);
    const results = await matchAgainstLiveRecords("customers", ["ergo group"], lookup);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "cust-1", label: "ERGO GROUP PTY LTD" });
    expect(results[0]!.similarity).toBeGreaterThanOrEqual(0.85);
    expect(lookup).toHaveBeenCalledWith("customers");
  });

  it("does not match 'SKS' against 'SKS Technology' — same boundary as the within-file check", async () => {
    const lookup = vi.fn(async () => [
      { customer_id: "cust-9", company_name: "SKS Technology", active: true },
    ]);
    const results = await matchAgainstLiveRecords("customers", ["SKS"], lookup);
    expect(results).toEqual([null]);
  });

  it("returns null for a row with no live match, alongside a matched row in the same call", async () => {
    // Callers pass already-normalised keys (identityKeyFor's own output) —
    // matchAgainstLiveRecords compares like-for-like, it doesn't normalise
    // the "new" side itself. See previewDuplicatesAgainstLive for the real
    // caller shape.
    const lookup = vi.fn(async () => EXISTING_CUSTOMERS);
    const keys = [
      identityKeyFor("customers", { company_name: "Kilo Group" }),
      identityKeyFor("customers", { company_name: "Orise" }),
    ];
    const results = await matchAgainstLiveRecords("customers", keys, lookup);
    expect(results[0]).toMatchObject({ id: "cust-2" });
    expect(results[1]).toBeNull();
  });

  it("never calls the lookup when no candidate key has usable identity data", async () => {
    const lookup = vi.fn(async () => EXISTING_CUSTOMERS);
    const results = await matchAgainstLiveRecords("customers", [null, ""], lookup);
    expect(results).toEqual([null, null]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("picks the highest-similarity live row when more than one is close", async () => {
    const lookup = vi.fn(async () => [
      { customer_id: "cust-a", company_name: "Ergo Group Holdings", active: true },
      { customer_id: "cust-b", company_name: "Ergo Group Pty Ltd", active: true },
    ]);
    const key = identityKeyFor("customers", { company_name: "Ergo Group Pty Ltd" });
    const results = await matchAgainstLiveRecords("customers", [key], lookup);
    expect(results[0]).toMatchObject({ id: "cust-b" });
    expect(results[0]!.similarity).toBe(1); // exact match after normalisation, not just closest
  });
});
