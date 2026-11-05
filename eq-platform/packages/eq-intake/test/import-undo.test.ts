import { describe, it, expect } from "vitest";
import { buildUndoPlan, type ImportBatchRecord } from "../src/import-undo.js";

const batch = (over: Partial<ImportBatchRecord>): ImportBatchRecord => ({
  intakeId: "i1",
  entity: "customer",
  table: "customers",
  committedCount: 2,
  committedIds: ["a", "b"],
  ...over,
});

describe("buildUndoPlan", () => {
  it("lists committed ids per batch", () => {
    const plan = buildUndoPlan([batch({})]);
    expect(plan.steps).toEqual([{ intakeId: "i1", entity: "customer", table: "customers", ids: ["a", "b"] }]);
    expect(plan.totals).toMatchObject({ batches: 1, idsToRemove: 2, committedRows: 2, unrecoverableRows: 0 });
    expect(plan.unrecoverable).toEqual([]);
  });

  it("orders children before parents regardless of input order", () => {
    const plan = buildUndoPlan([
      batch({ intakeId: "c", entity: "customer", table: "customers" }),
      batch({ intakeId: "k", entity: "contact", table: "contacts", committedIds: ["x", "y"] }),
      batch({ intakeId: "s", entity: "site", table: "sites", committedIds: ["p", "q"] }),
    ]);
    expect(plan.steps.map((s) => s.entity)).toEqual(["contact", "site", "customer"]);
  });

  it("never drops a batch whose ids are missing: it goes to unrecoverable with a reason", () => {
    const plan = buildUndoPlan([batch({ committedIds: [undefined, undefined] })]);
    expect(plan.steps).toEqual([]);
    expect(plan.unrecoverable[0]).toMatchObject({ reason: "no_ids_recorded", committedCount: 2 });
    expect(plan.totals.unrecoverableRows).toBe(2);
  });

  it("flags incomplete ids and keeps the known ones visible", () => {
    const plan = buildUndoPlan([batch({ committedIds: ["a", undefined] })]);
    expect(plan.unrecoverable[0]).toMatchObject({ reason: "ids_incomplete", knownIds: 1, partialIds: ["a"] });
  });

  it("flags duplicate ids and ids exceeding the committed count", () => {
    expect(buildUndoPlan([batch({ committedIds: ["a", "a"] })]).unrecoverable[0]?.reason).toBe("duplicate_ids");
    expect(buildUndoPlan([batch({ committedCount: 1, committedIds: ["a", "b"] })]).unrecoverable[0]?.reason).toBe(
      "ids_exceed_count",
    );
  });

  it("lists zero-commit batches under nothingToUndo with their staged count", () => {
    const plan = buildUndoPlan([batch({ committedCount: 0, committedIds: [], stagedCount: 3 })]);
    expect(plan.nothingToUndo).toEqual([{ intakeId: "i1", entity: "customer", table: "customers", stagedCount: 3 }]);
    expect(plan.steps).toEqual([]);
  });

  it("accounts for every committed row: ids to remove + unrecoverable = committed", () => {
    const plan = buildUndoPlan([
      batch({ intakeId: "1" }),
      batch({ intakeId: "2", committedIds: [undefined, undefined] }),
      batch({ intakeId: "3", committedCount: 0, committedIds: [] }),
    ]);
    expect(plan.totals.idsToRemove + plan.totals.unrecoverableRows).toBe(plan.totals.committedRows);
  });

  it("is pure: does not mutate its input and is repeatable", () => {
    const input = [batch({})];
    const snap = JSON.stringify(input);
    expect(buildUndoPlan(input)).toEqual(buildUndoPlan(input));
    expect(JSON.stringify(input)).toBe(snap);
  });

  it("always carries the caveats", () => {
    expect(buildUndoPlan([]).caveats.length).toBeGreaterThan(0);
  });
});
