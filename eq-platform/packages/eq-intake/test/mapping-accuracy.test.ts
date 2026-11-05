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
const corpus = (JSON.parse(
  readFileSync(join(ROOT, "test-fixtures/mapping-accuracy/corpus.json"), "utf8"),
) as { cases: MappingCase[] }).cases;

const schemas: Record<string, Record<string, unknown>> = {};
for (const f of readdirSync(join(ROOT, "schemas"))) {
  if (!f.endsWith(".schema.json")) continue;
  schemas[f.replace(".schema.json", "")] = JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8"));
}

/** Regression floor for the heuristic baseline (measured, minus a little slack). */
const MIN_ACCURACY = 0.8;

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

  it("stays at or above the regression floor", () => {
    expect(score.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });

  it("scores clean canonical headers perfectly", () => {
    const clean = score.cases.find((c) => c.id === "staff-clean-headers");
    expect(clean?.correct).toBe(clean?.total);
  });

  it("detects a bad mapper: mapping everything to null scores below the floor", () => {
    const none: ColumnMapper = (_s, cols) =>
      cols.map((column) => ({ column, field: null, confidence: 0, method: "none" as const }));
    expect(scoreMapping(corpus, schemas, none).accuracy).toBeLessThan(MIN_ACCURACY);
  });

  it("refuses a corpus case with an unlabelled column", () => {
    const bad: MappingCase[] = [{ id: "x", entity: "staff", columns: ["a"], expected: {} }];
    expect(() => scoreMapping(bad, schemas, mapColumnsHeuristic)).toThrow(/no label/);
  });
});
