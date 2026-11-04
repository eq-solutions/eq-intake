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

/** "7:30am" / "4:00pm" -> minutes since midnight, or null if not a clock time. */
function clockMinutes(s: string | null): number | null {
  const m = s ? /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(s.trim()) : null;
  if (!m) return null;
  return ((Number(m[1]) % 12) + (m[3]!.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(m[2]);
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
  const pendingLeave = new Set(cfg.pendingLeaveStatuses.map((s) => s.toLowerCase()));

  const lines: LineResult[] = [];
  const documents: DocumentCheck[] = [];
  const skipped: SkippedDocument[] = [];
  const unmatchedPeople: string[] = [];
  const hoursArithmetic: ReconcileReport["hoursArithmetic"] = [];
  const dayTotals: ReconcileReport["dayTotals"] = [];
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

    for (const e of doc.entries) {
      const s = clockMinutes(e.start);
      const f = clockMinutes(e.finish);
      if (s === null || f === null) continue;
      const computed = (f - s - (e.breaksMin ?? 0)) / 60;
      if (!near(computed, e.hours, tol)) {
        hoursArithmetic.push({ person: doc.personName, date: e.date, payType: e.payType, printed: e.hours, computed });
      }
    }

    const person = findPerson(snapshot.people, doc.personName);
    if (!person) {
      unmatchedPeople.push(doc.personName);
      continue;
    }
    reconciled.add(`${person.id}|${doc.weekEnding}`);
    const docLines = reconcileDocument(doc, person, snapshot, cfg, { included, tafe, approved, pending: pendingLeave });
    lines.push(...docLines);
    for (const date of [...new Set(doc.entries.map((e) => e.date))].sort()) {
      const pdfHours = sum(doc.entries.filter((e) => e.date === date).map((e) => e.hours));
      const appRows = sum(snapshot.timesheets.filter((t) => t.staffId === person.id && t.date === date).map((t) => t.hours));
      // Roster / approved-leave matches carry no hours in the app: count the document's hours for them.
      const implied = sum(docLines.filter((l) => l.date === date && l.verdict === "match" && l.appHours === null).map((l) => l.pdfHours ?? 0));
      const appHours = appRows + implied;
      dayTotals.push({ person: person.name, date, pdfHours, appHours, agree: near(pdfHours, appHours, docLines.some((l) => l.date === date && l.kind === "roster-tafe") ? cfg.tafeHoursTolerance : tol) });
    }
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
    "pending-leave": 0,
    "unknown-pay-type": 0,
    "app-only": 0,
  };
  for (const l of lines) counts[l.verdict]++;
  return { lines, documents, skipped, noFile, unmatchedPeople, hoursArithmetic, dayTotals, counts };
}

function reconcileDocument(
  doc: ExtractedTimesheet,
  person: SnapshotPerson,
  snap: FieldSnapshot,
  cfg: ReconcileConfig,
  sets: { included: Set<string>; tafe: Set<string>; approved: Set<string>; pending: Set<string> },
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
    ambiguous = false,
    extra: { flag?: "light"; info?: string } = {},
  ) =>
    out.push({
      person: person.name,
      date: e.date,
      payType: e.payType,
      kind,
      key,
      pdfHours,
      appHours,
      verdict,
      detail,
      weekEnding: doc.weekEnding,
      docStatus: doc.status,
      ...(ambiguous ? { ambiguous } : {}),
      ...extra,
    });

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
    const approvedCover = (date: string) =>
      snap.leave.find(
        (l) =>
          (l.staffId === person.id || (l.requesterName && normaliseName(l.requesterName) === normaliseName(person.name))) &&
          sets.approved.has(l.status.toLowerCase()) &&
          l.dateStart <= date &&
          l.dateEnd >= date,
      );

    switch (g.res.kind) {
      case "unknown":
        push(ref, "unknown", null, hours, null, "unknown-pay-type", `no payTypeRule matches "${g.payType}"`);
        break;

      case "job": {
        if (!g.key) {
          const rosterTafe = snap.roster.some(
            (x) => x.personId === person.id && x.date === g.date && (tafeLike(x.task) || tafeLike(x.leaveType)),
          );
          const looksTafe =
            g.entries.every((e) => !e.noteText) &&
            g.entries.every((e) =>
              cfg.tafeSignatures.some(
                (sig) => sig.start === e.start && sig.finish === e.finish && (sig.breaksMin === undefined || sig.breaksMin === e.breaksMin),
              ),
            );
          const appHrs = sum(day.map((t) => t.hours));
          const appH = day.length ? appHrs : null;
          const nonTafeJobRows = day.filter((t) => !tafeLike(t.task));
          if (rosterTafe && cfg.noNoteOnTafeDay === "tafe" && nonTafeJobRows.length === 0) {
            const tsTafe = day.filter((t) => tafeLike(t.task));
            tsTafe.forEach((t) => consumed.add(t));
            const app = tsTafe.length ? sum(tsTafe.map((t) => t.hours)) : null;
            const ok = app === null || near(app, hours, cfg.tafeHoursTolerance);
            push(ref, "roster-tafe", "TAFE", hours, app, ok ? "match" : "hours-differ", "looks like a TAFE day: job line with no note on a roster TAFE day", false, { flag: "light" });
          } else if (looksTafe && rosterTafe) {
            push(ref, "roster-tafe", "TAFE", hours, null, "match", "inferred TAFE: no note, TAFE time signature, roster shows TAFE");
          } else if (looksTafe) {
            push(ref, "job", null, hours, appH, "conflict", `TAFE time signature and no note, but the roster does not show TAFE; app has ${dayDesc()}`, true);
          } else if (rosterTafe) {
            push(ref, "job", null, hours, appH, "conflict", `no job code in the note; roster shows TAFE${day.length ? "" : " and the app has no hours"} (possibly TAFE keyed as a job line)`, true);
          } else {
            const agree = day.length > 0 && near(appHrs, hours, tol);
            push(ref, "job", null, hours, appH, "conflict", `no job code in the note, so the job cannot be confirmed; app has ${dayDesc()}${agree ? " (hours agree)" : ""} - confirm with the supervisor`, true);
          }
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
        // Field also records TAFE as a timesheet task ("TAFE"/"tafe") with hours.
        const tsRows = day.filter((t) => tafeLike(t.task));
        if (r) {
          tsRows.forEach((t) => consumed.add(t));
          push(ref, "roster-tafe", "TAFE", hours, tsRows.length ? sum(tsRows.map((t) => t.hours)) : null, "match", "roster shows TAFE");
          break;
        }
        if (tsRows.length) {
          tsRows.forEach((t) => consumed.add(t));
          const app = sum(tsRows.map((t) => t.hours));
          push(ref, "roster-tafe", "TAFE", hours, app, near(app, hours, cfg.tafeHoursTolerance) ? "match" : "hours-differ", "TAFE recorded as a timesheet task");
          break;
        }
        const cover = approvedCover(g.date);
        if (cover) {
          push(ref, "roster-tafe", "TAFE", hours, null, "conflict", `approved ${cover.leaveType} leave request ${cover.dateStart}..${cover.dateEnd} covers this day; Field's approved request wins, confirm with the approver`, true);
          break;
        }
        push(ref, "roster-tafe", "TAFE", hours, null, day.length ? "conflict" : "missing-in-app", `roster has no TAFE; app has ${dayDesc()}`);
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
          // The same leave is often also keyed as a timesheet task (e.g. "RDO"): account for it.
          const lrTs = day.filter((t) => t.task.toLowerCase().includes(lt));
          lrTs.forEach((t) => consumed.add(t));
          push(ref, "leave", g.key, hours, lrTs.length ? sum(lrTs.map((t) => t.hours)) : null, "match", `approved leave request ${lr.dateStart}..${lr.dateEnd}`);
          break;
        }
        const pend = snap.leave.find(
          (l) =>
            (l.staffId === person.id || (l.requesterName && normaliseName(l.requesterName) === normaliseName(person.name))) &&
            sets.pending.has(l.status.toLowerCase()) &&
            l.leaveType.toLowerCase() === lt &&
            l.dateStart <= g.date &&
            l.dateEnd >= g.date,
        );
        if (pend) {
          push(ref, "leave", g.key, hours, null, "pending-leave", `leave request ${pend.dateStart}..${pend.dateEnd} is still ${pend.status}; needs an approver`, true);
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
          const cover = approvedCover(g.date);
          const rosterLeave = snap.roster.find((x) => x.personId === person.id && x.date === g.date && x.leaveType);
          const clash = day.length || rosterLeave || cover;
          if (cover && cfg.approvedRequestWins) {
            push(ref, "leave", g.key, hours, null, "conflict", `approved ${cover.leaveType} leave request ${cover.dateStart}..${cover.dateEnd} covers this day, not ${g.key}; Field's approved request wins, confirm with the approver`, true);
          } else if (clash && cfg.leaveTypeClash === "pdf-wins") {
            // The PDF is the claim and nothing approved contradicts it: it wins quietly, the report just notes it.
            const leaveRows = day.filter((t) => !/^\d+$/.test(t.task));
            leaveRows.forEach((t) => consumed.add(t));
            const app = leaveRows.length ? sum(leaveRows.map((t) => t.hours)) : null;
            const ok = app === null || near(app, hours, tol);
            push(ref, "leave", g.key, hours, app, ok ? "match" : "hours-differ", `PDF leave type ${g.key} used`, false, {
              info: `PDF says ${g.key}; Field shows ${leaveRows.length ? leaveRows.map((t) => t.task).join(", ") : `roster ${rosterLeave?.leaveType}`} ${cover ? `and an approved ${cover.leaveType} request` : "and no leave request"} - PDF wins`,
            });
          } else {
            push(ref, "leave", g.key, hours, null, clash ? "conflict" : "missing-in-app", cover ? `approved ${cover.leaveType} leave request ${cover.dateStart}..${cover.dateEnd} covers this day, not ${g.key}` : `no approved ${g.key} leave request; app has ${dayDesc()}`, !!cover);
          }
        }
        break;
      }

      case "code": {
        const rows = day.filter((t) => t.task.toLowerCase() === g.key!.toLowerCase());
        rows.forEach((r) => consumed.add(r));
        const aliases = (cfg.rosterMatchesCode[g.key!] ?? []).map((a) => a.toLowerCase());
        const viaRoster = snap.roster.find((x) => x.personId === person.id && x.date === g.date && x.task && aliases.includes(x.task.toLowerCase()));
        if (rows.length === 0 && viaRoster) {
          push(ref, "code", g.key, hours, null, "match", `matched via roster "${viaRoster.task}", no timesheet row`);
        } else if (rows.length === 0) {
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
      weekEnding: doc.weekEnding,
      docStatus: doc.status,
    });
  }
  return out;
}
