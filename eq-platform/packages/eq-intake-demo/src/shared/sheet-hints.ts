/**
 * Two small, pure helpers that make a hand-kept staff or contacts workbook
 * behave the way the person who made it expects, before classification and
 * duplicate checks run:
 *
 *   - isLikelyIgnoredSheet: a tab called "old - ignore" / "Archive" / "backup"
 *     should not be offered as something to import.
 *   - splitFullNameColumn: a single "Full Name" column becomes "First name" +
 *     "Last name" so the required-field question and the within-file
 *     duplicate check (which keys on first + last name) both work.
 *
 * Neither touches the database or the original column. Both are additive.
 */

import type { ParsedSheet } from "@eq/intake";
import type { RoleName } from "../rollup/roles.js";

const IGNORE_WORDS =
  /(^|[^a-z])(old|ignore|ignored|archive|archived|backup|bak|unused|obsolete|former|do not use|don'?t use)([^a-z]|$)/i;

/** True when a tab name says "not this one" in plain words. */
export function isLikelyIgnoredSheet(sheetName: string | undefined | null): boolean {
  if (!sheetName) return false;
  return IGNORE_WORDS.test(sheetName);
}

const FULL_NAME_HEADERS = new Set([
  "full name",
  "fullname",
  "full_name",
  "name",
  "staff name",
  "employee name",
  "employee",
  "person",
  "worker",
  "worker name",
]);

const FIRST_HEADERS = new Set(["first name", "firstname", "first_name", "first", "given name", "fname"]);
const LAST_HEADERS = new Set(["last name", "lastname", "last_name", "last", "surname", "family name", "lname"]);

const LAST_NAME_PARTICLES = new Set(["van", "von", "der", "den", "de", "da", "di", "du", "le", "la", "del", "bin", "al"]);

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "Okoro, Sam" -> Sam / Okoro. "Jan van der Berg" -> Jan / van der Berg. One word -> first only. */
export function splitPersonName(raw: string): { first: string; last: string } {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return { first: "", last: "" };
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    return { first: rest.join(",").trim(), last: (last ?? "").trim() };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  let lastStart = parts.length - 1;
  while (lastStart > 1 && LAST_NAME_PARTICLES.has(parts[lastStart - 1]!.toLowerCase())) lastStart--;
  return { first: parts.slice(0, lastStart).join(" "), last: parts.slice(lastStart).join(" ") };
}

/**
 * For a staff or contact sheet with ONE name column and no first/last
 * columns, return a copy with "First name" and "Last name" columns added.
 * Returns the same sheet object when there is nothing to do, so callers can
 * compare by reference.
 */
export function splitFullNameColumn(sheet: ParsedSheet, role: RoleName | "unknown"): ParsedSheet {
  if (role !== "staff" && role !== "contact") return sheet;
  const headers = sheet.headerRow;
  const normed = headers.map(norm);
  if (normed.some((h) => FIRST_HEADERS.has(h)) || normed.some((h) => LAST_HEADERS.has(h))) return sheet;
  const idx = normed.findIndex((h) => FULL_NAME_HEADERS.has(h));
  if (idx < 0) return sheet;

  const source = headers[idx]!;
  const rows = (sheet.rows as Record<string, unknown>[]).map((row) => {
    const { first, last } = splitPersonName(String(row[source] ?? ""));
    return { ...row, "First name": first || null, "Last name": last || null };
  });
  return { ...sheet, headerRow: [...headers, "First name", "Last name"], rows };
}
