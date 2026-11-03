/**
 * Timesheet reconcile — synthetic data only (no real people or hours).
 */
import { describe, it, expect } from "vitest";
import { extractTimesheets, reconcile, normaliseName, DEFAULT_CONFIG } from "../src/skills/timesheet-reconcile/index.js";
import type { ExtractedTimesheet, FieldSnapshot } from "../src/skills/timesheet-reconcile/index.js";

type Cell = [text: string, x: number, y: number];

/** Minimal multi-page PDF where every text item sits at an explicit x/y. */
function makePdf(pages: Cell[][]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/•/g, "\\267");
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((cells, i) => {
    const contentId = 4 + i * 2;
    const content = "BT\n/F1 8 Tf\n" + cells.map(([t, x, y]) => `1 0 0 1 ${x} ${y} Tm\n(${esc(t)}) Tj\n`).join("") + "ET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const off: number[] = [];
  objects.forEach((o, i) => {
    off.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xs = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of off) pdf += String(o).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

// Page 1: header + table (columns taken from the header row). Page 2: notes.
function samplePages(weekEnding: string, firstDay: string): Cell[][] {
  const [d1, d2, d3] = firstDay.split("|") as [string, string, string];
  const p1: Cell[] = [
    ["Pat Example", 520, 800],
    [weekEnding, 537, 790],
    ["Example Co [Award]", 394, 780],
    ["Timesheet", 23, 740],
    ["Pending Approval", 497, 740],
    ["Date", 23, 700],
    ["Start", 200, 700],
    ["Finish", 290, 700],
    ["Breaks", 360, 700],
    ["Allowances", 420, 700],
    ["Notes", 490, 700],
    ["Total", 540, 700],
    [d1, 23, 680],
    ["8.00 hr", 544, 680],
    ["Base Hourly", 26, 660],
    ["6:00am", 204, 660],
    ["2:30pm", 294, 660],
    ["30 min", 364, 660],
    ["Note 1", 494, 660],
    ["8 hr", 544, 660],
    [d2, 23, 640],
    ["10.00 hr", 540, 640],
    ["8.0000 Site", 424, 635], // allowance on its own line
    ["Base Hourly", 26, 620],
    ["6:00am", 204, 620],
    ["4:30pm", 294, 620],
    ["Note 2", 494, 620],
    ["10 hr", 544, 620],
    ["Base Hourly", 26, 605], // zero-hour placeholder: dropped
    ["0 hr", 544, 605],
    [d3, 23, 585],
    ["4.00 hr", 544, 585],
    ["Mystery Pay Type", 26, 565],
    ["7:00am", 204, 565],
    ["11:00am", 294, 565],
    ["4 hr", 544, 565],
    ["22.00 hr", 544, 540], // printed week total
    ["Notes", 23, 500],
    [d1, 23, 480],
    ["• Note 1", 23, 470],
    ["• 6:00am to 2:30pm", 23, 460],
    ["10001 Alpha", 23, 450],
    [d2, 23, 430],
    ["• Note 2", 23, 420],
    ["Fit-out - 10002", 23, 410],
  ];
  const p2: Cell[] = [
    ["Detailed Summary", 23, 800],
    ["Timesheet History", 23, 700],
  ];
  return [p1, p2];
}

describe("timesheet extract", () => {
  it("reads header, entries, allowances, notes and printed total from positions", async () => {
    const docs = await extractTimesheets(makePdf(samplePages("1 Nov 2026", "Mon 26 Oct|Tue 27 Oct|Wed 28 Oct")));
    expect(docs).toHaveLength(1);
    const d = docs[0]!;
    expect(d.personName).toBe("Pat Example");
    expect(d.weekEnding).toBe("2026-11-01");
    expect(d.status).toBe("Pending Approval");
    expect(d.printedTotal).toBe(22);
    expect(d.pages).toEqual([1, 2]);
    expect(d.entries.map((e) => [e.date, e.payType, e.hours])).toEqual([
      ["2026-10-26", "Base Hourly", 8],
      ["2026-10-27", "Base Hourly", 10],
      ["2026-10-28", "Mystery Pay Type", 4],
    ]);
    expect(d.entries[0]).toMatchObject({ start: "6:00am", finish: "2:30pm", breaksMin: 30, noteRef: "Note 1", noteText: "10001 Alpha" });
    expect(d.entries[1]!.allowances).toEqual([{ qty: 8, name: "Site" }]);
    expect(d.entries[1]!.noteText).toBe("Fit-out - 10002");
    expect(d.entries.reduce((a, e) => a + e.hours, 0)).toBe(d.printedTotal);
  });

  it("resolves day dates across a month rollover", async () => {
    const docs = await extractTimesheets(makePdf(samplePages("4 Oct 2026", "Mon 28 Sep|Tue 29 Sep|Wed 30 Sep")));
    expect(docs[0]!.entries.map((e) => e.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
  });

  it("splits a combined PDF at pages that start with a week-ending date", async () => {
    const a = samplePages("1 Nov 2026", "Mon 26 Oct|Tue 27 Oct|Wed 28 Oct");
    const b = samplePages("8 Nov 2026", "Mon 2 Nov|Tue 3 Nov|Wed 4 Nov");
    const docs = await extractTimesheets(makePdf([...a, ...b]));
    expect(docs.map((d) => [d.weekEnding, d.pages])).toEqual([
      ["2026-11-01", [1, 2]],
      ["2026-11-08", [3, 4]],
    ]);
  });
});

// ---- reconcile ------------------------------------------------------------

const P1 = { id: "p1", name: "Pat Example" };
const P2 = { id: "p2", name: "Sam Sample" };

function doc(over: Partial<ExtractedTimesheet>, entries: ExtractedTimesheet["entries"]): ExtractedTimesheet {
  return {
    personName: "Pat Example",
    weekEnding: "2026-11-01",
    award: "",
    status: "Pending Approval",
    entries,
    printedTotal: entries.reduce((a, e) => a + e.hours, 0),
    pages: [1],
    warnings: [],
    ...over,
  };
}
function entry(date: string, payType: string, hours: number, noteText: string | null = null) {
  return { date, payType, start: null, finish: null, breaksMin: null, hours, noteRef: null, noteText, allowances: [] };
}
const emptySnap = (): FieldSnapshot => ({ people: [P1, P2], timesheets: [], roster: [], leave: [] });

describe("timesheet reconcile", () => {
  it("matches jobs, splits a day across jobs, and flags hours-differ and missing", () => {
    const snap = emptySnap();
    snap.timesheets = [
      { staffId: "p1", date: "2026-10-26", hours: 8, task: "10001" },
      { staffId: "p1", date: "2026-10-27", hours: 4, task: "10001" },
      { staffId: "p1", date: "2026-10-27", hours: 4, task: "10002" },
      { staffId: "p1", date: "2026-10-28", hours: 7, task: "10001" },
    ];
    const r = reconcile(
      [
        doc({}, [
          entry("2026-10-26", "Base Hourly", 8, "10001 Alpha"),
          entry("2026-10-27", "Base Hourly", 4, "10001"),
          entry("2026-10-27", "Base Hourly", 4, "Fit-out - 10002"),
          entry("2026-10-28", "Base Hourly", 8, "10001"),
          entry("2026-10-29", "Base Hourly", 8, "10001"),
        ]),
      ],
      snap,
    );
    expect(r.lines.map((l) => l.verdict)).toEqual(["match", "match", "match", "hours-differ", "missing-in-app"]);
    expect(r.documents[0]!.totalsAgree).toBe(true);
  });

  it("matches TAFE against the roster, and leave against approved requests first", () => {
    const snap = emptySnap();
    snap.roster = [{ personId: "p1", date: "2026-10-27", task: "TAFE", leaveType: "tafe" }];
    snap.leave = [
      { staffId: "p1", requesterName: "Pat Example", leaveType: "annual", dateStart: "2026-10-28", dateEnd: "2026-10-29", hoursRequested: 16, status: "approved" },
      { staffId: "p1", requesterName: "Pat Example", leaveType: "annual", dateStart: "2026-10-30", dateEnd: "2026-10-30", hoursRequested: 8, status: "pending" },
    ];
    const r = reconcile(
      [
        doc({}, [
          entry("2026-10-27", "College/TAFE/Block Release", 8),
          entry("2026-10-28", "Annual Leave", 8),
          entry("2026-10-30", "Annual Leave", 8),
        ]),
      ],
      snap,
    );
    expect(r.lines.map((l) => [l.date, l.verdict])).toEqual([
      ["2026-10-27", "match"],
      ["2026-10-28", "match"],
      ["2026-10-30", "pending-leave"], // on file but not approved: raised, not matched
    ]);
  });

  it("flags a conflict when the PDF says leave but the app holds a different code", () => {
    const snap = emptySnap();
    snap.timesheets = [{ staffId: "p1", date: "2026-10-30", hours: 8, task: "RDO" }];
    snap.roster = [{ personId: "p1", date: "2026-10-30", task: "RDO", leaveType: "rdo" }];
    const r = reconcile([doc({}, [entry("2026-10-30", "Annual Leave", 8)])], snap);
    expect(r.lines[0]!.verdict).toBe("conflict");
    expect(r.lines[0]!.detail).toContain("RDO");
  });

  it("infers TAFE from the time signature when the roster agrees, and flags it when it does not", () => {
    const tafeLine = { ...entry("2026-10-27", "Base Hourly", 8), start: "7:30am", finish: "4:00pm", breaksMin: 30 };
    const withRoster = emptySnap();
    withRoster.roster = [{ personId: "p1", date: "2026-10-27", task: "TAFE", leaveType: "tafe" }];
    const a = reconcile([doc({}, [tafeLine])], withRoster);
    expect(a.lines[0]).toMatchObject({ verdict: "match", kind: "roster-tafe" });
    const b = reconcile([doc({}, [tafeLine])], emptySnap());
    expect(b.lines[0]).toMatchObject({ verdict: "conflict", ambiguous: true });
    // Same times with a job note is a job, not TAFE.
    const c = reconcile([doc({}, [{ ...tafeLine, noteText: "10001" }])], emptySnap());
    expect(c.lines[0]!.verdict).toBe("missing-in-app");
  });

  it("flags a line with no job code for confirmation instead of guessing", () => {
    const snap = emptySnap();
    snap.timesheets = [{ staffId: "p1", date: "2026-10-31", hours: 6, task: "10001" }];
    const r = reconcile([doc({}, [entry("2026-10-31", "Base Hourly", 6)])], snap);
    expect(r.lines[0]).toMatchObject({ verdict: "conflict", ambiguous: true });
    expect(r.lines[0]!.detail).toContain("confirm with the supervisor");
  });

  it("handles split days: same job twice, three-way, and a part that does not match", () => {
    const snap = emptySnap();
    snap.timesheets = [
      { staffId: "p1", date: "2026-10-26", hours: 8, task: "10001" },
      { staffId: "p1", date: "2026-10-27", hours: 3, task: "10001" },
      { staffId: "p1", date: "2026-10-27", hours: 3, task: "10002" },
      { staffId: "p1", date: "2026-10-27", hours: 2, task: "10003" },
      { staffId: "p1", date: "2026-10-28", hours: 4, task: "10001" },
      { staffId: "p1", date: "2026-10-28", hours: 4, task: "10009" },
    ];
    const r = reconcile(
      [
        doc({}, [
          entry("2026-10-26", "Base Hourly", 4, "10001"), // 4 + 4 on one job vs 8 in app
          entry("2026-10-26", "Base Hourly", 4, "10001"),
          entry("2026-10-27", "Base Hourly", 3, "10001"),
          entry("2026-10-27", "Base Hourly", 3, "10002"),
          entry("2026-10-27", "Base Hourly", 2, "10003"),
          entry("2026-10-28", "Base Hourly", 4, "10001"),
          entry("2026-10-28", "Base Hourly", 4, "10002"), // app has 10009 instead
        ]),
      ],
      snap,
    );
    expect(r.lines.map((l) => [l.date, l.key, l.verdict])).toEqual([
      ["2026-10-26", "10001", "match"],
      ["2026-10-27", "10001", "match"],
      ["2026-10-27", "10002", "match"],
      ["2026-10-27", "10003", "match"],
      ["2026-10-28", "10001", "match"],
      ["2026-10-28", "10002", "conflict"], // detail names the 10009 the app holds instead
    ]);
  });

  it("never drops an unknown pay type", () => {
    const r = reconcile([doc({}, [entry("2026-10-26", "Mystery Pay Type", 4)])], emptySnap());
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.verdict).toBe("unknown-pay-type");
    expect(r.counts["unknown-pay-type"]).toBe(1);
  });

  it("is driven by config: a new rule gives the unknown pay type a meaning", () => {
    const snap = emptySnap();
    snap.timesheets = [{ staffId: "p1", date: "2026-10-26", hours: 4, task: "MYST" }];
    const r = reconcile([doc({}, [entry("2026-10-26", "Mystery Pay Type", 4)])], snap, {
      payTypeRules: [...DEFAULT_CONFIG.payTypeRules, { match: "mystery", kind: "code", value: "MYST" }],
    });
    expect(r.lines[0]!.verdict).toBe("match");
  });

  it("lists skipped documents, no-file people and a printed-total mismatch", () => {
    const snap = emptySnap();
    snap.timesheets = [{ staffId: "p2", date: "2026-10-27", hours: 8, task: "10001" }];
    const r = reconcile(
      [
        doc({ printedTotal: 9 }, [entry("2026-10-26", "Base Hourly", 8, "10001")]),
        doc({ personName: "Sam Sample", status: "Not Opened" }, []),
      ],
      snap,
    );
    expect(r.documents[0]!.totalsAgree).toBe(false);
    expect(r.skipped).toEqual([expect.objectContaining({ person: "Sam Sample", weekEnding: "2026-11-01" })]);
    expect(r.noFile).toEqual([{ person: "Sam Sample", weekEnding: "2026-11-01", appHours: 8 }]);
  });

  it("reports app hours the document does not account for", () => {
    const snap = emptySnap();
    snap.timesheets = [
      { staffId: "p1", date: "2026-10-26", hours: 8, task: "10001" },
      { staffId: "p1", date: "2026-10-29", hours: 8, task: "10001" },
    ];
    const r = reconcile([doc({}, [entry("2026-10-26", "Base Hourly", 8, "10001")])], snap);
    expect(r.lines.map((l) => l.verdict)).toEqual(["match", "app-only"]);
  });

  it("normalises names, including 'Surname, First'", () => {
    expect(normaliseName("  EXAMPLE,  pat ")).toBe("pat example");
    const r = reconcile([doc({ personName: "Example, Pat" }, [entry("2026-10-26", "Base Hourly", 8, "10001")])], emptySnap());
    expect(r.unmatchedPeople).toEqual([]);
    expect(r.lines[0]!.person).toBe("Pat Example");
  });
});
