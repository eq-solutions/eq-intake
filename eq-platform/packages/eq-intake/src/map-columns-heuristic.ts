/**
 * Heuristic column mapper — deterministic baseline, no AI.
 *
 * Maps each source column to a canonical field using, in order:
 *   1. exact match on the field name or an `x-eq-source-aliases` entry
 *   2. fuzzy match (Jaro-Winkler) against the same names, with the same length
 *      guard classify.ts uses
 * Two columns that land on the same field: the stronger match keeps it, the
 * other is returned unmapped with a reason (never both, never dropped).
 *
 * It exists as the thing the accuracy corpus scores today, and as the
 * reference an AI mapper must beat. Any `ColumnMapper` can be scored.
 */

import { jaroWinkler } from "@eq/validation";

export interface ColumnMatch {
  column: string;
  /** Canonical field, or null when nothing matched. */
  field: string | null;
  /** 0-1. */
  confidence: number;
  method: "exact" | "fuzzy" | "none" | "duplicate_target";
}

export type ColumnMapper = (
  schema: Record<string, unknown>,
  columns: string[],
) => ColumnMatch[];

const FUZZY_THRESHOLD = 0.85;
const MIN_LENGTH_RATIO = 0.65;
/** System columns an import never fills. */
const SYSTEM_FIELDS = new Set(["tenant_id", "imported_at", "imported_from"]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const mapColumnsHeuristic: ColumnMapper = (schema, columns) => {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const names: Array<{ name: string; field: string }> = [];
  for (const [field, def] of Object.entries(props)) {
    if (SYSTEM_FIELDS.has(field)) continue;
    names.push({ name: norm(field), field });
    for (const a of (def?.["x-eq-source-aliases"] ?? []) as string[]) {
      names.push({ name: norm(a), field });
    }
  }

  const matches: ColumnMatch[] = columns.map((column) => {
    const c = norm(column);
    const exact = names.find((n) => n.name === c);
    if (exact) return { column, field: exact.field, confidence: 1, method: "exact" };
    let best: { field: string; score: number } | null = null;
    for (const n of names) {
      const ratio = Math.min(c.length, n.name.length) / Math.max(c.length, n.name.length);
      if (ratio < MIN_LENGTH_RATIO) continue;
      const score = jaroWinkler(c, n.name);
      if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
        best = { field: n.field, score };
      }
    }
    return best
      ? { column, field: best.field, confidence: best.score, method: "fuzzy" as const }
      : { column, field: null, confidence: 0, method: "none" as const };
  });

  // One column per field: strongest wins.
  const winner = new Map<string, number>();
  matches.forEach((m, i) => {
    if (!m.field) return;
    const cur = winner.get(m.field);
    if (cur === undefined || m.confidence > (matches[cur]?.confidence ?? 0)) winner.set(m.field, i);
  });
  return matches.map((m, i) =>
    m.field && winner.get(m.field) !== i
      ? { column: m.column, field: null, confidence: 0, method: "duplicate_target" as const }
      : m,
  );
};
