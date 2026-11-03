/**
 * Timesheet write plan — synthetic data only (no real people or hours).
 */
import { describe, it, expect } from "vitest";
import { reconcile, buildWritePlan, isEmptyPlan, IMPORTED_FROM } from "../src/skills/timesheet-reconcile/index.js";
import type { ExistingTimesheetRow, ExtractedTimesheet, FieldSnapshot, WritePlan } from "../src/skills/timesheet-reconcile/index.js";

const P1 = { id: "p1", name: "Pat Example" };
const P2 = { id: "p2", name: "Sam Sample" };
const INTAKE = "00000000-0000-4000-8000-000000000001";

function entry(date: string, payType: string, hours: number, noteText: string | null = null) {
  return { date, payType, start: null, finish: null, breaksMin: null, hours, noteRef: null, noteText, allowances: [] };
}
function doc(personName: string, entries: ExtractedTimesheet["entries"], status = "Pending Approval"): ExtractedTimesheet {
  return {
    personName,
    weekEnding: "2026-11-01",
    award: "",
    status,
    entries,
    printedTotal: entries.reduce((a, e) => a + e.hours, 0),
    pages: [1],
    warnings: [],
  };
}
const snap = (over: Partial<FieldSnapshot> = {}): FieldSnapshot => ({ people: [P1, P2], timesheets: [], roster: [], leave: [], ...over });
const row = (staffId: string, date: string, task: string, hours: number, status: string): ExistingTimesheetRow => ({ staffId, date, task, hours, status });

function plan(docs: ExtractedTimesheet[], existing: ExistingTimesheetRow[], s = snap(), opts = {}): WritePlan {
  const report = reconcile(docs, s);
  return buildWritePlan(report, s.people, existing, { intakeId: INTAKE, ...opts });
}
/** What a writer would do with the plan: insert/update only, never delete. */
function apply(existing: ExistingTimesheetRow[], p: WritePlan): ExistingTimesheetRow[] {
  const out = existing.map((r) => ({ ...r }));
  for (const u of p.updates) {
    const r = out.find((x) => x.staffId === u.staffId && x.date === u.date && x.task === u.task)!;
    r.hours = u.hours;
  }
  for (const i of p.inserts) out.push({ staffId: i.staffId, date: i.date, task: i.task, hours: i.hours, status: i.status });
  return out;
}

describe("timesheet write plan", () => {
  it("plans a new job row as submitted, tagged with imported_from and the batch id", () => {
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001 Alpha")])], []);
    expect(p.inserts).toHaveLength(1);
    expect(p.inserts[0]).toMatchObject({
      staffId: "p1",
      date: "2026-10-26",
      task: "10001",
      hours: 8,
      status: "submitted",
      importedFrom: IMPORTED_FROM,
      intakeId: INTAKE,
    });
    expect(p.importedFrom).toBe("payroll-pdf");
    expect(p.intakeId).toBe(INTAKE);
  });

  it("never plans a row as approved", () => {
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001"), entry("2026-10-27", "Base Hourly", 8, "10002")])], []);
    expect(p.inserts.every((i) => i.status !== ("approved" as string))).toBe(true);
    expect(p.inserts.every((i) => i.status === "submitted")).toBe(true);
  });

  it("checks TAFE and leave lines but never writes them", () => {
    const s = snap({ roster: [{ personId: "p1", date: "2026-10-27", task: "TAFE", leaveType: "tafe" }] });
    const p = plan(
      [doc("Pat Example", [entry("2026-10-26", "Annual Leave", 8), entry("2026-10-27", "College/TAFE/Block Release", 8), entry("2026-10-28", "NECA Office / Training Day", 8)])],
      [],
      s,
    );
    expect(p.inserts).toHaveLength(0);
    expect(p.updates).toHaveLength(0);
  });

  it("updates an existing row only while it is draft or submitted", () => {
    const existing = [
      row("p1", "2026-10-26", "10001", 7, "draft"),
      row("p1", "2026-10-27", "10001", 7, "submitted"),
      row("p1", "2026-10-28", "10001", 7, "approved"),
      row("p1", "2026-10-29", "10001", 7, "paid"),
      row("p1", "2026-10-30", "10001", 7, "rejected"),
    ];
    const entries = ["26", "27", "28", "29", "30"].map((d) => entry(`2026-10-${d}`, "Base Hourly", 8, "10001"));
    const p = plan([doc("Pat Example", entries)], existing);
    expect(p.updates.map((u) => [u.date, u.hours, u.status, u.was.status])).toEqual([
      ["2026-10-26", 8, "draft", "draft"],
      ["2026-10-27", 8, "submitted", "submitted"],
    ]);
    expect(p.skipped.map((s) => s.date)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(p.skipped.every((s) => /not updated/.test(s.reason))).toBe(true);
    expect(p.inserts).toHaveLength(0);
  });

  it("is idempotent on (staff_id, date, task): applying the plan then re-planning is empty", () => {
    const docs = [doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001"), entry("2026-10-27", "Base Hourly", 6, "10002")])];
    const existing = [row("p1", "2026-10-27", "10002", 5, "submitted")];
    const first = plan(docs, existing);
    expect(first.inserts).toHaveLength(1);
    expect(first.updates).toHaveLength(1);
    const after = apply(existing, first);
    // the snapshot Field data the reconciler sees would now include those rows too
    const s = snap({ timesheets: after.map((r) => ({ staffId: r.staffId, date: r.date, hours: r.hours, task: r.task! })) });
    const second = plan(docs, after, s);
    expect(isEmptyPlan(second)).toBe(true);
    expect(second.unchanged).toBe(2);
  });

  it("never deletes: Field rows the PDF does not mention are only reported", () => {
    const existing = [row("p1", "2026-10-26", "10001", 8, "submitted"), row("p1", "2026-10-29", "10009", 4, "submitted")];
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001")])], existing);
    expect(p.fieldOnly).toEqual([{ personName: "Pat Example", date: "2026-10-29", task: "10009", hours: 4, status: "submitted" }]);
    expect(Object.keys(p)).not.toContain("deletes");
    expect(isEmptyPlan(p)).toBe(true);
  });

  it("stops only the unmatched person's lines", () => {
    const p = plan(
      [doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001")]), doc("Nobody Known", [entry("2026-10-26", "Base Hourly", 8, "10001")])],
      [],
    );
    expect(p.blocked).toEqual(["Nobody Known"]);
    expect(p.inserts.map((i) => i.personName)).toEqual(["Pat Example"]);
  });

  it("does not write a line with no job code, and lists it", () => {
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8)])], []);
    expect(p.inserts).toHaveLength(0);
    expect(p.skipped[0]!.reason).toContain("no job code");
  });

  it("does not insert beside a Field row the PDF does not account for", () => {
    const existing = [row("p1", "2026-10-26", "10009", 8, "submitted")];
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001")])], existing);
    expect(p.inserts).toHaveLength(0);
    expect(p.skipped[0]!.reason).toContain("10009");
  });

  it("merges two PDF entries on the same job and day into one planned row", () => {
    const p = plan([doc("Pat Example", [entry("2026-10-26", "Base Hourly", 4, "10001"), entry("2026-10-26", "Base Hourly", 4, "10001")])], []);
    expect(p.inserts).toHaveLength(1);
    expect(p.inserts[0]!.hours).toBe(8);
  });

  it("can be limited to documents with certain portal statuses", () => {
    const docs = [doc("Pat Example", [entry("2026-10-26", "Base Hourly", 8, "10001")], "Paid")];
    const s = snap();
    const report = reconcile(docs, s, { includeStatuses: ["paid"] });
    const p = buildWritePlan(report, s.people, [], { intakeId: INTAKE, onlyDocStatuses: ["Pending Approval"] });
    expect(p.inserts).toHaveLength(0);
  });
});
