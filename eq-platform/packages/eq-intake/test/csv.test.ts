/**
 * CSV reader — first end-to-end test.
 *
 * Asserts:
 *   1. parseCsv reads the staff-clean.csv fixture into the expected shape
 *   2. The output is consumable by @eq/validation (no throw, summary populated)
 *
 * The second assertion is deliberately weak — it doesn't claim "all rows
 * valid" because the staff JSON Schema requires staff_id / tenant_id which
 * are intentionally absent from the fixture (those are server-assigned at
 * commit time). The point of the test is to prove the parser produces row
 * objects the validation engine can consume.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCsv, CsvLimitError } from "../src/readers/csv.js";
import { validate } from "@eq/validation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");

// Minimal inline schema for the validate() smoke check. We don't import the
// real staff schema here because the canonical schema requires fields that
// aren't in a clean import CSV. The point of the test is the parser.
const PERMISSIVE_STAFF_SCHEMA = {
  $id: "https://schemas.eq.solutions/test/staff-minimal.json",
  type: "object",
  "x-eq-entity": "staff",
  properties: {
    first_name: { type: "string", maxLength: 100 },
    last_name: { type: "string", maxLength: 100 },
    email: { type: "string", format: "email" },
    phone: { type: "string", "x-eq-coerce": "phone-au" },
    employment_type: {
      type: "string",
      enum: [
        "employee",
        "subcontractor",
        "apprentice",
        "labour_hire",
        "casual",
      ],
    },
    trade: { type: "string" },
    start_date: { type: "string", format: "date" },
    active: { type: "boolean", "x-eq-coerce": "boolean" },
  },
  required: ["first_name", "last_name", "employment_type", "active"],
};

describe("parseCsv — staff-clean.csv", () => {
  it("parses 10 rows with the correct headers", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-clean.csv"));
    const parsed = await parseCsv(raw);

    expect(parsed.rows).toHaveLength(10);
    expect(parsed.headerRow).toEqual([
      "first_name",
      "last_name",
      "email",
      "phone",
      "employment_type",
      "trade",
      "start_date",
      "active",
    ]);
    expect(parsed.meta.delimiter).toBe(",");
    expect(parsed.meta.totalRows).toBe(10);
    expect(parsed.meta.malformedRows).toBe(0);
  });

  it("reads James Patel as the first row with the right field values", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-clean.csv"));
    const parsed = await parseCsv(raw);

    const firstRow = parsed.rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow).toMatchObject({
      first_name: "James",
      last_name: "Patel",
      email: "james.patel@example.com.au",
      phone: "+61412345678",
      employment_type: "employee",
      trade: "electrical",
      start_date: "2022-03-01",
      active: "true",
    });
  });

  it("accepts a string input directly (not just Buffer)", async () => {
    const text = readFileSync(join(FIXTURE_DIR, "staff-clean.csv"), "utf-8");
    const parsed = await parseCsv(text);
    expect(parsed.rows).toHaveLength(10);
  });

  it("strips a UTF-8 BOM if present", async () => {
    const withBom = "﻿first_name,last_name\nJohn,Smith\n";
    const parsed = await parseCsv(withBom);
    expect(parsed.headerRow).toEqual(["first_name", "last_name"]);
    expect(parsed.rows[0]).toMatchObject({
      first_name: "John",
      last_name: "Smith",
    });
    expect(parsed.meta.bomDetected).toBe(true);
  });

  it("auto-detects a semicolon delimiter", async () => {
    const semi = "first_name;last_name\nJohn;Smith\nSarah;O'Brien\n";
    const parsed = await parseCsv(semi);
    expect(parsed.meta.delimiter).toBe(";");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]).toMatchObject({
      first_name: "Sarah",
      last_name: "O'Brien",
    });
  });
});

describe("parseCsv — malformed handling (added 2026-05-19 after overnight review)", () => {
  it("rejects rows with unquoted currency commas instead of silently corrupting them", async () => {
    // Pre-fix: `-$1,234.56` was split into amount="-$1" + __parsed_extra=["234.56"]
    // and the row showed up in `rows` looking valid. Now rejected with reason.
    // `($789)` is a valid 1-cell row for the 1-column header — it passes through.
    const input = "amount\n-$1,234.56\n($789)\n";
    const parsed = await parseCsv(input);
    expect(parsed.rows).toEqual([{ amount: "($789)" }]);
    expect(parsed.meta.malformedRows).toBe(1);
    expect(parsed.meta.malformed[0]?.reason).toBe("extra_fields");
    expect(parsed.meta.malformed[0]?.raw).toBe("-$1,234.56");
    expect(parsed.meta.malformed[0]?.lineNumber).toBe(2);
  });

  it("surfaces line number + raw text for missing-field rows", async () => {
    const input = "a,b,c\n1,2,3\n4,5\n6,7,8\n";
    const parsed = await parseCsv(input);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.meta.malformed).toHaveLength(1);
    expect(parsed.meta.malformed[0]?.lineNumber).toBe(3);
    expect(parsed.meta.malformed[0]?.raw).toBe("4,5");
    expect(parsed.meta.malformed[0]?.reason).toBe("missing_fields");
  });

  it("returned rows never carry __parsed_extra (defensive cleanup)", async () => {
    const input = "a,b\n1,2,3,4\n5,6\n";
    const parsed = await parseCsv(input);
    for (const row of parsed.rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "__parsed_extra")).toBe(false);
    }
  });

  it("clean input has empty malformed[]", async () => {
    const parsed = await parseCsv("a,b\n1,2\n3,4\n");
    expect(parsed.meta.malformed).toHaveLength(0);
    expect(parsed.meta.malformedRows).toBe(0);
    expect(parsed.rows).toHaveLength(2);
  });
});

describe("parseCsv — header-row detection (title rows)", () => {
  it("skips title + blank rows and reads the real header", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-title-rows.csv"));
    const parsed = await parseCsv(raw);
    expect(parsed.headerRow).toEqual(["first_name", "last_name", "email", "trade"]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toMatchObject({ first_name: "Anna", trade: "electrician" });
    expect(parsed.meta.headerRowIndex).toBe(3);
  });

  it("returns the rows above the header verbatim in meta.preamble (no silent drop)", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-title-rows.csv"));
    const parsed = await parseCsv(raw);
    expect(parsed.meta.preamble).toEqual([
      { lineNumber: 1, raw: "Staff export,,," },
      { lineNumber: 2, raw: "Generated for review,,," },
    ]);
  });

  it("reports absolute source line numbers for malformed rows below a title block", async () => {
    const input = "Report,,\n\na,b,c\n1,2,3\n4,5\n";
    const parsed = await parseCsv(input);
    expect(parsed.headerRow).toEqual(["a", "b", "c"]);
    expect(parsed.meta.malformed[0]?.lineNumber).toBe(5);
    expect(parsed.meta.malformed[0]?.raw).toBe("4,5");
  });

  it("leaves a clean file's header at record 0 with an empty preamble", async () => {
    const parsed = await parseCsv("a,b\n1,2\n");
    expect(parsed.meta.headerRowIndex).toBe(0);
    expect(parsed.meta.preamble).toEqual([]);
  });

  it("honours an explicit headerRowIndex", async () => {
    const parsed = await parseCsv("x,y\na,b\n1,2\n", { headerRowIndex: 1 });
    expect(parsed.headerRow).toEqual(["a", "b"]);
    expect(parsed.meta.preamble).toEqual([{ lineNumber: 1, raw: "x,y" }]);
  });
});

describe("parseCsv — encoding detection", () => {
  it("decodes a Windows-1252 file with accented names and reports the fallback", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-cp1252.csv"));
    const parsed = await parseCsv(raw);
    expect(parsed.meta.encoding).toBe("windows-1252");
    expect(parsed.meta.encodingFallback).toBe(true);
    expect(parsed.rows.map((r) => r.first_name)).toEqual(["José", "Renée", "Zoë"]);
    expect(parsed.rows.map((r) => r.last_name)).toEqual(["Müller", "O’Brien", "Nuñez"]);
  });

  it("keeps valid UTF-8 as utf-8 with no fallback flag", async () => {
    const parsed = await parseCsv(Buffer.from("name\nJosé\n", "utf-8"));
    expect(parsed.meta.encoding).toBe("utf-8");
    expect(parsed.meta.encodingFallback).toBe(false);
    expect(parsed.rows[0]).toEqual({ name: "José" });
  });

  it("decodes UTF-16LE with BOM", async () => {
    const body = Buffer.from("a,b\nÅsa,2\n", "utf16le");
    const parsed = await parseCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    expect(parsed.meta.encoding).toBe("utf-16le");
    expect(parsed.rows[0]).toEqual({ a: "Åsa", b: "2" });
  });

  it("uses an explicitly requested encoding without fallback", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-cp1252.csv"));
    const parsed = await parseCsv(raw, { encoding: "windows-1252" });
    expect(parsed.meta.encodingFallback).toBe(false);
    expect(parsed.rows[0]?.first_name).toBe("José");
  });
});

describe("parseCsv — size caps", () => {
  it("rejects input over maxBytes with a visible error, not a truncation", async () => {
    await expect(parseCsv("a,b\n1,2\n", { maxBytes: 4 })).rejects.toBeInstanceOf(CsvLimitError);
  });

  it("rejects input over maxLines", async () => {
    const big = `a,b\n${"1,2\n".repeat(50)}`;
    const err = await parseCsv(big, { maxLines: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(CsvLimitError);
    expect(err.limit).toBe("maxLines");
  });

  it("parses a file just under the caps", async () => {
    const parsed = await parseCsv(`a,b\n${"1,2\n".repeat(5000)}`, { maxLines: 6000 });
    expect(parsed.rows).toHaveLength(5000);
  });
});

describe("parseCsv → @eq/validation smoke test", () => {
  it("produces rows that @eq/validation can consume without throwing", async () => {
    const raw = readFileSync(join(FIXTURE_DIR, "staff-clean.csv"));
    const parsed = await parseCsv(raw);

    // Identity mapping: CSV column names already match canonical fields
    const mapping: Record<string, string | null> = {};
    for (const col of parsed.headerRow) {
      mapping[col] = col;
    }

    const result = await validate({
      schema: PERMISSIVE_STAFF_SCHEMA,
      mapping,
      rows: parsed.rows,
      tenantId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result.summary.total).toBe(10);
    // With a clean fixture and a permissive schema we expect all 10 rows valid.
    expect(result.summary.valid).toBe(10);
    expect(result.summary.rejected).toBe(0);
  });
});
