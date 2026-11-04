/**
 * Local (read-only): turn a runner --out JSON into a Markdown report grouped by
 * who acts. Writes only to the --out path you name.
 *
 *   tsx scripts/timesheet-report.ts --in report.json --out report.md [--from 2026-08-31]
 */
import fs from "node:fs";
import { renderReportMarkdown } from "../src/skills/timesheet-reconcile/report.js";

const args = process.argv.slice(2);
let inPath = "";
let outPath = "";
let from: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--in") inPath = args[++i]!;
  else if (args[i] === "--out") outPath = args[++i]!;
  else if (args[i] === "--from") from = args[++i]!;
}
if (!inPath || !outPath) {
  console.error("usage: timesheet-report --in report.json --out report.md [--from YYYY-MM-DD]");
  process.exit(2);
}
const { report } = JSON.parse(fs.readFileSync(inPath, "utf8"));
fs.writeFileSync(outPath, renderReportMarkdown(report, from ? { from } : {}));
console.log(`wrote ${outPath}`);
