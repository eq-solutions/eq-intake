/**
 * Timesheet reconcile — Markdown report grouped by who acts. Pure: takes a
 * ReconcileReport, returns text. Real names only ever appear in the caller's
 * output file.
 */
import type { LineResult, ReconcileReport } from "./types.js";

export type Actor = "supervisor" | "approver" | "admin";

export interface ReportOptions {
  /** ISO date; lines, day totals and no-file weeks before it are left out. */
  from?: string;
}

const n = (x: number | null) => (x === null ? "-" : String(Math.round(x * 100) / 100));
const gap = (l: { pdfHours: number | null; appHours: number | null }) => Math.abs((l.pdfHours ?? 0) - (l.appHours ?? 0));
const bySize = (a: LineResult, b: LineResult) => gap(b) - gap(a) || a.person.localeCompare(b.person) || a.date.localeCompare(b.date);

/** Who acts on a flagged line, or null when it needs nobody (match, nothing in the app). */
export function actorFor(l: LineResult): Actor | null {
  switch (l.verdict) {
    case "unknown-pay-type":
      return "admin";
    case "pending-leave":
      return "approver";
    case "hours-differ":
    case "app-only":
      return "supervisor";
    case "conflict":
      return l.kind === "leave" || l.kind === "roster-tafe" ? "approver" : "supervisor";
    default:
      return null;
  }
}

function lineTable(lines: LineResult[]): string {
  if (!lines.length) return "_Nothing to action._\n";
  const rows = lines.map(
    (l) => `| ${l.person} | ${l.date} | ${l.payType || "(Field only)"} | ${l.key ?? "-"} | ${n(l.pdfHours)} | ${n(l.appHours)} | ${l.verdict} | ${l.detail.replace(/\|/g, "/")} |`,
  );
  return ["| Person | Date | Pay type | Key | PDF h | Field h | Verdict | Detail |", "|---|---|---|---|---|---|---|---|", ...rows, ""].join("\n");
}

export interface GroupedReport {
  supervisor: { noNote: LineResult[]; jobMismatch: LineResult[]; hours: LineResult[] };
  approver: { leaveClash: LineResult[]; pending: LineResult[] };
  admin: {
    unknownPayTypes: LineResult[];
    peopleNotInField: string[];
    noDocument: ReconcileReport["noFile"];
    skipped: ReconcileReport["skipped"];
  };
  days: ReconcileReport["dayTotals"];
  missingInApp: number;
}

export function groupReport(report: ReconcileReport, opts: ReportOptions = {}): GroupedReport {
  const from = opts.from ?? "";
  const lines = report.lines.filter((l) => l.date >= from);
  const mine = (a: Actor) => lines.filter((l) => actorFor(l) === a);
  const sup = mine("supervisor");
  const app = mine("approver");
  const isNoNote = (l: LineResult) => l.verdict === "conflict" && l.kind === "job" && l.key === null;
  return {
    supervisor: {
      noNote: sup.filter(isNoNote).sort(bySize),
      jobMismatch: sup.filter((l) => l.verdict === "conflict" && !isNoNote(l)).sort(bySize),
      hours: sup.filter((l) => l.verdict === "hours-differ" || l.verdict === "app-only").sort(bySize),
    },
    approver: {
      leaveClash: app.filter((l) => l.verdict === "conflict").sort(bySize),
      pending: app.filter((l) => l.verdict === "pending-leave").sort(bySize),
    },
    admin: {
      unknownPayTypes: mine("admin").sort(bySize),
      peopleNotInField: [...report.unmatchedPeople].sort(),
      noDocument: report.noFile.filter((x) => x.weekEnding >= from).sort((a, b) => b.appHours - a.appHours),
      skipped: report.skipped.filter((s) => s.weekEnding >= from),
    },
    days: report.dayTotals
      .filter((d) => d.date >= from && !d.agree)
      .sort((a, b) => Math.abs(b.pdfHours - b.appHours) - Math.abs(a.pdfHours - a.appHours) || a.person.localeCompare(b.person) || a.date.localeCompare(b.date)),
    missingInApp: lines.filter((l) => l.verdict === "missing-in-app").length,
  };
}

export function renderReportMarkdown(report: ReconcileReport, opts: ReportOptions = {}): string {
  const g = groupReport(report, opts);
  const out: string[] = ["# Timesheet reconcile report", ""];
  if (opts.from) out.push(`Showing dates from ${opts.from}.`, "");
  out.push(`Documents reconciled: ${report.documents.length}. Lines compared: ${report.lines.length}.`, "");

  out.push(`## Supervisor`, "");
  out.push(`### No job note — confirm with the supervisor (${g.supervisor.noNote.length})`, "", lineTable(g.supervisor.noNote));
  out.push(`### Job code does not match Field (${g.supervisor.jobMismatch.length})`, "", lineTable(g.supervisor.jobMismatch));
  out.push(`### Hours differ (${g.supervisor.hours.length})`, "", lineTable(g.supervisor.hours));

  out.push(`## Approver`, "");
  out.push(`### Leave type clashes (${g.approver.leaveClash.length})`, "", lineTable(g.approver.leaveClash));
  out.push(`### Pending leave requests (${g.approver.pending.length})`, "", lineTable(g.approver.pending));

  out.push(`## Admin`, "");
  out.push(`### Unknown pay types (${g.admin.unknownPayTypes.length})`, "", lineTable(g.admin.unknownPayTypes));
  out.push(`### People not in Field (${g.admin.peopleNotInField.length})`, "");
  out.push(g.admin.peopleNotInField.length ? g.admin.peopleNotInField.map((p) => `- ${p}`).join("\n") + "\n" : "_None._\n");
  out.push(`### Field hours with no document (${g.admin.noDocument.length})`, "");
  out.push(
    g.admin.noDocument.length
      ? ["| Person | Week ending | Field h |", "|---|---|---|", ...g.admin.noDocument.map((x) => `| ${x.person} | ${x.weekEnding} | ${n(x.appHours)} |`), ""].join("\n")
      : "_None._\n",
  );
  out.push(`### Documents skipped (${g.admin.skipped.length})`, "");
  out.push(
    g.admin.skipped.length
      ? ["| Person | Week ending | Status | Reason |", "|---|---|---|---|", ...g.admin.skipped.map((s) => `| ${s.person} | ${s.weekEnding} | ${s.status} | ${s.reason.replace(/\|/g, "/")} |`), ""].join("\n")
      : "_None._\n",
  );

  out.push(`## Hours summary — days where PDF and Field differ (${g.days.length})`, "");
  out.push(
    g.days.length
      ? ["| Person | Date | PDF h | Field h | Difference |", "|---|---|---|---|---|", ...g.days.map((d) => `| ${d.person} | ${d.date} | ${n(d.pdfHours)} | ${n(d.appHours)} | ${n(d.pdfHours - d.appHours)} |`), ""].join("\n")
      : "_All days agree._\n",
  );
  out.push(`_Not listed: ${g.missingInApp} line(s) where Field holds nothing for the day (verdict missing-in-app)._`, "");
  return out.join("\n");
}
