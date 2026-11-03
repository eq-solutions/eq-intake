/**
 * Local runner (read-only): reconcile payroll-portal timesheet PDFs against a
 * Field snapshot JSON. Writes only to the --out file you name.
 *
 *   tsx scripts/timesheet-reconcile-run.ts --snapshot snap.json --out report.json <pdf-or-dir>...
 */
import fs from "node:fs";
import path from "node:path";
import { extractTimesheets, reconcile } from "../src/skills/timesheet-reconcile/index.js";
import type { ExtractedTimesheet, FieldSnapshot } from "../src/skills/timesheet-reconcile/index.js";

const args = process.argv.slice(2);
let snapPath = "";
let outPath = "";
const inputs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--snapshot") snapPath = args[++i]!;
  else if (args[i] === "--out") outPath = args[++i]!;
  else inputs.push(args[i]!);
}
if (!snapPath || inputs.length === 0) {
  console.error("usage: timesheet-reconcile-run --snapshot snap.json [--out report.json] <pdf|dir>...");
  process.exit(2);
}

// Snapshot is stored as compact tuples; accept either that or full objects.
const raw = JSON.parse(fs.readFileSync(snapPath, "utf8"));
const snapshot: FieldSnapshot = {
  people: raw.people,
  timesheets: raw.timesheets.map((t: any) => (Array.isArray(t) ? { staffId: t[0], date: t[1], hours: t[2], task: t[3] } : t)),
  roster: raw.roster.map((r: any) => (Array.isArray(r) ? { personId: r[0], date: r[1], task: r[2], leaveType: r[3] } : r)),
  leave: raw.leave.map((l: any) =>
    Array.isArray(l)
      ? { staffId: l[0], requesterName: l[1], leaveType: l[2], dateStart: l[3], dateEnd: l[4], hoursRequested: l[5], status: l[6] }
      : l,
  ),
};

const files: string[] = [];
for (const p of inputs) {
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) if (f.toLowerCase().endsWith(".pdf")) files.push(path.join(p, f));
  } else files.push(p);
}

const docs: ExtractedTimesheet[] = [];
for (const f of files) docs.push(...(await extractTimesheets(new Uint8Array(fs.readFileSync(f)))));

// Same person/week can arrive twice (zip + combined); keep the first.
const seen = new Set<string>();
const unique = docs.filter((d) => {
  const k = `${d.personName}|${d.weekEnding}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const weekFilter = process.env.WEEK_ENDING;
const includeStatuses = process.env.INCLUDE_STATUSES?.split(",").map((s) => s.trim());
const report = reconcile(weekFilter ? unique.filter((d) => d.weekEnding === weekFilter) : unique, snapshot, includeStatuses ? { includeStatuses } : {});

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`Documents read: ${docs.length} (${unique.length} unique person/week) from ${files.length} file(s)`);
console.log("\n== Documents ==");
for (const d of report.documents)
  console.log(`${pad(d.person, 22)} w/e ${d.weekEnding}  printed ${d.printedTotal ?? "-"}  summed ${d.summedEntries}  ${d.totalsAgree === false ? "MISMATCH" : "ok"}`);
console.log("\n== Lines ==");
for (const l of report.lines)
  console.log(`${pad(l.person, 22)} ${l.date} ${pad(l.verdict, 16)} ${pad(l.payType || "(app)", 28)} ${pad(String(l.key ?? ""), 8)} pdf ${l.pdfHours ?? "-"} app ${l.appHours ?? "-"}  ${l.detail}`);
console.log("\n== Skipped documents ==");
for (const s of report.skipped) console.log(`${pad(s.person, 22)} w/e ${s.weekEnding}  ${s.reason}`);
console.log("\n== No file (app hours, no document) ==");
for (const n of report.noFile) console.log(`${pad(n.person, 22)} w/e ${n.weekEnding}  app ${n.appHours}h`);
if (report.hoursArithmetic.length) console.log("\n== Hours arithmetic mismatches ==\n" + JSON.stringify(report.hoursArithmetic, null, 1));
if (report.unmatchedPeople.length) console.log("\n== People not in snapshot ==\n" + report.unmatchedPeople.join("\n"));
console.log("\n== Counts ==\n" + JSON.stringify(report.counts));
for (const d of docs) if (d.warnings.length) console.log(`warn ${d.personName} ${d.weekEnding}: ${d.warnings.join("; ")}`);

if (outPath) fs.writeFileSync(outPath, JSON.stringify({ report, documents: unique }, null, 2));
