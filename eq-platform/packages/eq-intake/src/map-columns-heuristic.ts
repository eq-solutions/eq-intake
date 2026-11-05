/**
 * Heuristic column mapper — deterministic baseline, no AI.
 *
 * Maps each source column to a canonical field using, in order:
 *   1. exact match on the field name or an `x-eq-source-aliases` entry, also
 *      tried with common abbreviations expanded ("Emp #" -> employee_number)
 *   2. reference noun: a bare "Customer" names the party, not its `customer_id`
 *   3. token subset: the header's words all appear in exactly one field name
 *   4. fuzzy match (Jaro-Winkler) against the same names, with the same length
 *      guard classify.ts uses
 * Two columns that land on the same field: the stronger match keeps it, the
 * other is returned unmapped with a reason (never both, never dropped). Every
 * unmapped column carries a `reason`.
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
  method: "exact" | "reference" | "token" | "fuzzy" | "none" | "duplicate_target" | "ambiguous";
  /** Why the column is unmapped. Always set when `field` is null. */
  reason?: string;
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
    .replace(/#/g, " number ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Abbreviation -> expansion, applied per word. Generic, not corpus strings. */
const ABBREVIATIONS: Record<string, string> = {
  no: "number",
  num: "number",
  nbr: "number",
  nr: "number",
  emp: "employee",
  mob: "mobile",
  wo: "work_order",
};

function expand(n: string): string {
  return n
    .split("_")
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join("_");
}

/** Of several fields a bare word could mean, the internal-cost side wins ("Rate" in a payroll file). */
function preferCost(fields: string[]): string[] {
  const cost = fields.filter((f) => f.split("_").includes("cost"));
  return cost.length === 1 ? cost : fields;
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

  const fieldNames = Object.keys(props).filter((f) => !SYSTEM_FIELDS.has(f));
  const fieldSet = new Set(fieldNames);
  const unmapped = (column: string, reason: string, method: "none" | "ambiguous" = "none"): ColumnMatch => ({
    column,
    field: null,
    confidence: 0,
    method,
    reason,
  });

  const matches: ColumnMatch[] = columns.map((column) => {
    const c = norm(column);
    const e = expand(c);
    if (SYSTEM_FIELDS.has(c)) return unmapped(column, "system column; an import never fills it");

    // "#" reads as "number", so "Mobile #" also tries "mobile".
    const bare = e.replace(/_number$/, "");
    const exact =
      names.find((n) => n.name === c) ?? names.find((n) => n.name === e) ?? names.find((n) => n.name === bare);
    if (exact) return { column, field: exact.field, confidence: 1, method: "exact" };

    // A bare noun that is the stem of an `<noun>_id` field names the thing, not its key.
    if (!c.includes("_") && fieldSet.has(`${c}_id`)) {
      const nameField = [`${c}_name`, "company_name", "client_name", "name"].find((f) => fieldSet.has(f));
      if (nameField) return { column, field: nameField, confidence: 0.9, method: "reference" };
      return unmapped(column, `'${column}' names an entity, not its ${c}_id key; no name field to map it to`);
    }

    // All the header's words appear in exactly one field name.
    const words = e.split("_").filter(Boolean);
    const hits = words.length
      ? fieldNames.filter((f) => {
          const fw = f.split("_");
          return words.every((w) => fw.includes(w));
        })
      : [];
    if (hits.length) {
      const pick = preferCost(hits);
      if (pick.length === 1) return { column, field: pick[0] as string, confidence: 0.8, method: "token" };
      return unmapped(column, `ambiguous: could be ${hits.join(", ")}`, "ambiguous");
    }

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
      : unmapped(column, "no field name or alias matched, exactly or closely");
  });

  // One column per field: strongest wins.
  const winner = new Map<string, number>();
  matches.forEach((m, i) => {
    if (!m.field) return;
    const cur = winner.get(m.field);
    if (cur === undefined || m.confidence > (matches[cur]?.confidence ?? 0)) winner.set(m.field, i);
  });
  return matches.map((m, i) => {
    if (!m.field || winner.get(m.field) === i) return m;
    const w = matches[winner.get(m.field) as number];
    return {
      column: m.column,
      field: null,
      confidence: 0,
      method: "duplicate_target" as const,
      reason: `'${w?.column}' is a stronger match for ${m.field}`,
    };
  });
};
