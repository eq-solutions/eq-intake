/**
 * Local runner (read-only): compare a staff licence CSV against a jvkn
 * snapshot JSON. Opens no network or database connection. Writes only to the
 * --out file you name.
 *
 *   tsx scripts/licence-compare-run.ts --snapshot snap.json --file licences.csv [--out report.json]
 *
 * The CSV needs an email column, a licence type column and, ideally, number and
 * expiry columns. Snapshot: see scripts/licence-snapshot.sql.
 */
import fs from "node:fs";
import { parseCsv } from "../src/readers/csv.js";
import { compareLicences, rowsFromSheet } from "../src/skills/licence-compare/index.js";
import type { JvknSnapshot } from "../src/skills/licence-compare/index.js";

const args = process.argv.slice(2);
let snapPath = "";
let filePath = "";
let outPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--snapshot") snapPath = args[++i] ?? "";
  else if (args[i] === "--file") filePath = args[++i] ?? "";
  else if (args[i] === "--out") outPath = args[++i] ?? "";
}
if (!snapPath || !filePath) {
  console.error("usage: licence-compare-run --snapshot snap.json --file licences.csv [--out report.json]");
  process.exit(2);
}

// Snapshot tuples (compact) or objects, same convention as the timesheet runner.
//   workers  [user_id, email]
//   licences [id, user_id, licence_type, licence_number, expiry_date, never_expires]
const raw = JSON.parse(fs.readFileSync(snapPath, "utf8"));
const snapshot: JvknSnapshot = {
  workers: raw.workers.map((w: any) => (Array.isArray(w) ? { userId: String(w[0]), email: String(w[1] ?? "") } : w)),
  licences: raw.licences.map((l: any) =>
    Array.isArray(l)
      ? {
          id: String(l[0]),
          userId: String(l[1]),
          licenceType: String(l[2] ?? ""),
          licenceNumber: String(l[3] ?? ""),
          expiryDate: l[4] ? String(l[4]).slice(0, 10) : "",
          neverExpires: Boolean(l[5]),
        }
      : l,
  ),
};

const sheet = await parseCsv(new Uint8Array(fs.readFileSync(filePath)));
const report = compareLicences(rowsFromSheet(sheet.rows), snapshot);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`Rows read: ${sheet.rows.length}`);
for (const l of report.lines)
  console.log(`row ${pad(String(l.rowNumber), 4)} ${pad(l.verdict, 18)} ${pad(l.licenceType, 24)} file ${pad(l.fileExpiry || "-", 11)} jvkn ${pad(l.jvknExpiry || "-", 11)} ${l.detail}`);
console.log("\n== Counts ==\n" + JSON.stringify(report.counts));

if (outPath) fs.writeFileSync(outPath, JSON.stringify({ report }, null, 2));
