/**
 * Timesheet report grouping — synthetic data only (no real people or hours).
 */
import { describe, it, expect } from "vitest";
import { actorFor, groupReport, renderReportMarkdown } from "../src/skills/timesheet-reconcile/report.js";
import type { LineResult, ReconcileReport } from "../src/skills/timesheet-reconcile/index.js";

const line = (o: Partial<LineResult>): LineResult => ({
  person: "Pat Example",
  date: "2026-09-01",
  payType: "Base Hourly",
  kind: "job",
  key: "10001",
  pdfHours: 8,
  appHours: 8,
  verdict: "match",
  detail: "",
  ...o,
});

const report = (lines: LineResult[], extra: Partial<ReconcileReport> = {}): ReconcileReport => ({
  lines,
  documents: [],
  skipped: [],
  noFile: [],
  unmatchedPeople: [],
  dayTotals: [],
  hoursArithmetic: [],
  counts: { match: 0, "missing-in-app": 0, "hours-differ": 0, conflict: 0, "pending-leave": 0, "unknown-pay-type": 0, "app-only": 0 },
  ...extra,
});

describe("timesheet report grouping", () => {
  it("routes verdicts to the right actor", () => {
    expect(actorFor(line({ verdict: "match" }))).toBeNull();
    expect(actorFor(line({ verdict: "missing-in-app" }))).toBeNull();
    expect(actorFor(line({ verdict: "hours-differ" }))).toBe("supervisor");
    expect(actorFor(line({ verdict: "conflict", key: null }))).toBe("supervisor");
    expect(actorFor(line({ verdict: "conflict", kind: "leave", key: "annual" }))).toBe("approver");
    expect(actorFor(line({ verdict: "conflict", kind: "roster-tafe", key: "TAFE" }))).toBe("approver");
    expect(actorFor(line({ verdict: "pending-leave", kind: "leave" }))).toBe("approver");
    expect(actorFor(line({ verdict: "unknown-pay-type", kind: "unknown", key: null }))).toBe("admin");
  });

  it("splits supervisor lines and sorts each by size of difference", () => {
    const g = groupReport(
      report([
        line({ verdict: "conflict", key: null, pdfHours: 8, appHours: null, detail: "no job code" }),
        line({ verdict: "conflict", key: "10002", pdfHours: 4, appHours: null }),
        line({ verdict: "hours-differ", pdfHours: 8, appHours: 7.5 }),
        line({ verdict: "hours-differ", pdfHours: 8, appHours: 4, date: "2026-09-02" }),
        line({ verdict: "app-only", payType: "", pdfHours: null, appHours: 2, date: "2026-09-03" }),
        line({ verdict: "match" }),
      ]),
    );
    expect(g.supervisor.noNote).toHaveLength(1);
    expect(g.supervisor.jobMismatch).toHaveLength(1);
    expect(g.supervisor.hours.map((l) => Math.abs((l.pdfHours ?? 0) - (l.appHours ?? 0)))).toEqual([4, 2, 0.5]);
  });

  it("puts leave clashes and pending leave under the approver", () => {
    const g = groupReport(
      report([
        line({ verdict: "conflict", kind: "leave", key: "sick", pdfHours: 8, appHours: null }),
        line({ verdict: "pending-leave", kind: "leave", key: "annual", pdfHours: 8, appHours: null }),
      ]),
    );
    expect(g.approver.leaveClash).toHaveLength(1);
    expect(g.approver.pending).toHaveLength(1);
    expect(g.supervisor.jobMismatch).toHaveLength(0);
  });

  it("collects admin items and filters by --from", () => {
    const r = report([line({ verdict: "unknown-pay-type", kind: "unknown", key: null, payType: "Mystery Pay" }), line({ verdict: "unknown-pay-type", kind: "unknown", key: null, date: "2026-07-01" })], {
      unmatchedPeople: ["Zed Example", "Ann Example"],
      noFile: [
        { person: "Lee Example", weekEnding: "2026-09-06", appHours: 16 },
        { person: "Kim Example", weekEnding: "2026-06-07", appHours: 40 },
      ],
      skipped: [
        { person: "Pat Example", weekEnding: "2026-09-06", status: "Not Opened", reason: "status not included" },
        { person: "Pat Example", weekEnding: "2026-06-07", status: "Not Opened", reason: "old" },
      ],
    });
    const all = groupReport(r);
    expect(all.admin.unknownPayTypes).toHaveLength(2);
    expect(all.admin.peopleNotInField).toEqual(["Ann Example", "Zed Example"]);
    expect(all.admin.noDocument.map((x) => x.appHours)).toEqual([40, 16]);
    const cut = groupReport(r, { from: "2026-08-31" });
    expect(cut.admin.unknownPayTypes).toHaveLength(1);
    expect(cut.admin.noDocument).toHaveLength(1);
    expect(cut.admin.skipped).toHaveLength(1);
  });

  it("lists only disagreeing days, biggest gap first, and counts missing-in-app", () => {
    const g = groupReport(
      report([line({ verdict: "missing-in-app", appHours: null }), line({ verdict: "match" })], {
        dayTotals: [
          { person: "Pat Example", date: "2026-09-01", pdfHours: 8, appHours: 8, agree: true },
          { person: "Pat Example", date: "2026-09-02", pdfHours: 8, appHours: 7, agree: false },
          { person: "Lee Example", date: "2026-09-02", pdfHours: 8, appHours: 0, agree: false },
        ],
      }),
    );
    expect(g.days.map((d) => d.person)).toEqual(["Lee Example", "Pat Example"]);
    expect(g.missingInApp).toBe(1);
  });

  it("renders every group heading with its count", () => {
    const md = renderReportMarkdown(report([line({ verdict: "hours-differ", pdfHours: 8, appHours: 6 })]));
    for (const h of [
      "## Supervisor",
      "### No job note — confirm with the supervisor (0)",
      "### Job code does not match Field (0)",
      "### Hours differ (1)",
      "## Approver",
      "### Leave type clashes (0)",
      "### Pending leave requests (0)",
      "## Admin",
      "### Unknown pay types (0)",
      "### People not in Field (0)",
      "### Field hours with no document (0)",
      "### Documents skipped (0)",
      "## Hours summary",
    ])
      expect(md).toContain(h);
    expect(md).toContain("| Pat Example | 2026-09-01 | Base Hourly | 10001 | 8 | 6 | hours-differ |");
  });
});
