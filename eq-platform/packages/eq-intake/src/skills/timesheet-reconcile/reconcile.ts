/**
 * Timesheet reconcile — compare extracted timesheets with a Field snapshot.
 *
 * Pure and read-only: takes data in, returns a report. What each pay type
 * means (job / TAFE-on-roster / leave / literal code) comes from
 * `ReconcileConfig.payTypeRules`, so another award or payroll vocabulary is a
 * config change, not a code change. An unrecognised pay type is never
 * dropped — it is reported as `unknown-pay-type`.
 */
import {
  DEFAULT_CONFIG,
  type DocumentCheck,
  type ExtractedEntry,
  type ExtractedTimesheet,
  type FieldSnapshot,
  type LineResult,
  type PayTypeKind,
  type ReconcileConfig,
  type ReconcileReport,
  type SkippedDocument,
  type SnapshotPerson,
  type SnapshotTimesheet,
  type Verdict,
} from "./types.js";

export function normaliseName(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const comma = s.indexOf(",");
  if (comma >= 0) s = `${s.slice(comma + 1).trim()} ${s.slice(0, comma).trim()}`;
  return s.replace(/[^a-z' -]/g, "").replace(/\s+/g, " ").trim();
}

function findPerson(people: SnapshotPerson[], name: string): SnapshotPerson | null {
  const n = normaliseName(name);
  return people.find((p) => normaliseName(p.name) === n) ?? null;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

interface Resolved {
  kind: PayTypeKind | "unknown";
  value?: string;
}

function resolveRule(payType: string, cfg: ReconcileConfig): Resolved {
  for (const r of cfg.payTypeRules) {
    if (new RegExp(r.match, "i").test(payType)) return { kind: r.kind, value: r.value };
  }
  return { kind: "unknown" };
}

function jobCode(noteText: string | null, cfg: ReconcileConfig): string | null {
  if (!noteText) return null;
  const m = new RegExp(cfg.jobCodePattern, "i").exec(noteText);
  return m ? (m[1] ?? m[0]) : null;
}

export function reconcile(
  docs: ExtractedTimesheet[],
  snapshot: FieldSnapshot,
  config: Partial<ReconcileConfig> = {},
): ReconcileReport {
  const cfg: ReconcileConfig = { ...DEFAULT_CONFIG, ...config };
  const tol = cfg.hoursTolerance;
  const included = new Set(cfg.includeStatuses.map((s) => s.toLowerCase()));
  const tafe = new Set(cfg.tafeTaskValues.map((s) => s.toLowerCase()));
  const approved = new Set(cfg.approvedLeaveStatuses.map((s) => s.toLowerCase()));

  const lines: LineResult[] = [];
  const documents: DocumentCheck[] = [];
  const skipped: SkippedDocument[] = [];
  const unmatchedPeople: string[] = [];
  const reconciled = new Set<string>(); // `${personId}|${weekEnding}`

  for (const doc of docs) {
    if (!included.has(doc.status.toLowerCase())) {
      skipped.push({
        person: doc.personName,
        weekEnding: doc.weekEnding,
        status: doc.status,
        reason: `status "${doc.status || "none"}" not in includeStatuses`,
      });
      continue;
    }
    if (doc.entries.length === 0) {
      skipped.push({ person: doc.personName, weekEnding: doc.weekEnding, status: doc.status, reason: "no hours" });
      continue;
    }
    const total = sum(doc.entries.map((e) => e.hours));
    documents.push({
      person: doc.personName,
      weekEnding: doc.weekEnding,
      status: doc.status,
      printedTotal: doc.printedTotal,
      summedEntries: total,
      totalsAgree: doc.printedTotal === null ? null : near(doc.printedTotal, total, tol),
    });

    const person = findPerson(snapshot.people, doc.personName);
    if (!person) {
      unmatchedPeople.push(doc.personName);
      continue;
    }
    reconciled.add(`${person.id}|${doc.weekEnding}`);
    lines.push(...reconcileDocument(doc, person, snapshot, cfg, { included, tafe, approved }));
  }

  // People with app hours in a reconciled week but no document for them.
  const noFile: ReconcileReport["noFile"] = [];
  const weeks = [...new Set(documents.map((d) => d.weekEnding))];
  for (const we of weeks) {
    const from = addDays(we, -6);
    for (const p of snapshot.people) {
      if (reconciled.has(`${p.id}|${we}`)) continue;
      const hrs = sum(
        snapshot.timesheets.filter((t) => t.staffId === p.id && t.date >= from && t.date <= we).map((t) => t.hours),
      );
      if (hrs > 0) noFile.push({ person: p.name, weekEnding: we, appHours: hrs });
    }
  }

  const counts: Record<Verdict, number> = {
    match: 0,
    "missing-in-app": 0,
    "hours-differ": 0,
    conflict: 0,
    "unknown-pay-type": 0,
    "app-only": 0,
  };
  for (const l of lines) counts[l.verdict]++;
  return { lines, documents, skipped, noFile, unmatchedPeople, counts };
}

function reconcileDocument(
  doc: ExtractedTimesheet,
  person: SnapshotPerson,
  snap: FieldSnapshot,
  cfg: ReconcileConfig,
  sets: { included: Set<string>; tafe: Set<string>; approved: Set<string> },
): LineResult[] {
  const tol = cfg.hoursTolerance;
  const out: LineResult[] = [];
  const from = addDays(doc.weekEnding, -6);
  const appTs = snap.timesheets.filter((t) => t.staffId === person.id && t.date >= from && t.date <= doc.weekEnding);
  const consumed = new Set<SnapshotTimesheet>();
  const appOn = (date: string) => appTs.filter((t) => t.date === date);

  const push = (
    e: { date: string; payType: string },
    kind: LineResult["kind"],
    key: string | null,
    pdfHours: number | null,
    appHours: number | null,
    verdict: Verdict,
    detail: string,
  ) => out.push({ person: person.name, date: e.date, payType: e.payType, kind, key, pdfHours, appHours, verdict, detail });

  // Group entries that land on the same comparison target (a day may split across entries).
  interface Group {
    date: string;
    payType: string;
    res: Resolved;
    key: string | null;
    entries: ExtractedEntry[];
  }
  const groups = new Map<string, Group>();
  for (const e of doc.entries) {
    const res = resolveRule(e.payType, cfg);
    let key: string | null = null;
    if (res.kind === "job") key = jobCode(e.noteText, cfg);
    else if (res.kind === "leave" || res.kind === "code") key = res.value ?? null;
    else if (res.kind === "roster-tafe") key = "TAFE";
    const gk = `${e.date}|${res.kind}|${key ?? `?${e.payType}`}`;
    const g = groups.get(gk);
    if (g) g.entries.push(e);
    else groups.set(gk, { date: e.date, payType: e.payType, res, key, entries: [e] });
  }

  for (const g of groups.values()) {
    const hours = sum(g.entries.map((e) => e.hours));
    const ref = { date: g.date, payType: g.payType };
    const day = appOn(g.date);
    const dayDesc = () => {
      const bits = day.map((t) => `${t.task} ${t.hours}h`);
      const r = snap.roster.find((x) => x.personId === person.id && x.date === g.date);
      if (r && (r.leaveType || tafeLike(r.task))) bits.push(`roster ${r.leaveType ?? r.task}`);
      return bits.length ? bits.join(", ") : "nothing";
    };
    const tafeLike = (t: string | null) => !!t && sets.tafe.has(t.toLowerCase());

    switch (g.res.kind) {
      case "unknown":
        push(ref, "unknown", null, hours, null, "unknown-pay-type", `no payTypeRule matches "${g.payType}"`);
        break;

      case "job": {
        if (!g.key) {
          const rosterTafe = snap.roster.some(
            (x) => x.personId === person.id && x.date === g.date && (tafeLike(x.task) || tafeLike(x.leaveType)),
          );
          const appHrs = sum(day.map((t) => t.hours));
          const hint = rosterTafe
            ? `roster shows TAFE${day.length ? "" : " and the app has no hours"} (possibly TAFE keyed as a job line)`
            : `app has ${dayDesc()}${day.length && near(appHrs, hours, tol) ? " (hours agree, job unconfirmed)" : ""}`;
          push(ref, "job", null, hours, day.length ? appHrs : null, "conflict", `no job code in the note text, so no job comparison; ${hint}`);
          break;
        }
        const rows = day.filter((t) => t.task.toLowerCase() === g.key!.toLowerCase());
        rows.forEach((r) => consumed.add(r));
        if (rows.length === 0) {
          push(ref, "job", g.key, hours, null, day.length ? "conflict" : "missing-in-app", `app has ${dayDesc()} on this day`);
        } else {
          const app = sum(rows.map((r) => r.hours));
          push(ref, "job", g.key, hours, app, near(app, hours, tol) ? "match" : "hours-differ", "");
        }
        break;
      }

      case "roster-tafe": {
        const r = snap.roster.find(
          (x) => x.personId === person.id && x.date === g.date && (tafeLike(x.task) || tafeLike(x.leaveType)),
        );
        if (r) push(ref, "roster-tafe", "TAFE", hours, null, "match", "roster shows TAFE");
        else push(ref, "roster-tafe", "TAFE", hours, null, day.length ? "conflict" : "missing-in-app", `roster has no TAFE; app has ${dayDesc()}`);
        break;
      }

      case "leave": {
        const lt = g.key!.toLowerCase();
        const lr = snap.leave.find(
          (l) =>
            (l.staffId === person.id || (l.requesterName && normaliseName(l.requesterName) === normaliseName(person.name))) &&
            sets.approved.has(l.status.toLowerCase()) &&
            l.leaveType.toLowerCase() === lt &&
            l.dateStart <= g.date &&
            l.dateEnd >= g.date,
        );
        if (lr) {
          push(ref, "leave", g.key, hours, null, "match", `approved leave request ${lr.dateStart}..${lr.dateEnd}`);
          break;
        }
        const ts = day.find((t) => t.task.toLowerCase().includes(lt));
        const ro = snap.roster.find((x) => x.personId === person.id && x.date === g.date && x.leaveType?.toLowerCase() === lt);
        if (ts || ro) {
          if (ts) consumed.add(ts);
          const app = ts ? ts.hours : null;
          const ok = app === null || near(app, hours, tol);
          push(ref, "leave", g.key, hours, app, ok ? "match" : "hours-differ", `no approved leave request; matched on ${ts ? "timesheet" : "roster"} code`);
        } else {
          push(ref, "leave", g.key, hours, null, day.length || snap.roster.some((x) => x.personId === person.id && x.date === g.date && x.leaveType) ? "conflict" : "missing-in-app", `no approved ${g.key} leave request; app has ${dayDesc()}`);
        }
        break;
      }

      case "code": {
        const rows = day.filter((t) => t.task.toLowerCase() === g.key!.toLowerCase());
        rows.forEach((r) => consumed.add(r));
        if (rows.length === 0) {
          push(ref, "code", g.key, hours, null, day.length ? "conflict" : "missing-in-app", `app has ${dayDesc()} on this day`);
        } else {
          const app = sum(rows.map((r) => r.hours));
          push(ref, "code", g.key, hours, app, near(app, hours, tol) ? "match" : "hours-differ", "");
        }
        break;
      }
    }
  }

  for (const t of appTs) {
    if (consumed.has(t)) continue;
    // A day already flagged as a conflict has its app rows described on that line.
    if (out.some((l) => l.date === t.date && l.verdict === "conflict")) continue;
    out.push({
      person: person.name,
      date: t.date,
      payType: "",
      kind: "job",
      key: t.task,
      pdfHours: null,
      appHours: t.hours,
      verdict: "app-only",
      detail: "app hours the document does not account for",
    });
  }
  return out;
}
