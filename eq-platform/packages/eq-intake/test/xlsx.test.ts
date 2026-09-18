/**
 * XLSX reader tests.
 *
 * Builds the test workbooks programmatically with ExcelJS (the same library
 * the reader itself uses) so we don't have to commit binary fixtures. Three
 * scenarios:
 *   1. Clean single-sheet workbook → all rows parse, headers detected at row 0
 *   2. Multi-sheet workbook → each sheet returned in order
 *   3. Workbook with a title row + blank row above the headers → header
 *      auto-detect picks the right row
 */

import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseXlsx } from "../src/readers/xlsx.js";
import { validate } from "@eq/validation";

type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };

/** Build an XLSX buffer from an array-of-arrays. */
async function buildXlsx(
  sheets: Array<{ name: string; rows: unknown[][]; hidden?: boolean; merges?: Merge[] }>,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { state: s.hidden ? "hidden" : "visible" });
    for (const row of s.rows) ws.addRow(row);
    for (const m of s.merges ?? []) {
      ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
    }
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

describe("parseXlsx — clean single-sheet workbook", () => {
  it("parses headers and rows from row 0", async () => {
    const buf = await buildXlsx([
      {
        name: "Staff",
        rows: [
          ["first_name", "last_name", "employment_type", "active"],
          ["James", "Patel", "employee", true],
          ["Sarah", "O'Brien", "subcontractor", true],
          ["Lien", "Tran", "apprentice", true],
        ],
      },
    ]);

    const wb = await parseXlsx(buf);

    expect(wb.sheets).toHaveLength(1);
    expect(wb.meta.totalSheets).toBe(1);
    expect(wb.meta.returnedSheets).toBe(1);
    expect(wb.meta.format).toBe("xlsx");

    const sheet = wb.sheets[0]!;
    expect(sheet.sheetName).toBe("Staff");
    expect(sheet.headerRowIndex).toBe(0);
    expect(sheet.headerRow).toEqual([
      "first_name",
      "last_name",
      "employment_type",
      "active",
    ]);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0]).toMatchObject({
      first_name: "James",
      last_name: "Patel",
      employment_type: "employee",
      active: true,
    });
  });
});

describe("parseXlsx — multi-sheet workbook", () => {
  it("returns one ParsedSheet per worksheet in workbook order", async () => {
    const buf = await buildXlsx([
      {
        name: "Staff",
        rows: [
          ["first_name", "last_name"],
          ["James", "Patel"],
        ],
      },
      {
        name: "Sites",
        rows: [
          ["name", "code"],
          ["Equinix SY3", "SY3"],
          ["NEXTDC S2", "S2"],
        ],
      },
    ]);

    const wb = await parseXlsx(buf);

    expect(wb.sheets).toHaveLength(2);
    expect(wb.sheets.map((s) => s.sheetName)).toEqual(["Staff", "Sites"]);
    expect(wb.sheets[0]!.rows).toHaveLength(1);
    expect(wb.sheets[1]!.rows).toHaveLength(2);
    expect(wb.sheets[1]!.rows[0]).toMatchObject({
      name: "Equinix SY3",
      code: "SY3",
    });
  });

  it("filters by sheetName when supplied", async () => {
    const buf = await buildXlsx([
      { name: "Staff", rows: [["a"], ["1"]] },
      { name: "Sites", rows: [["b"], ["2"]] },
    ]);
    const wb = await parseXlsx(buf, { sheetName: "Sites" });
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0]!.sheetName).toBe("Sites");
  });
});

describe("parseXlsx — auto-detects header row past title rows", () => {
  it("skips title + blank row and picks the real header row", async () => {
    const buf = await buildXlsx([
      {
        name: "Staff Export 2026",
        rows: [
          ["My Company Staff Export — 12 May 2026"], // title row, 1 cell
          [], // blank row
          ["first_name", "last_name", "employment_type"], // real header (row 2)
          ["James", "Patel", "employee"],
          ["Sarah", "O'Brien", "subcontractor"],
        ],
      },
    ]);

    const wb = await parseXlsx(buf);
    const sheet = wb.sheets[0]!;
    expect(sheet.headerRowIndex).toBe(2);
    expect(sheet.headerRow).toEqual(["first_name", "last_name", "employment_type"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toMatchObject({
      first_name: "James",
      last_name: "Patel",
      employment_type: "employee",
    });
  });
});

describe("parseXlsx — merged banner row does not fool header detection", () => {
  it("treats a merged title banner as one cell (ExcelJS/SheetJS parity)", async () => {
    const buf = await buildXlsx([
      {
        name: "Working Job List",
        rows: [
          ["MONTHLY JOB LIST", null, null], // banner, merged across A1:C1
          ["job_no", "site", "hours"], // real header (row 1)
          ["27151", "Equinix SY3", 8],
          ["27152", "NEXTDC S2", 6],
        ],
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
      },
    ]);

    const wb = await parseXlsx(buf);
    const sheet = wb.sheets[0]!;
    // Without the merged-slave null guard in worksheetToAoa, ExcelJS fills the
    // banner row with the repeated master value ("MONTHLY JOB LIST" ×3), which
    // detectHeaderRow (>=2 non-empty) would mis-pick as the header. The guard
    // nulls the slave cells, matching SheetJS, so the real header wins.
    expect(sheet.headerRowIndex).toBe(1);
    expect(sheet.headerRow).toEqual(["job_no", "site", "hours"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toMatchObject({ job_no: "27151", site: "Equinix SY3", hours: 8 });
  });
});

describe("parseXlsx — hidden sheets", () => {
  it("skips hidden sheets by default", async () => {
    const buf = await buildXlsx([
      { name: "Public", rows: [["a"], ["1"]] },
      { name: "Secret", rows: [["b"], ["2"]], hidden: true },
    ]);
    const wb = await parseXlsx(buf);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0]!.sheetName).toBe("Public");
  });

  it("includes hidden sheets when includeHidden:true", async () => {
    const buf = await buildXlsx([
      { name: "Public", rows: [["a"], ["1"]] },
      { name: "Secret", rows: [["b"], ["2"]], hidden: true },
    ]);
    const wb = await parseXlsx(buf, { includeHidden: true });
    expect(wb.sheets).toHaveLength(2);
  });
});

describe("parseXlsx → @eq/validation smoke test", () => {
  it("produces rows that validate() accepts as canonical staff data", async () => {
    const buf = await buildXlsx([
      {
        name: "Staff",
        rows: [
          ["first_name", "last_name", "employment_type", "active"],
          ["James", "Patel", "employee", true],
          ["Sarah", "O'Brien", "subcontractor", true],
        ],
      },
    ]);

    const wb = await parseXlsx(buf);
    const sheet = wb.sheets[0]!;

    const PERMISSIVE_STAFF_SCHEMA = {
      $id: "https://schemas.eq.solutions/test/staff-minimal.json",
      type: "object",
      "x-eq-entity": "staff",
      properties: {
        first_name: { type: "string", maxLength: 100 },
        last_name: { type: "string", maxLength: 100 },
        employment_type: {
          type: "string",
          enum: ["employee", "subcontractor", "apprentice", "labour_hire", "casual"],
        },
        active: { type: "boolean", "x-eq-coerce": "boolean" },
      },
      required: ["first_name", "last_name", "employment_type", "active"],
    };

    const mapping: Record<string, string | null> = {};
    for (const col of sheet.headerRow) mapping[col] = col;

    const result = await validate({
      schema: PERMISSIVE_STAFF_SCHEMA,
      mapping,
      rows: sheet.rows,
      tenantId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result.summary.total).toBe(2);
    expect(result.summary.valid).toBe(2);
    expect(result.summary.rejected).toBe(0);
  });
});

describe("parseXlsx — comma-joined multi-value cell (regression)", () => {
  // Real-world shape confirmed against a hand-maintained client register
  // (comma-joined suburb names in one "Sites" cell, e.g. "Wollongong,
  // Malabar"). The reader has no concept of splitting a cell into multiple
  // records — and shouldn't: it doesn't know which column feeds a
  // splittable canonical field until classify+map run. This locks in that
  // the raw joined string passes through unchanged; @eq/validation's
  // x-eq-multi-value detection (see multi-value-candidate.test.ts) is what
  // catches it downstream.
  it("passes a comma-joined cell through as one unsplit string", async () => {
    const buf = await buildXlsx([
      {
        name: "Client List",
        rows: [
          ["Client", "Sites"],
          ["Acme Pty Ltd", "Wollongong, Malabar"],
          ["Beta Co", "Artarmon, Alexandria"],
        ],
      },
    ]);

    const wb = await parseXlsx(buf);
    const sheet = wb.sheets[0]!;

    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]!.Sites).toBe("Wollongong, Malabar");
    expect(sheet.rows[1]!.Sites).toBe("Artarmon, Alexandria");
  });

  it("validate() flags the unsplit cell as a multi_value_candidate on a hinted field", async () => {
    const buf = await buildXlsx([
      {
        name: "Client List",
        rows: [
          ["Client", "Sites"],
          ["Acme Pty Ltd", "Wollongong, Malabar"],
        ],
      },
    ]);
    const wb = await parseXlsx(buf);
    const sheet = wb.sheets[0]!;

    const MINIMAL_SITE_SCHEMA = {
      $id: "https://schemas.eq.solutions/test/site-minimal.json",
      type: "object",
      "x-eq-entity": "site",
      properties: {
        client_name: { type: "string", maxLength: 200 },
        name: { type: "string", maxLength: 200, "x-eq-multi-value": true },
      },
      required: ["client_name", "name"],
    };

    const result = await validate({
      schema: MINIMAL_SITE_SCHEMA,
      mapping: { Client: "client_name", Sites: "name" },
      rows: sheet.rows,
      tenantId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result.summary.rejected).toBe(0);
    const row = result.flagged_rows[0]!;
    expect(row.canonical.name).toBe("Wollongong, Malabar");
    const flag = row.flags.find((f) => f.kind === "multi_value_candidate");
    expect(flag).toBeDefined();
    if (flag?.kind === "multi_value_candidate") {
      expect(flag.field).toBe("name");
      expect(flag.values).toEqual(["Wollongong", "Malabar"]);
    }
  });
});
