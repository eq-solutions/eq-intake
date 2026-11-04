/**
 * Timesheet reconcile — write plan. PURE: no database access, no side effects.
 *
 * Turns a ReconcileReport plus a snapshot of the existing timesheet rows into
 * a list of rows a *separate, approved* writer could insert or update. This
 * module never writes anything itself.
 *
 * Rules (from the product owner):
 *  - Only job-code lines are written. TAFE and leave lines are checked, never written.
 *  - New rows get status "submitted", never "approved".
 *  - Existing rows are updated only while their status is draft or submitted.
 *    approved / paid / rejected rows are skipped and listed.
 *  - Never delete. Field rows missing from the PDF are only reported (`fieldOnly`).
 *  - Idempotent on the unique key (staff_id, date, task): once a plan has been applied,
 *    planning the same input again yields no inserts and no updates.
 *  - A person who does not match stops that person's lines only (`blocked`).
 *  - Every planned row carries imported_from "payroll-pdf" and the batch intake_id.
 */
import { normaliseName } from "./reconcile.js";
import type { FieldSnapshot, LineResult, ReconcileReport } from "./types.js";

/** A row already in app_data.timesheets. */
export interface ExistingTimesheetRow {
  timesheetId?: string;
  staffId: string;
  date: string;
  task: string | null;
  hours: number;
  status: string;
}

export interface WritePlanOptions {
  /** One id for the whole batch; becomes intake_id on every planned row. */
  intakeId: string;
  /** Statuses an existing row may be updated in. */
  updatableStatuses?: string[];
  /** Status given to new rows. Fixed to "submitted"; exposed only so tests can prove it is never "approved". */
  newRowStatus?: "submitted" | "draft";
  /** Only plan lines from documents with one of these portal statuses (case-insensitive). Default: all reconciled. */
  onlyDocStatuses?: string[];
  hoursTolerance?: number;
}

export const IMPORTED_FROM = "payroll-pdf";

interface PlannedBase {
  staffId: string;
  personName: string;
  date: string;
  task: string;
  hours: number;
  importedFrom: typeof IMPORTED_FROM;
  intakeId: string;
  reason: string;
}
export interface PlannedInsert extends PlannedBase {
  status: "submitted" | "draft";
}
export interface PlannedUpdate extends PlannedBase {
  timesheetId?: string;
  /** Hours and status before the update. */
  was: { hours: number; status: string };
  /** Status is left as it is. */
  status: string;
}
export interface PlannedSkip {
  personName: string;
  date: string;
  task: string | null;
  hours: number | null;
  reason: string;
}
export interface WritePlan {
  intakeId: string;
  importedFrom: typeof IMPORTED_FROM;
  inserts: PlannedInsert[];
  updates: PlannedUpdate[];
  /** Lines and rows deliberately not written, each with the reason. */
  skipped: PlannedSkip[];
  /** Existing rows already equal to the PDF (idempotent no-ops). */
  unchanged: number;
  /** People whose lines were stopped because they could not be matched to Field. */
  blocked: string[];
  /** Field rows in a reconciled week that the PDF does not account for. Reported, never deleted. */
  fieldOnly: { personName: string; date: string; task: string | null; hours: number; status: string }[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

export function isEmptyPlan(p: WritePlan): boolean {
  return p.inserts.length === 0 && p.updates.length === 0;
}

export function buildWritePlan(
  report: ReconcileReport,
  people: FieldSnapshot["people"],
  existing: ExistingTimesheetRow[],
  opts: WritePlanOptions,
): WritePlan {
  const tol = opts.hoursTolerance ?? 0.01;
  const updatable = new Set((opts.updatableStatuses ?? ["draft", "submitted"]).map((s) => s.toLowerCase()));
  const newStatus = opts.newRowStatus ?? "submitted";
  const only = opts.onlyDocStatuses?.map((s) => s.toLowerCase());
  const plan: WritePlan = {
    intakeId: opts.intakeId,
    importedFrom: IMPORTED_FROM,
    inserts: [],
    updates: [],
    skipped: [],
    unchanged: 0,
    blocked: [...new Set(report.unmatchedPeople)].sort(),
    fieldOnly: [],
  };

  const idOf = (name: string) => people.find((p) => normaliseName(p.name) === normaliseName(name))?.id ?? null;
  const lines = report.lines.filter((l) => !only || (l.docStatus && only.includes(l.docStatus.toLowerCase())));

  // PDF lines per person-day.
  const byDay = new Map<string, LineResult[]>();
  for (const l of lines) {
    if (l.verdict === "app-only" || l.verdict === "unknown-pay-type") continue;
    const k = `${l.person}|${l.date}`;
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(l);
  }

  // Existing rows a PDF line accounts for, so the rest can be reported as Field-only.
  const accounted = new Set<ExistingTimesheetRow>();

  for (const [k, dayLines] of byDay) {
    const [person, date] = k.split("|") as [string, string];
    const staffId = idOf(person);
    if (!staffId) continue; // reconcile already listed unmatched people; nothing to plan
    const dayRows = existing.filter((r) => r.staffId === staffId && r.date === date);

    // Non-job PDF lines (TAFE, leave, codes): checked, never written. Their Field rows are accounted for.
    for (const l of dayLines.filter((x) => x.kind !== "job")) {
      for (const row of dayRows) if (l.key && same(row.task, l.key)) accounted.add(row);
      for (const row of dayRows) if (l.key && row.task && row.task.toLowerCase().includes(l.key.toLowerCase())) accounted.add(row);
    }
    const nonJobKeys = dayLines.filter((x) => x.kind !== "job").map((x) => (x.key ?? "").toLowerCase());

    // Job lines with a code, merged per task.
    const jobs = new Map<string, number>();
    for (const l of dayLines.filter((x) => x.kind === "job")) {
      if (!l.key) {
        plan.skipped.push({ personName: person, date, task: null, hours: l.pdfHours, reason: "no job code on the PDF line - confirm with the supervisor" });
        continue;
      }
      jobs.set(l.key, r2((jobs.get(l.key) ?? 0) + (l.pdfHours ?? 0)));
    }

    // Rows on this day that nothing in the PDF accounts for (another job, or a different leave/TAFE code).
    const unaccounted = (task: string) =>
      dayRows.filter(
        (r) =>
          !jobs.has(r.task ?? "") &&
          !Array.from(jobs.keys()).some((j) => same(r.task, j)) &&
          !(r.task && nonJobKeys.some((nk) => nk && r.task!.toLowerCase().includes(nk))) &&
          !same(r.task, task),
      );

    for (const [task, hours] of jobs) {
      const row = dayRows.find((r) => same(r.task, task));
      if (row) {
        accounted.add(row);
        if (Math.abs(row.hours - hours) <= tol) {
          plan.unchanged++;
        } else if (updatable.has(row.status.toLowerCase())) {
          plan.updates.push({
            staffId,
            personName: person,
            date,
            task: row.task ?? task,
            hours,
            importedFrom: IMPORTED_FROM,
            intakeId: opts.intakeId,
            reason: `hours ${r2(row.hours)} -> ${hours} (row is ${row.status})`,
            ...(row.timesheetId ? { timesheetId: row.timesheetId } : {}),
            was: { hours: row.hours, status: row.status },
            status: row.status,
          });
        } else {
          plan.skipped.push({
            personName: person,
            date,
            task,
            hours,
            reason: `Field row is ${row.status} (${r2(row.hours)}h) - not updated, PDF says ${hours}h`,
          });
        }
        continue;
      }
      const other = unaccounted(task);
      if (other.length) {
        plan.skipped.push({
          personName: person,
          date,
          task,
          hours,
          reason: `Field has ${other.map((r) => `${r.task ?? "(no task)"} ${r2(r.hours)}h`).join(", ")} that day that the PDF does not account for - not inserted`,
        });
        continue;
      }
      plan.inserts.push({
        staffId,
        personName: person,
        date,
        task,
        hours,
        status: newStatus,
        importedFrom: IMPORTED_FROM,
        intakeId: opts.intakeId,
        reason: "no Field row for this job on this day",
      });
    }
  }

  // Field rows in a reconciled week that no PDF line accounts for: report only, never delete.
  const reconciled = new Map<string, Set<string>>(); // person -> week endings
  for (const l of lines) {
    if (!l.weekEnding) continue;
    (reconciled.get(l.person) ?? reconciled.set(l.person, new Set()).get(l.person)!).add(l.weekEnding);
  }
  for (const d of report.documents.filter((x) => !only || only.includes(x.status.toLowerCase()))) {
    (reconciled.get(d.person) ?? reconciled.set(d.person, new Set()).get(d.person)!).add(d.weekEnding);
  }
  for (const [person, weeks] of reconciled) {
    const staffId = idOf(person);
    if (!staffId) continue;
    for (const we of weeks) {
      const from = addDays(we, -6);
      for (const row of existing.filter((r) => r.staffId === staffId && r.date >= from && r.date <= we)) {
        if (accounted.has(row)) continue;
        plan.fieldOnly.push({ personName: person, date: row.date, task: row.task, hours: row.hours, status: row.status });
      }
    }
  }
  plan.fieldOnly.sort((a, b) => a.personName.localeCompare(b.personName) || a.date.localeCompare(b.date));

  return plan;
}
