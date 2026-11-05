/**
 * Mapping-accuracy scoring. Pure: takes a labelled corpus and a mapper, returns
 * a score. No I/O, no AI. The corpus lives in test-fixtures/mapping-accuracy/.
 *
 * Per column, the label is the canonical field it should map to, or null when
 * it should stay unmapped (so over-eager mappers are penalised too).
 */

import type { ColumnMapper } from "./map-columns-heuristic.js";

export interface MappingCase {
  id: string;
  entity: string;
  /** Source headers in file order. */
  columns: string[];
  /** Header -> expected canonical field, or null for "leave unmapped". */
  expected: Record<string, string | null>;
}

export interface CaseScore {
  id: string;
  entity: string;
  total: number;
  correct: number;
  /** Mapped to the wrong field. */
  wrong: Array<{ column: string; expected: string | null; got: string | null }>;
  /** Expected a field, got null. */
  missed: string[];
  /** Expected null, got a field. */
  spurious: string[];
}

export interface CorpusScore {
  cases: CaseScore[];
  totalColumns: number;
  correct: number;
  /** correct / totalColumns */
  accuracy: number;
  /** Of columns the mapper mapped, share mapped correctly. */
  precision: number;
  /** Of columns that should map, share mapped correctly. */
  recall: number;
}

export function scoreMapping(
  corpus: readonly MappingCase[],
  schemas: Record<string, Record<string, unknown>>,
  mapper: ColumnMapper,
): CorpusScore {
  const cases: CaseScore[] = [];
  let mappedGot = 0;
  let mappedCorrect = 0;
  let shouldMap = 0;

  for (const c of corpus) {
    const schema = schemas[c.entity];
    if (!schema) throw new Error(`mapping corpus case '${c.id}': no schema for entity '${c.entity}'`);
    const result = mapper(schema, c.columns);
    const got = new Map(result.map((m) => [m.column, m.field]));
    const score: CaseScore = {
      id: c.id,
      entity: c.entity,
      total: c.columns.length,
      correct: 0,
      wrong: [],
      missed: [],
      spurious: [],
    };
    for (const col of c.columns) {
      if (!(col in c.expected)) throw new Error(`mapping corpus case '${c.id}': no label for column '${col}'`);
      const exp = c.expected[col] ?? null;
      const g = got.get(col) ?? null;
      if (exp !== null) shouldMap++;
      if (g !== null) mappedGot++;
      if (g === exp) {
        score.correct++;
        if (g !== null) mappedCorrect++;
      } else if (exp !== null && g === null) score.missed.push(col);
      else if (exp === null && g !== null) score.spurious.push(col);
      else score.wrong.push({ column: col, expected: exp, got: g });
    }
    cases.push(score);
  }

  const totalColumns = cases.reduce((n, c) => n + c.total, 0);
  const correct = cases.reduce((n, c) => n + c.correct, 0);
  return {
    cases,
    totalColumns,
    correct,
    accuracy: totalColumns === 0 ? 0 : correct / totalColumns,
    precision: mappedGot === 0 ? 0 : mappedCorrect / mappedGot,
    recall: shouldMap === 0 ? 0 : mappedCorrect / shouldMap,
  };
}
