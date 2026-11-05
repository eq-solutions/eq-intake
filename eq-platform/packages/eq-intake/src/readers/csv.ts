/**
 * CSV reader.
 *
 * Turns a CSV file (Buffer, Uint8Array, or string) into:
 *   { headerRow, rows, meta }
 *
 * rows are Record<string, unknown>[] — keyed by header column name, values as
 * raw strings. The downstream @eq/validation coercers handle typing.
 *
 * Behaviour:
 *   - Accepts Buffer / Uint8Array / string. Buffer/Uint8Array decoded as UTF-8.
 *   - Strips UTF-8 BOM (0xEF 0xBB 0xBF) if present.
 *   - Auto-detects delimiter via Papa Parse (comma / semicolon / tab / pipe).
 *     Override with opts.delimiter if known.
 *   - Trims whitespace from header names.
 *   - Skips fully-empty rows.
 *   - dynamicTyping is OFF — every cell comes back as a string so coercers
 *     get unambiguous input.
 *
 *   - Encoding: with no opts.encoding, tries strict UTF-8 and falls back to
 *     Windows-1252 (a superset of Latin-1 for printable text) when the bytes
 *     are not valid UTF-8. UTF-16 BOMs are honoured. The choice is reported in
 *     meta.encoding / meta.encodingFallback.
 *   - Header-row detection: title rows / blank rows above the table are
 *     skipped (meta.headerRowIndex) and returned verbatim in meta.preamble,
 *     so nothing above the header disappears silently. Override with
 *     opts.headerRowIndex (0-based record index, blank lines counted).
 *   - Bounded work: input beyond opts.maxBytes / opts.maxLines is REJECTED
 *     with a CsvLimitError (never truncated). The reader no longer keeps a
 *     second whole-file line array. It still parses in memory, so the caps
 *     are the bound, not streaming.
 */

import Papa from "papaparse";

export type CsvRow = Record<string, unknown>;

export interface ParsedSheet {
  /** Logical sheet name. CSV files always have one sheet; default 'csv'. */
  sheetName: string;
  /** Column headers in source order, with whitespace trimmed. */
  headerRow: string[];
  /** Data rows keyed by header column name. */
  rows: CsvRow[];
  /** Parse diagnostics — useful for the confirm UI and audit trail. */
  meta: ParseMeta;
}

export interface MalformedRow {
  /** 1-based source line number (data lines after the header are 2, 3, ...). */
  lineNumber: number;
  /** Raw source line text, untouched. */
  raw: string;
  /** Short machine-readable code, e.g. "extra_fields", "missing_fields", "quote_mismatch". */
  reason: string;
  /** Human-readable detail Papa Parse produced. */
  message: string;
}

export interface ParseMeta {
  /** Encoding used to decode the input. */
  encoding: string;
  /** Delimiter Papa Parse detected (or the override the caller passed). */
  delimiter: string;
  /** Number of data rows returned in `rows`. */
  totalRows: number;
  /** Rows in the source that were skipped because they were fully empty. */
  emptyRowsSkipped: number;
  /** Number of malformed rows excluded from `rows` (same as `malformed.length`). */
  malformedRows: number;
  /** Per-row diagnostics for malformed lines that didn't make it into `rows`.
   *  Surfaced so the confirm UI can show "these rows didn't parse" with line
   *  numbers and reasons — drops are visible, not silent. */
  malformed: MalformedRow[];
  /** True if a UTF-8 BOM was detected and stripped from the input. */
  bomDetected: boolean;
  /** True when no encoding was requested and the bytes were not valid UTF-8,
   *  so the reader decoded them as Windows-1252. */
  encodingFallback?: boolean;
  /** 0-based record index of the header row in the source (CSV only; 0 when
   *  the header is the first record). */
  headerRowIndex?: number;
  /** Non-blank lines found above the header row (title rows etc.), verbatim.
   *  Surfaced so rows above the table are visible, never dropped silently. */
  preamble?: PreambleRow[];
}

export interface PreambleRow {
  /** 1-based source line number. */
  lineNumber: number;
  /** Raw source line text, untouched. */
  raw: string;
}

/** Thrown when input exceeds the configured size caps. A visible rejection. */
export class CsvLimitError extends Error {
  readonly code = "csv_limit_exceeded";
  constructor(
    public readonly limit: "maxBytes" | "maxLines",
    public readonly actual: number,
    public readonly max: number,
  ) {
    super(`CSV rejected: ${limit} exceeded (${actual} > ${max}). Split the file or raise the limit.`);
    this.name = "CsvLimitError";
  }
}

export const DEFAULT_CSV_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CSV_MAX_LINES = 1_000_000;

export interface ParseCsvOptions {
  /** Text encoding for Buffer/Uint8Array input. Default: detect (UTF-8, else
   *  Windows-1252). When set, it is used as-is with no fallback. */
  encoding?: string;
  /** 0-based record index of the header row. Default: auto-detect. */
  headerRowIndex?: number;
  /** Reject input larger than this many bytes. Default 100 MiB. */
  maxBytes?: number;
  /** Reject input with more than this many lines. Default 1,000,000. */
  maxLines?: number;
  /** Force a specific delimiter. Default: auto-detect via Papa Parse. */
  delimiter?: string;
  /** Skip rows where every cell is empty. Default true. */
  skipEmptyLines?: boolean;
  /** Logical name to record in the result. Default 'csv'. */
  sheetName?: string;
}

const UTF8_BOM = "﻿";
const HEADER_SCAN_LIMIT = 50;

interface Decoded {
  text: string;
  encoding: string;
  bomDetected: boolean;
  encodingFallback: boolean;
}

// Code points for bytes 0x80-0x9F in Windows-1252. Decoded by hand because
// some runtimes (Node built without full ICU) map "windows-1252" to Latin-1,
// turning smart quotes and dashes into C1 control characters.
const CP1252_HIGH =
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ" +
  "‘’“”•–—˜™š›œžŸ";

function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    const codes = new Array<number>(end - i);
    for (let j = i; j < end; j++) {
      const b = bytes[j] as number;
      codes[j - i] = b >= 0x80 && b <= 0x9f ? (CP1252_HIGH.charCodeAt(b - 0x80)) : b;
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

function decodeBytes(bytes: Uint8Array, requested: string | undefined): Decoded {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const enc = requested ?? "utf-8";
    return {
      text: new TextDecoder(enc).decode(bytes.subarray(3)),
      encoding: enc,
      bomDetected: true,
      encodingFallback: false,
    };
  }
  if (!requested && bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return {
        text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
        encoding: "utf-16le",
        bomDetected: true,
        encodingFallback: false,
      };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return {
        text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
        encoding: "utf-16be",
        bomDetected: true,
        encodingFallback: false,
      };
    }
  }
  if (requested) {
    return {
      text: new TextDecoder(requested).decode(bytes),
      encoding: requested,
      bomDetected: false,
      encodingFallback: false,
    };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
      bomDetected: false,
      encodingFallback: false,
    };
  } catch {
    return {
      text: decodeWindows1252(bytes),
      encoding: "windows-1252",
      bomDetected: false,
      encodingFallback: true,
    };
  }
}

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Character offset of the start of the n-th (0-based) line. */
function lineStartOffset(text: string, n: number): number {
  let off = 0;
  for (let k = 0; k < n; k++) {
    const nl = text.indexOf("\n", off);
    if (nl === -1) return text.length;
    off = nl + 1;
  }
  return off;
}

/** Raw text of the n-th (0-based) line, without line ending. */
function lineAt(text: string, n: number): string {
  const start = lineStartOffset(text, n);
  let end = text.indexOf("\n", start);
  if (end === -1) end = text.length;
  return text.slice(start, end).replace(/\r$/, "");
}

function nonEmptyCount(row: string[]): number {
  let n = 0;
  for (const c of row) if (c.trim() !== "") n++;
  return n;
}

/**
 * Find the header record. Title rows are typically narrow (a title in one or
 * two cells) above a wide table, so: take the modal non-empty width W of the
 * scanned records (ties -> wider), and pick the first record with at least
 * max(2, 60% of W) non-empty cells whose following record is not blank. The modal width must occur at least
 * twice (a single stray wide record is a malformed row, not a table).
 * A clean file's first record satisfies this, so behaviour is unchanged
 * there. Returns 0 when nothing qualifies.
 */
function detectHeaderIndex(records: string[][]): number {
  const limit = Math.min(records.length, HEADER_SCAN_LIMIT);
  const counts = records.slice(0, limit).map(nonEmptyCount);
  const freq = new Map<number, number>();
  for (const c of counts) if (c >= 2) freq.set(c, (freq.get(c) ?? 0) + 1);
  if (freq.size === 0) return 0;
  let width = 0;
  let best = 0;
  for (const [c, f] of freq) {
    if (f > best || (f === best && c > width)) {
      best = f;
      width = c;
    }
  }
  // A lone wide record is a malformed row, not a table: demand the width recur.
  if (best < 2) return 0;
  const need = Math.max(2, Math.ceil(width * 0.6));
  for (let i = 0; i < limit; i++) {
    if ((counts[i] ?? 0) < need) continue;
    const next = records[i + 1];
    if (next && nonEmptyCount(next) === 0) continue;
    return i;
  }
  return 0;
}

/**
 * Parse a CSV input into a ParsedSheet.
 */
export async function parseCsv(
  input: Buffer | Uint8Array | string,
  opts: ParseCsvOptions = {},
): Promise<ParsedSheet> {
  // 0. Size caps — reject loudly before doing any work.
  const maxBytes = opts.maxBytes ?? DEFAULT_CSV_MAX_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_CSV_MAX_LINES;
  const size = typeof input === "string" ? input.length : input.byteLength;
  if (size > maxBytes) throw new CsvLimitError("maxBytes", size, maxBytes);

  // 1. Decode to string
  let text: string;
  let bomDetected = false;
  let encoding = opts.encoding ?? "utf-8";
  let encodingFallback = false;

  if (typeof input === "string") {
    text = input;
  } else {
    // Buffer extends Uint8Array, so this branch covers both.
    const bytes =
      input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBufferLike);
    const d = decodeBytes(bytes, opts.encoding);
    text = d.text;
    encoding = d.encoding;
    bomDetected = d.bomDetected;
    encodingFallback = d.encodingFallback;
  }

  // 2. Strip BOM if it survived as a U+FEFF code unit at position 0
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(UTF8_BOM.length);
    bomDetected = true;
  }

  const lineCount = countLines(text);
  if (lineCount > maxLines) throw new CsvLimitError("maxLines", lineCount, maxLines);

  // 3. Header-row detection. Only the top of the file is scanned; when the
  //    header is the first record (the common case) the body is the whole text
  //    and the parse below is identical to the pre-detection behaviour.
  let headerRowIndex = opts.headerRowIndex ?? 0;
  if (opts.headerRowIndex === undefined) {
    const head = text.slice(0, lineStartOffset(text, HEADER_SCAN_LIMIT + 1));
    const probe = Papa.parse<string[]>(head, {
      header: false,
      delimiter: opts.delimiter ?? "",
      skipEmptyLines: false,
      dynamicTyping: false,
    });
    headerRowIndex = detectHeaderIndex(probe.data);
  }

  const preamble: PreambleRow[] = [];
  let body = text;
  if (headerRowIndex > 0) {
    for (let n = 0; n < headerRowIndex; n++) {
      const raw = lineAt(text, n);
      if (raw.replace(/[\s,;|"]/g, "") !== "") preamble.push({ lineNumber: n + 1, raw });
    }
    body = text.slice(lineStartOffset(text, headerRowIndex));
  }
  const lineOffset = headerRowIndex; // source lines above the body

  // 4. Parse
  const result = Papa.parse<CsvRow>(body, {
    header: true,
    delimiter: opts.delimiter ?? "", // empty string => Papa auto-detects
    skipEmptyLines: opts.skipEmptyLines ?? true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  });

  const headerRow = (result.meta.fields ?? []).map((f) => f.trim());
  const rawRows = result.data;

  // Build the set of malformed source-row indices (0-based, where 0 = first
  // data row, NOT counting the header). Papa Parse reports field count
  // mismatches as FieldMismatch errors with .row, and it also leaves a
  // `__parsed_extra` array on rows that had more columns than headers — these
  // are silent corruption (downstream code reads by header name and misses
  // the overflow). Treat both as malformed and exclude from `rows`.
  const malformedRowIndices = new Set<number>();
  const malformedFromErrors: MalformedRow[] = [];
  for (const e of result.errors) {
    if (e.type !== "FieldMismatch" && e.type !== "Quotes") continue;
    if (typeof e.row !== "number") continue;
    malformedRowIndices.add(e.row);
    const lineNumber = e.row + 2 + lineOffset; // +1 for 0-based, +1 for header
    const reason = e.type === "FieldMismatch"
      ? (e.code === "TooManyFields" ? "extra_fields" : "missing_fields")
      : "quote_mismatch";
    malformedFromErrors.push({
      lineNumber,
      raw: lineAt(text, lineNumber - 1),
      reason,
      message: e.message,
    });
  }

  // Also catch any row Papa accepted but stuffed with __parsed_extra — these
  // would otherwise look valid to downstream code reading by header name.
  const malformed: MalformedRow[] = [...malformedFromErrors];
  rawRows.forEach((row, idx) => {
    if (malformedRowIndices.has(idx)) return; // already accounted for
    if (Object.prototype.hasOwnProperty.call(row, "__parsed_extra")) {
      malformedRowIndices.add(idx);
      const lineNumber = idx + 2 + lineOffset;
      malformed.push({
        lineNumber,
        raw: lineAt(text, lineNumber - 1),
        reason: "extra_fields",
        message: "Row had more columns than the header — overflow in __parsed_extra.",
      });
    }
  });

  // Filter malformed rows out of the returned rows so downstream code only
  // sees clean rows. The malformed ones are surfaced via meta.malformed[].
  const rows = rawRows
    .filter((_, idx) => !malformedRowIndices.has(idx))
    .map((row) => {
      // Defensive: strip __parsed_extra if any survived (shouldn't, but cheap).
      if (Object.prototype.hasOwnProperty.call(row, "__parsed_extra")) {
        const clean = { ...row };
        delete (clean as Record<string, unknown>).__parsed_extra;
        return clean;
      }
      return row;
    });

  // Empty-row count: derive from non-empty body lines minus header, rows
  // accepted, and rows rejected as malformed.
  let emptyRowsSkipped = 0;
  if (opts.skipEmptyLines ?? true) {
    let nonEmptyLines = 0;
    let start = 0;
    while (start <= body.length) {
      let end = body.indexOf("\n", start);
      if (end === -1) end = body.length;
      if (body.slice(start, end).trim().length > 0) nonEmptyLines++;
      start = end + 1;
    }
    emptyRowsSkipped = Math.max(0, nonEmptyLines - 1 - rows.length - malformed.length);
  }

  return {
    sheetName: opts.sheetName ?? "csv",
    headerRow,
    rows,
    meta: {
      encoding,
      delimiter: result.meta.delimiter ?? opts.delimiter ?? ",",
      totalRows: rows.length,
      emptyRowsSkipped,
      malformedRows: malformed.length,
      malformed,
      bomDetected,
      encodingFallback,
      headerRowIndex,
      preamble,
    },
  };
}
