import { describe, it, expect } from "vitest";
import { buildOverviewWork } from "../src/overview-work.js";
import type { HealthScore } from "../src/health-score.js";
import type { ComplianceMetrics } from "../src/compliance-metrics.js";

const labels = {
  entity: (e: string) => ({ staff: "Staff", contacts: "Contacts", customers: "Customers" }[e] ?? e),
  field:  (f: string) => f.replace(/_/g, " "),
};

const hs = (entity: string, total: number, gapCounts: Record<string, number>): HealthScore => ({
  entity, total, complete: total, score: 1, started: total > 0, validity: 1, freshness: 1,
  gaps: Object.keys(gapCounts), gapCounts,
});

const cm = (over: Partial<ComplianceMetrics["staff"]> = {}): ComplianceMetrics => ({
  staff: { total: 115, has_email: 100, has_phone: 100, has_trade: 100, has_emergency_contact: 62, ...over },
  licences: { total: 38 },
});

const licences = { records_total: 38, total: 9, critical: 4, warning: 3, info: 2, alerts_failed: 0 };

const base = {
  scores: [hs("staff", 115, { emergency_contact_name: 53 }), hs("contacts", 206, { email: 18, phone: 67 })],
  licences, compliance: cm(), orphans: null, dupes: null, labels,
};

describe("buildOverviewWork", () => {
  it("ranks expired licences first, then safety fields, then the rest by size", () => {
    const w = buildOverviewWork(base);
    expect(w.items[0]!.id).toBe("licences.expiring");
    expect(w.items[0]!.tag?.text).toBe("Expired");
    expect(w.items[1]!.id).toBe("staff.emergency_contact_name");
    expect(w.items[1]!.kind).toBe("person");
    expect(w.items[1]!.tag?.text).toBe("Safety");
  });

  it("totals what's left and splits it by who has to do it", () => {
    const w = buildOverviewWork(base);
    expect(w.total).toBe(9 + 53 + 18 + 67);
    expect(w.byKind.person).toBe(9 + 53);
    expect(w.byKind.quick_edit).toBe(18 + 67);
    expect(w.byKind.decide).toBe(0);
  });

  it("never counts duplicates until the scan has run, then adds a decide item", () => {
    expect(buildOverviewWork(base).items.some((i) => i.kind === "decide")).toBe(false);
    const w = buildOverviewWork({
      ...base,
      dupes: [{ entity: "contacts", clusters: [{}, {}, {}] as never, total_records: 206, affected: 6, needs_reconcile: 3 }],
    });
    const d = w.items.find((i) => i.kind === "decide")!;
    expect(d.count).toBe(3);
    expect(d.title).toBe("Decide on 3 possible contacts duplicates");
    const merged = buildOverviewWork({
      ...base,
      dupes: [{ entity: "sites", clusters: [{}, {}] as never, total_records: 210, affected: 4, needs_reconcile: 0 }],
    });
    expect(merged.items.some((i) => i.kind === "decide")).toBe(false);
  });

  it("a record with anything to fix is never reported as nothing to fix", () => {
    const w = buildOverviewWork(base);
    const customers = buildOverviewWork({ ...base, scores: [hs("customers", 52, { abn: 5 })] }).records[0]!;
    expect(customers.toFix).toBe(5);
    expect(w.records.find((r) => r.entity === "staff")!.toFix).toBe(53);
  });

  it("reports skipped checks for a viewer who can't see personal details, and marks staff and contacts partly checked", () => {
    const w = buildOverviewWork({
      ...base,
      compliance: cm({ has_email: null, has_phone: null, has_emergency_contact: null }),
    });
    expect(w.skipped).toEqual(["phone", "email", "emergency contact"]);
    expect(w.records.find((r) => r.entity === "staff")!.partlyChecked).toBe(true);
    expect(w.records.find((r) => r.entity === "contacts")!.partlyChecked).toBe(true);
  });

  it("counts a site missing its whole address once, not once per address field", () => {
    const w = buildOverviewWork({
      ...base,
      scores: [hs("sites", 264, { address_line_1: 264, suburb: 260, postcode: 264, state: 250 })],
    });
    const addr = w.items.filter((i) => i.entity === "sites");
    expect(addr).toHaveLength(1);
    expect(addr[0]!.title).toBe("Fill address on 264 sites");
    expect(addr[0]!.count).toBe(264);
    expect(w.records.find((r) => r.entity === "sites")!.toFix).toBe(264);
  });

  it("is empty and honest when nothing is wrong", () => {
    const w = buildOverviewWork({
      scores: [hs("staff", 10, {})], licences: { ...licences, total: 0, critical: 0 },
      compliance: cm(), orphans: null, dupes: null, labels,
    });
    expect(w.total).toBe(0);
    expect(w.items).toEqual([]);
  });

  it("asks to add licences when none are on file at all", () => {
    const w = buildOverviewWork({ ...base, licences: { ...licences, records_total: 0, total: 0 } });
    expect(w.items.find((i) => i.id === "licences.none")!.count).toBe(115);
  });
});
