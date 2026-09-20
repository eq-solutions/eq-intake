/**
 * `remedial-tender-qualify` — EQ Intake skill for the remedial-building
 * go/no-go screening pack (plan §C.1).
 *
 * Why: the estimator, at the moment a tender lands, needs to decide inside
 * the response window whether it's worth spending real estimating hours on
 * — before a customer, job, or contract record exists in EQ at all. This
 * skill reads the tender bundle (contract + spec + photos, vision), merges
 * that with whatever the estimator answers by hand, runs the real 8-factor
 * go/no-go matrix from the business plan, and emits a decision (price / walk
 * / needs_review) with a full reasoning trail — never just the label. It
 * does NOT touch the DB — the caller commits via eq_intake_commit_qualification
 * (sql/066_intake_qualification_pack.sql).
 *
 * Target canonical entity: `tender_qualification`
 * (schemas/tender_qualification.schema.json). Deliberately outside the
 * canonical staff/site/asset spine — no customer/site/contact FK, since this
 * is pre-sale.
 *
 * Public entry points:
 *   - `evaluateQualification(answers, config)` — pure core (no AI/no DB), the
 *     unit-testable 8-factor evaluator used by the dry-run and the live path
 *     alike. Build and test this FIRST, before any AI is in the loop.
 *   - `assembleQualification({ files, ai, config, manualAnswers, manualHeader })`
 *     — full pipeline: vision extract (if files/ai supplied) -> merge manual
 *     answers over extracted ones -> evaluate -> canonical candidate.
 *
 * See extract.ts's header comment before wiring this into any HTTP endpoint
 * — extraction must run as a background function, never a synchronous one.
 */
import { extractTenderBundle } from "./extract.js";
import { evaluateQualification } from "./rules.js";
import { mapExtractedToAnswers } from "./to-canonical.js";
import { DEFAULT_QUALIFICATION_CONFIG, emptyQualificationAnswers } from "./types.js";
import type {
  AssembleQualificationInput,
  AssembleQualificationResult,
  QualificationAnswers,
  QualificationConfig,
  QualificationFactor,
  QualificationHeader,
  SkillWarning,
} from "./types.js";

const EMPTY_HEADER: QualificationHeader = {
  customerNameRaw: null,
  contactRaw: null,
  siteAddressRaw: null,
  scopeSummary: null,
  contractValueEstimate: null,
};

/**
 * Full pipeline: extract the bundle (if files + ai are supplied) -> layer
 * manual answers on top (manual always wins over extracted, factor-by-
 * factor, matching risk_answers' own source tagging) -> evaluate.
 *
 * Every one of the 8 factors is present in the returned `answers`/
 * `evaluation.riskAnswers` even when nothing was ever supplied for it —
 * emptyQualificationAnswers() guarantees that, and evaluateQualification()
 * turns an all-null factor into an explicit `needs_review`, never a silent
 * `preferred` (EQ-AS-CONDUIT rule #11).
 */
export async function assembleQualification(
  input: AssembleQualificationInput,
): Promise<AssembleQualificationResult> {
  const warnings: SkillWarning[] = [];
  const config: QualificationConfig = { ...DEFAULT_QUALIFICATION_CONFIG, ...input.config };

  let extractedHeader: Partial<QualificationHeader> = {};
  let extractedAnswers: Partial<QualificationAnswers> = {};
  let sourceFiles: AssembleQualificationResult["sourceFiles"] = [];

  if (input.files && input.files.length > 0) {
    const extraction = await extractTenderBundle(input.files, input.ai);
    warnings.push(...extraction.warnings);
    sourceFiles = extraction.sources;
    const mapped = mapExtractedToAnswers(extraction.merged, extraction.fieldConfidence);
    extractedHeader = mapped.header;
    extractedAnswers = mapped.answers;
  }

  const header: QualificationHeader = {
    ...EMPTY_HEADER,
    ...extractedHeader,
    ...input.manualHeader,
  };

  const answers: QualificationAnswers = {
    ...emptyQualificationAnswers(),
    ...extractedAnswers,
    ...input.manualAnswers,
  };

  const evaluation = evaluateQualification(answers, config);

  // Every needs_review factor also surfaces as a warning — evaluation.perFactor
  // already carries it, but a warning is what the generic intake UI/log
  // conventions elsewhere in this codebase scan for (EQ-AS-CONDUIT rule #11:
  // an unanswerable question must be visible, not just present if you know
  // to go looking for it).
  for (const f of evaluation.perFactor) {
    if (f.verdict === "needs_review") {
      warnings.push({
        code: "factor_needs_review",
        message: `${factorTitle(f.factor)} needs review: ${f.reason}`,
        context: { factor: f.factor },
      });
    }
  }

  return { header, answers, evaluation, sourceFiles, warnings };
}

function factorTitle(f: QualificationFactor): string {
  return f
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

// Public re-exports so callers don't have to reach into subpaths.
export { evaluateQualification } from "./rules.js";
export { extractTenderBundle } from "./extract.js";
export { mapExtractedToAnswers, buildQualificationCandidate } from "./to-canonical.js";
export {
  QUALIFICATION_FACTORS,
  DEFAULT_QUALIFICATION_CONFIG,
  emptyQualificationAnswers,
} from "./types.js";
export { TENDER_QUALIFICATION_EXTRACT_SCHEMA } from "./schema.js";
export type {
  QualificationFactor,
  AnswerSource,
  FactorVerdict,
  QualificationDecision,
  FactorAnswer,
  ClientFactorInput,
  ScopeFactorInput,
  MarginFactorInput,
  CashFlowFactorInput,
  ContractFactorInput,
  ProgramFactorInput,
  TechnicalFactorInput,
  LocationFactorInput,
  FactorInput,
  QualificationAnswers,
  QualificationConfig,
  FactorEvaluation,
  QualificationEvaluation,
  QualificationHeader,
  SourceFileRef,
  SkillFileInput,
  SkillWarning,
  SkillWarningCode,
  TenderExtractRaw,
  AssembleQualificationInput,
  AssembleQualificationResult,
  TenderQualificationCandidate,
} from "./types.js";
