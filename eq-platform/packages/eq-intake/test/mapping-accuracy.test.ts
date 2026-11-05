/**
 * Scored mapping-accuracy corpus. Prints a score table; asserts a regression
 * floor, not perfection. Raise MIN_ACCURACY when the mapper improves.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapColumnsHeuristic, type ColumnMapper } from "../src/map-columns-heuristic.js";
import { scoreMapping, type MappingCase } from "../src/mapping-accuracy.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../../..");
const loadCases = (file: string) =>
  (JSON.parse(readFileSync(join(ROOT, "test-fixtures/mapping-accuracy", file), "utf8")) as { cases: MappingCase[] }).cases;
const corpus = loadCases("corpus.json");
const holdout = loadCases("holdout.json");
const holdout2 = loadCases("holdout2.json");
const holdout3 = loadCases("holdout3.json");

const schemas: Record<string, Record<string, unknown>> = {};
for (const f of readdirSync(join(ROOT, "schemas"))) {
  if (!f.endsWith(".schema.json")) continue;
  schemas[f.replace(".schema.json", "")] = JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8"));
}

/** Regression floor for the corpus (measured 100% on 2026-11-06, minus ~2 points of slack). */
const MIN_ACCURACY = 0.98;
/** Floor for the regression sets holdout.json + holdout2.json (rules were written after seeing them; measured 100%). */
const MIN_REGRESSION_HOLDOUT_ACCURACY = 0.95;
/** Lower floor for holdout3.json, the only never-tuned set (measured 95.3%, scored once). */
const MIN_HOLDOUT_ACCURACY = 0.9;

describe("mapping accuracy corpus", () => {
  const score = scoreMapping(corpus, schemas, mapColumnsHeuristic);

  it("prints the score", () => {
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const lines = [
      "",
      "mapping accuracy — heuristic baseline (no AI)",
      ...score.cases.map((c) => `  ${c.id.padEnd(32)} ${c.correct}/${c.total}`),
      `  TOTAL ${score.correct}/${score.totalColumns}  accuracy ${pct(score.accuracy)}  precision ${pct(score.precision)}  recall ${pct(score.recall)}`,
      "",
    ];
    for (const c of score.cases) {
      for (const w of c.wrong) lines.push(`  wrong   ${c.id}: ${w.column} -> ${w.got} (expected ${w.expected})`);
      for (const m of c.missed) lines.push(`  missed  ${c.id}: ${m}`);
      for (const s of c.spurious) lines.push(`  spurious ${c.id}: ${s}`);
    }
    console.log(lines.join("\n"));
    expect(score.totalColumns).toBeGreaterThan(0);
  });

  it("prints the held-out score", () => {
    const h = scoreMapping(holdout, schemas, mapColumnsHeuristic);
    const lines = [`held-out TOTAL ${h.correct}/${h.totalColumns}  accuracy ${(h.accuracy * 100).toFixed(1)}%`];
    for (const c of h.cases) {
      for (const w of c.wrong) lines.push(`  wrong   ${c.id}: ${w.column} -> ${w.got} (expected ${w.expected})`);
      for (const m of c.missed) lines.push(`  missed  ${c.id}: ${m}`);
      for (const x of c.spurious) lines.push(`  spurious ${c.id}: ${x}`);
    }
    console.log(lines.join("\n"));
    expect(h.totalColumns).toBeGreaterThanOrEqual(30);
  });

  it("stays at or above the regression floor", () => {
    expect(score.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });

  it("prints the second held-out score", () => {
    const h = scoreMapping(holdout2, schemas, mapColumnsHeuristic);
    const lines = [`held-out-2 TOTAL ${h.correct}/${h.totalColumns}  accuracy ${(h.accuracy * 100).toFixed(1)}%`];
    for (const c of h.cases) {
      for (const w of c.wrong) lines.push(`  wrong   ${c.id}: ${w.column} -> ${w.got} (expected ${w.expected})`);
      for (const m of c.missed) lines.push(`  missed  ${c.id}: ${m}`);
      for (const x of c.spurious) lines.push(`  spurious ${c.id}: ${x}`);
    }
    console.log(lines.join("\n"));
    expect(h.totalColumns).toBeGreaterThanOrEqual(30);
  });

  it("prints the third held-out score", () => {
    const h = scoreMapping(holdout3, schemas, mapColumnsHeuristic);
    const lines = [`held-out-3 TOTAL ${h.correct}/${h.totalColumns}  accuracy ${(h.accuracy * 100).toFixed(1)}%`];
    for (const c of h.cases) {
      for (const w of c.wrong) lines.push(`  wrong   ${c.id}: ${w.column} -> ${w.got} (expected ${w.expected})`);
      for (const m of c.missed) lines.push(`  missed  ${c.id}: ${m}`);
      for (const x of c.spurious) lines.push(`  spurious ${c.id}: ${x}`);
    }
    console.log(lines.join("\n"));
    expect(h.totalColumns).toBeGreaterThanOrEqual(30);
  });

  it("stays at or above the held-out floor", () => {
    const reg = scoreMapping([...holdout, ...holdout2], schemas, mapColumnsHeuristic);
    expect(reg.accuracy).toBeGreaterThanOrEqual(MIN_REGRESSION_HOLDOUT_ACCURACY);
    const h = scoreMapping(holdout3, schemas, mapColumnsHeuristic);
    expect(h.accuracy).toBeGreaterThanOrEqual(MIN_HOLDOUT_ACCURACY);
  });

  it("returns one result per column, and every unmapped one says why", () => {
    for (const c of [...corpus, ...holdout, ...holdout2, ...holdout3]) {
      const out = mapColumnsHeuristic(schemas[c.entity] as Record<string, unknown>, c.columns);
      expect(out.map((m) => m.column)).toEqual(c.columns);
      for (const m of out) {
        if (m.field === null) expect(m.reason, `${c.id}: ${m.column}`).toMatch(/\S/);
      }
    }
  });

  it("scores clean canonical headers perfectly", () => {
    const clean = score.cases.find((c) => c.id === "staff-clean-headers");
    expect(clean?.correct).toBe(clean?.total);
  });

  it("detects a bad mapper: mapping everything to null scores below the floor", () => {
    const none: ColumnMapper = (_s, cols) =>
      cols.map((column) => ({ column, field: null, confidence: 0, method: "none" as const }));
    expect(scoreMapping(corpus, schemas, none).accuracy).toBeLessThan(MIN_ACCURACY);
    expect(scoreMapping(holdout3, schemas, none).accuracy).toBeLessThan(MIN_HOLDOUT_ACCURACY);
  });

  it("refuses a corpus case with an unlabelled column", () => {
    const bad: MappingCase[] = [{ id: "x", entity: "staff", columns: ["a"], expected: {} }];
    expect(() => scoreMapping(bad, schemas, mapColumnsHeuristic)).toThrow(/no label/);
  });
});
