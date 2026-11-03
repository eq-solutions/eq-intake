/**
 * Local, PURE (no database access): build the write plan from a runner --out JSON,
 * the same snapshot the runner read, and an existing-rows JSON (timesheet-existing.sql).
 * Writes only the --out file you name. Nothing is applied anywhere.
 *
 *   tsx scripts/timesheet-plan.ts --in report.json --snapshot snapshot.json --existing existing.json --out plan.json [--intake-id <uuid>] [--only-status "Pending Approval,Approved"]
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { buildWritePlan } from "../src/skills/timesheet-reconcile/writeplan.js";
import type { ExistingTimesheetRow } from "../src/skills/timesheet-reconcile/writeplan.js";

const args = process.argv.slice(2);
const opt: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) opt[args[i]!] = args[i + 1]!;
if (!opt["--in"] || !opt["--snapshot"] || !opt["--existing"] || !opt["--out"]) {
  console.error("usage: timesheet-plan --in report.json --snapshot snapshot.json --existing existing.json --out plan.json [--intake-id uuid] [--only-status list]");
  process.exit(2);
}

const { report } = JSON.parse(fs.readFileSync(opt["--in"], "utf8"));
const snap = JSON.parse(fs.readFileSync(opt["--snapshot"], "utf8"));
const people = snap.people.map((p: any) => (Array.isArray(p) ? { id: String(p[1]), name: p[2] } : p));
const existing: ExistingTimesheetRow[] = JSON.parse(fs.readFileSync(opt["--existing"], "utf8")).map((r: any) =>
  Array.isArray(r) ? { staffId: String(r[0]), date: r[1], task: r[2], hours: Number(r[3]), status: r[4], timesheetId: r[5] } : r,
);

const plan = buildWritePlan(report, people, existing, {
  intakeId: opt["--intake-id"] ?? randomUUID(),
  ...(opt["--only-status"] ? { onlyDocStatuses: opt["--only-status"].split(",").map((s) => s.trim()) } : {}),
});
fs.writeFileSync(opt["--out"], JSON.stringify(plan, null, 2));
console.log(
  `plan: ${plan.inserts.length} insert(s), ${plan.updates.length} update(s), ${plan.skipped.length} skipped, ${plan.unchanged} unchanged, ${plan.fieldOnly.length} Field-only, ${plan.blocked.length} blocked person(s)`,
);
