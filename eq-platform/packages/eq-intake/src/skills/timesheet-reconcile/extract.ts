/**
 * Timesheet extractor — payroll-portal PDF → ExtractedTimesheet[].
 *
 * Positional: every page's text items are clustered into lines by y, then
 * columns are taken from the table's own header row (their x differs per
 * layout). Plain-text extraction scrambles the columns, so it is not used.
 */
import { getDocumentProxy } from "unpdf";
import type { Allowance, ExtractedEntry, ExtractedTimesheet } from "./types.js";

interface Item {
  s: string;
  x: number;
  y: number;
}
interface Line {
  y: number;
  items: Item[];
  page: number;
}

const DATE_RE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/;
const DAY_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}) ([A-Z][a-z]{2})$/;
const HR_RE = /^(\d+(?:\.\d+)?) hr$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LABEL_X_MAX = 40;
const BULLET = "•";

const text = (l: Line) => l.items.map((i) => i.s).join(" ").trim();

function clusterLines(items: Item[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(cur.y - it.y) <= 2) cur.items.push(it);
    else lines.push({ y: it.y, items: [it], page });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

async function readLines(bytes: Uint8Array): Promise<Line[][]> {
  // pdfjs transfers the underlying buffer — hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: Line[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const items: Item[] = [];
    for (const raw of tc.items as Array<{ str?: string; transform?: number[] }>) {
      // Icon-font glyphs (private-use area) and zero-width/nbsp characters are not text.
      const str = (raw.str ?? "").replace(/[-​-‍﻿ ]/g, " ").trim();
      if (!str || !raw.transform) continue;
      items.push({ s: str, x: raw.transform[4]!, y: raw.transform[5]! });
    }
    pages.push(clusterLines(items, p));
  }
  return pages;
}

function parseWeekEnding(s: string): string | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2]!);
  if (mi < 0) return null;
  return new Date(Date.UTC(Number(m[3]), mi, Number(m[1]))).toISOString().slice(0, 10);
}

/** Resolve "Mon 26 Oct" to an ISO date within the 7 days ending at weekEnding. */
function resolveDay(weekEnding: string, wd: string, dom: number, mon: string): string | null {
  const end = Date.parse(weekEnding + "T00:00:00Z");
  for (let back = 0; back < 7; back++) {
    const d = new Date(end - back * 86400000);
    if (d.getUTCDate() === dom && MONTHS[d.getUTCMonth()] === mon && WEEKDAYS[d.getUTCDay()] === wd) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

/** Column a given x belongs to: the header with the greatest x not right of it. */
function columnFor(cols: { name: string; x: number }[], x: number): string | null {
  let best: { name: string; x: number } | null = null;
  for (const c of cols) if (c.x <= x + 8 && (!best || c.x > best.x)) best = c;
  return best ? best.name : null;
}

function parseAllowance(s: string): Allowance | null {
  const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(s.trim());
  return m ? { qty: Number(m[1]), name: m[2]! } : null;
}

function parseBreaks(s: string): number | null {
  const m = /^(\d+)\s*min/i.exec(s);
  return m ? Number(m[1]) : null;
}

interface RawDoc {
  lines: Line[];
  pages: number[];
}

function splitDocuments(pages: Line[][]): RawDoc[] {
  const docs: RawDoc[] = [];
  pages.forEach((lines, idx) => {
    const top = lines.slice(0, 5);
    const starts = top.some((l) => l.items.length === 1 && DATE_RE.test(l.items[0]!.s));
    if (starts || docs.length === 0) docs.push({ lines: [], pages: [] });
    const d = docs[docs.length - 1]!;
    d.lines.push(...lines);
    d.pages.push(idx + 1);
  });
  return docs;
}

function parseDocument(doc: RawDoc): ExtractedTimesheet {
  const warnings: string[] = [];
  const { lines } = doc;

  const dateIdx = lines.findIndex((l) => l.items.length === 1 && DATE_RE.test(l.items[0]!.s));
  const weekEnding = dateIdx >= 0 ? parseWeekEnding(lines[dateIdx]!.items[0]!.s) : null;
  if (!weekEnding) warnings.push("no week-ending date found");
  const personName = dateIdx > 0 ? text(lines[dateIdx - 1]!) : "";
  const award = dateIdx >= 0 && lines[dateIdx + 1] ? text(lines[dateIdx + 1]!) : "";

  const tsLine = lines.find((l) => l.items[0]?.s === "Timesheet" && l.items[0].x < LABEL_X_MAX);
  const status = tsLine ? tsLine.items.slice(1).map((i) => i.s).join(" ").trim() : "";

  const pendingAllowances: { y: number; page: number; a: Allowance }[] = [];
  const rows: { e: ExtractedEntry; y: number; page: number }[] = [];
  let cols: { name: string; x: number }[] = [];
  let startX = 0;
  let curDate: string | null = null;
  let printedTotal: number | null = null;
  let inTable = false;
  let notesStart = -1;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const first = line.items[0]!;
    if (first.x < LABEL_X_MAX && first.s === "Date") {
      cols = line.items.map((i) => ({ name: i.s, x: i.x }));
      startX = cols.find((c) => c.name === "Start")?.x ?? 999;
      inTable = true;
      continue;
    }
    if (first.x < LABEL_X_MAX && line.items.length === 1) {
      if (first.s === "Notes") notesStart = li;
      if (first.s === "Notes" || first.s === "Detailed Summary" || first.s === "Timesheet History") break;
    }
    if (!inTable) continue;

    const dayM = first.x < LABEL_X_MAX ? DAY_RE.exec(first.s) : null;
    if (dayM) {
      curDate = weekEnding ? resolveDay(weekEnding, dayM[1]!, Number(dayM[2]), dayM[3]!) : null;
      if (!curDate) warnings.push(`could not resolve day "${first.s}"`);
      continue;
    }
    // Lone "NN.NN hr" line = printed week total.
    if (line.items.length === 1 && HR_RE.test(first.s)) {
      printedTotal = Number(HR_RE.exec(first.s)![1]);
      continue;
    }
    const labelItems = line.items.filter((i) => i.x < startX - 4);
    if (labelItems.length === 0) {
      // Allowance-only line (own y offset): attach to the nearest entry later.
      for (const it of line.items) {
        if (columnFor(cols, it.x) === "Allowances") {
          const a = parseAllowance(it.s);
          if (a) pendingAllowances.push({ y: line.y, page: line.page, a });
        }
      }
      continue;
    }
    if (!curDate) {
      warnings.push(`entry before any day row: "${text(line)}"`);
      continue;
    }
    const payType = labelItems.map((i) => i.s).join(" ");
    const e: ExtractedEntry = {
      date: curDate,
      payType,
      start: null,
      finish: null,
      breaksMin: null,
      hours: 0,
      noteRef: null,
      noteText: null,
      allowances: [],
    };
    let hoursSeen = false;
    for (const it of line.items) {
      if (it.x < startX - 4) continue;
      const col = columnFor(cols, it.x);
      if (col === "Start") e.start = it.s;
      else if (col === "Finish") e.finish = it.s;
      else if (col === "Breaks") e.breaksMin = parseBreaks(it.s);
      else if (col === "Notes") e.noteRef = it.s;
      else if (col === "Allowances") {
        const a = parseAllowance(it.s);
        if (a) e.allowances.push(a);
      } else if (col === "Total") {
        const h = HR_RE.exec(it.s);
        if (h) {
          e.hours = Number(h[1]);
          hoursSeen = true;
        }
      }
    }
    if (!hoursSeen) warnings.push(`no hours on ${curDate} ${payType}`);
    rows.push({ e, y: line.y, page: line.page });
  }

  for (const p of pendingAllowances) {
    let best: { e: ExtractedEntry; d: number } | null = null;
    for (const c of rows) {
      if (c.page !== p.page) continue;
      const d = Math.abs(c.y - p.y);
      if (!best || d < best.d) best = { e: c.e, d };
    }
    if (best) best.e.allowances.push(p.a);
    else warnings.push(`orphan allowance "${p.a.qty} ${p.a.name}"`);
  }

  // Notes section: day heading, "• Note n", bullets, then the job-text line.
  const noteText = new Map<string, string>();
  if (notesStart >= 0) {
    let ref: string | null = null;
    for (let li = notesStart + 1; li < lines.length; li++) {
      const t = text(lines[li]!);
      if (t === "Detailed Summary" || t === "Timesheet History") break;
      if (DAY_RE.test(t)) {
        ref = null;
        continue;
      }
      const nm = new RegExp(`^${BULLET}\\s*(Note \\d+)$`).exec(t);
      if (nm) {
        ref = nm[1]!;
        continue;
      }
      if (t.startsWith(BULLET) || !ref) continue;
      noteText.set(ref, noteText.has(ref) ? `${noteText.get(ref)} ${t}` : t);
    }
  }

  const entries: ExtractedEntry[] = [];
  for (const c of rows) {
    if (c.e.hours === 0) continue; // zero-hour placeholder
    if (c.e.noteRef) c.e.noteText = noteText.get(c.e.noteRef) ?? null;
    entries.push(c.e);
  }

  return {
    personName,
    weekEnding: weekEnding ?? "",
    award,
    status,
    entries,
    printedTotal,
    pages: doc.pages,
    warnings,
  };
}

export async function extractTimesheets(bytes: Uint8Array): Promise<ExtractedTimesheet[]> {
  const pages = await readLines(bytes);
  return splitDocuments(pages).map(parseDocument);
}
