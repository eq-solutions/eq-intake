/**
 * Document classifier — given a parsed sheet, pick the canonical entity it
 * represents (staff / site / asset / swms / prestart / jsa / toolbox-talk /
 * incident / itp / schedule).
 *
 * Strategy: heuristic-first with optional AI fallback.
 *
 *   1. Score each canonical schema by how well its field names + source-
 *      aliases match the source columns of the parsed sheet (exact +
 *      fuzzy matching via Jaro-Winkler).
 *   2. If the top score has a clear lead over #2 (>= margin), return it
 *      without an AI call. This is the cheap path for routine imports.
 *   3. If the heuristic is ambiguous AND an AIProvider is supplied, ask
 *      the AI's map() call against each candidate schema and pick the
 *      one with the highest mapping coverage. (Future: a dedicated
 *      classify() prompt in @eq/ai would be cheaper than running map()
 *      N times.)
 *   4. If no AI is supplied and the heuristic is ambiguous, return the
 *      top candidate with the appropriate confidence — the caller
 *      decides whether to ask the user.
 *
 * Cost shape: routine imports of recognised entities skip AI entirely.
 * The signature-hash template cache (in @eq/validation) covers the next
 * level — same-shaped file second time around skips classification too.
 */

import { jaroWinkler } from "@eq/validation";
import type { AIProvider } from "@eq/ai";
import type { ParsedSheet } from "./readers/csv.js";

/** Single canonical schema, indexed by entity name. */
export type SchemaRegistry = Record<string, Record<string, unknown>>;

export interface ClassifyOptions {
  /** Map of entity name → JSON schema. Each schema must have x-eq-entity set. */
  schemas: SchemaRegistry;
  /** Parsed sheet to classify. */
  sheet: ParsedSheet;
  /** Optional AI provider. Used only when the heuristic is ambiguous. */
  ai?: AIProvider;
  /**
   * Heuristic confidence threshold required to skip the AI call. Default 0.65.
   * If top-candidate-score >= threshold AND gap to #2 >= margin, skip AI.
   */
  heuristicThreshold?: number;
  /**
   * Min gap between #1 and #2 (in score) required for the heuristic to be
   * considered decisive. Default 0.15.
   */
  heuristicMargin?: number;
  /** Sample rows passed to AI when fallback runs. Default first 10. */
  aiSampleSize?: number;
}

export interface ClassifyResult {
  /** The chosen canonical entity name. */
  entity: string;
  /** Confidence 0-1. Heuristic scores tend to land in 0.3-0.95. */
  confidence: number;
  /** How the answer was reached. */
  method: "heuristic" | "ai" | "ambiguous_fallback";
  /** Per-entity heuristic scores so the caller can show alternatives. */
  scores: Record<string, number>;
  /** One-line explanation of why this entity was chosen. */
  reason: string;
}

/**
 * Classify a parsed sheet against a registry of canonical schemas.
 */
export async function classifySheet(opts: ClassifyOptions): Promise<ClassifyResult> {
  const threshold = opts.heuristicThreshold ?? 0.65;
  const margin = opts.heuristicMargin ?? 0.15;

  const scores = scoreAllSchemas(opts.schemas, opts.sheet.headerRow);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    throw new Error("classifySheet: no schemas provided in registry.");
  }

  const [topEntity, topScore] = ranked[0]!;
  const secondScore = ranked[1]?.[1] ?? 0;

  // Decisive heuristic — skip AI.
  if (topScore >= threshold && topScore - secondScore >= margin) {
    return {
      entity: topEntity,
      confidence: topScore,
      method: "heuristic",
      scores,
      reason: `Heuristic match: ${Math.round(topScore * 100)}% of source columns aligned with '${topEntity}' aliases (lead of ${Math.round((topScore - secondScore) * 100)}% over '${ranked[1]?.[0] ?? "n/a"}').`,
    };
  }

  // Ambiguous — fall back to AI if available.
  if (opts.ai) {
    const aiResult = await classifyWithAi(opts.ai, opts.schemas, opts.sheet, opts.aiSampleSize ?? 10, scores);
    return aiResult;
  }

  return {
    entity: topEntity,
    confidence: topScore,
    method: "ambiguous_fallback",
    scores,
    reason: `Heuristic match was inconclusive (top ${Math.round(topScore * 100)}% vs second ${Math.round(secondScore * 100)}%). No AI provider supplied — returning top candidate.`,
  };
}

// ============================================================================
// HEURISTIC SCORING
// ============================================================================

const FUZZY_THRESHOLD = 0.85;

function scoreAllSchemas(
  schemas: SchemaRegistry,
  sourceColumns: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [entity, schema] of Object.entries(schemas)) {
    out[entity] = scoreOneSchema(schema, sourceColumns);
  }
  return out;
}

function scoreOneSchema(
  schema: Record<string, unknown>,
  sourceColumns: string[],
): number {
  if (sourceColumns.length === 0) return 0;

  const targets = collectTargetNames(schema);
  if (targets.size === 0) return 0;

  let matched = 0;
  for (const col of sourceColumns) {
    if (matchAny(col, targets)) matched++;
  }

  return matched / sourceColumns.length;
}

/**
 * Collect every recognisable name for fields in this schema:
 *   - The canonical field name itself
 *   - Every entry in x-eq-source-aliases
 *   - The entity name (x-eq-entity) as a low-priority match
 *
 * All lowercased + whitespace/punctuation stripped for comparison.
 */
function collectTargetNames(schema: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    out.add(normalise(fieldName));
    const aliases = (fieldSchema?.["x-eq-source-aliases"] ?? []) as string[];
    for (const a of aliases) out.add(normalise(a));
  }

  const entity = schema["x-eq-entity"];
  if (typeof entity === "string") out.add(normalise(entity));

  return out;
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Jaro-Winkler's common-prefix bonus lets a short plural header (e.g.
 * "Contacts") clear FUZZY_THRESHOLD against a much longer compound alias
 * that merely starts with the same root (e.g. "contact_position",
 * "contact_title") even though the two mean unrelated things. Requiring the
 * shorter string to be a reasonable fraction of the longer one keeps
 * genuine near-misses (site/sites, client/clients, contact/contacts) while
 * rejecting those prefix-only collisions.
 */
const MIN_FUZZY_LENGTH_RATIO = 0.65;

function matchAny(column: string, targets: Set<string>): boolean {
  const normCol = normalise(column);
  if (targets.has(normCol)) return true;
  // Fuzzy
  for (const t of targets) {
    const ratio = Math.min(normCol.length, t.length) / Math.max(normCol.length, t.length);
    if (ratio < MIN_FUZZY_LENGTH_RATIO) continue;
    if (jaroWinkler(normCol, t) >= FUZZY_THRESHOLD) return true;
  }
  return false;
}

// ============================================================================
// AI FALLBACK
// ============================================================================

/**
 * When the heuristic is ambiguous, run @eq/ai map() against each candidate
 * schema and pick the one with the highest mapping coverage. v1 implementation
 * tries the top 3 heuristic candidates only (not all 10) to bound cost.
 *
 * Future: a dedicated `classify(input: { schemas, columns, sample })` op in
 * @eq/ai would be a single round-trip instead of N. Tracked as Sprint C work.
 */
async function classifyWithAi(
  ai: AIProvider,
  schemas: SchemaRegistry,
  sheet: ParsedSheet,
  sampleSize: number,
  heuristicScores: Record<string, number>,
): Promise<ClassifyResult> {
  const top3 = Object.entries(heuristicScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([entity]) => entity);

  const sampleRows = sheet.rows.slice(0, sampleSize);
  let best: { entity: string; coverage: number } | undefined;

  for (const entity of top3) {
    const schema = schemas[entity];
    if (!schema) continue;
    try {
      const result = await ai.map({
        targetSchema: schema,
        sourceColumns: sheet.headerRow,
        sampleRows,
        contextHints: `Source sheet may be a ${entity} register. Reject if it isn't.`,
      });
      const mapped = result.mappings.filter((m) => m.canonicalField != null).length;
      const coverage = sheet.headerRow.length === 0 ? 0 : mapped / sheet.headerRow.length;
      if (!best || coverage > best.coverage) {
        best = { entity, coverage };
      }
    } catch {
      // One AI failure shouldn't kill classification — try the next candidate.
    }
  }

  if (!best) {
    // AI couldn't decide — fall back to top heuristic candidate
    const topEntity = top3[0]!;
    return {
      entity: topEntity,
      confidence: heuristicScores[topEntity] ?? 0,
      method: "ambiguous_fallback",
      scores: heuristicScores,
      reason: "AI classification failed for all top-3 candidates; returning top heuristic candidate.",
    };
  }

  return {
    entity: best.entity,
    confidence: best.coverage,
    method: "ai",
    scores: heuristicScores,
    reason: `AI mapping coverage was highest for '${best.entity}' (${Math.round(best.coverage * 100)}% of source columns mapped).`,
  };
}
