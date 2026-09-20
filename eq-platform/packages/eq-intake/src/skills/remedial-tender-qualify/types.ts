/**
 * Types for the `remedial-tender-qualify` skill.
 *
 * Turns a remedial-building tender bundle (contract + spec + photos) into a
 * go/no-go decision against the 8-factor matrix from the business plan
 * (client, scope, margin, cash_flow, contract, program, technical, location)
 * — plus the raw header fields for a new `tender_qualification` row
 * (schemas/tender_qualification.schema.json).
 *
 * Unlike calibration-cert (many certs -> many asset candidates), this skill
 * is many-documents-in -> ONE qualification record out: a tender's contract,
 * spec, and photos all describe the same single decision.
 *
 * Public entry points (see index.ts):
 *   - `evaluateQualification(answers, config)` — pure core (no AI / no DB),
 *     the unit-testable 8-factor evaluator used by both the dry-run and the
 *     live path.
 *   - `assembleQualification({ files, ai, config, manualAnswers })` — full
 *     pipeline: vision extract -> merge manual answers -> evaluate -> map to
 *     the canonical tender_qualification row shape.
 */

// ============================================================================
// FACTORS
// ============================================================================

/** The 8 go/no-go factors from the business plan (§8), in matrix order. */
export const QUALIFICATION_FACTORS = [
  "client",
  "scope",
  "margin",
  "cash_flow",
  "contract",
  "program",
  "technical",
  "location",
] as const;

export type QualificationFactor = (typeof QUALIFICATION_FACTORS)[number];

/** Where a single field-level value came from, for audit. */
export type AnswerSource = "extracted" | "manual";

/**
 * Per-factor verdict. `needs_review` is the explicit, non-silent default for
 * "couldn't confidently answer" (EQ-AS-CONDUIT rule #11) — it is never
 * skipped in favour of guessing `preferred`.
 */
export type FactorVerdict = "preferred" | "no_go" | "needs_review";

/** Overall go/no-go outcome — matches tender_qualification.decision. */
export type QualificationDecision = "price" | "walk" | "needs_review";

/**
 * Persisted shape for one factor inside `tender_qualification.risk_answers`
 * — exactly `schemas/tender_qualification.schema.json`'s `factorAnswer` def.
 */
export interface FactorAnswer {
  answer: FactorVerdict;
  /** 0.0-1.0. Null for a manually-answered factor where it isn't meaningful. */
  confidence: number | null;
  source: AnswerSource;
  notes?: string | null;
}

// ============================================================================
// RAW PER-FACTOR INPUTS — what extract.ts / a human answers, before the
// pure evaluator turns them into a FactorVerdict. Each field is nullable:
// null means "unknown", and unknown must never be silently treated as
// preferred — see rules.ts.
// ============================================================================

export interface ClientFactorInput {
  knownReputableClient: boolean | null;
  paymentHistoryIssue: boolean | null;
  decisionMakerClear: boolean | null;
  /** Free-text principal type as extracted/entered, e.g. "owner_builder", "strata", "tier1_head_contractor". Compared case-insensitively against the tenant's disallowedPrincipalTypes. */
  principalType: string | null;
}

export interface ScopeFactorInput {
  scopeInvestigatedAndDefined: boolean | null;
  majorUnknownsCount: number | null;
}

export interface MarginFactorInput {
  /** Duplicates tender_qualification.margin_estimate_pct — kept here too so the evaluator is self-contained and testable without the row. */
  marginEstimatePct: number | null;
  reliesOnOptimisticVariations: boolean | null;
}

export interface CashFlowFactorInput {
  claimsFundDelivery: boolean | null;
  /** AUD. Large unfunded upfront exposure (materials/mobilisation paid before the first claim lands). */
  unfundedUpfrontExposure: number | null;
}

export interface ContractFactorInput {
  liabilityCapped: boolean | null;
  disproportionateLiability: boolean | null;
}

export interface ProgramFactorInput {
  programAchievable: boolean | null;
  penaltyHeavyOrCompressed: boolean | null;
}

export interface TechnicalFactorInput {
  provenCapability: boolean | null;
  uncontrolledDesignOrStructuralRisk: boolean | null;
}

export interface LocationFactorInput {
  /** Free-text region as extracted/entered, e.g. "Southern Sydney", "Regional NSW". */
  region: string | null;
  travelOrSupervisionBurdenHigh: boolean | null;
}

/** Provenance wrapper around one factor's raw input — source/confidence pass through untouched into the persisted FactorAnswer; they don't affect the verdict logic itself. */
export interface FactorInput<T> {
  value: T;
  confidence: number | null;
  source: AnswerSource;
  notes?: string | null;
}

export interface QualificationAnswers {
  client: FactorInput<ClientFactorInput>;
  scope: FactorInput<ScopeFactorInput>;
  margin: FactorInput<MarginFactorInput>;
  cash_flow: FactorInput<CashFlowFactorInput>;
  contract: FactorInput<ContractFactorInput>;
  program: FactorInput<ProgramFactorInput>;
  technical: FactorInput<TechnicalFactorInput>;
  location: FactorInput<LocationFactorInput>;
}

/** A fresh, all-unknown answer set — the safe starting point before any extraction/manual input lands. Every factor defaults to needs_review once evaluated, never preferred. */
export function emptyQualificationAnswers(): QualificationAnswers {
  return {
    client: { value: { knownReputableClient: null, paymentHistoryIssue: null, decisionMakerClear: null, principalType: null }, confidence: null, source: "manual" },
    scope: { value: { scopeInvestigatedAndDefined: null, majorUnknownsCount: null }, confidence: null, source: "manual" },
    margin: { value: { marginEstimatePct: null, reliesOnOptimisticVariations: null }, confidence: null, source: "manual" },
    cash_flow: { value: { claimsFundDelivery: null, unfundedUpfrontExposure: null }, confidence: null, source: "manual" },
    contract: { value: { liabilityCapped: null, disproportionateLiability: null }, confidence: null, source: "manual" },
    program: { value: { programAchievable: null, penaltyHeavyOrCompressed: null }, confidence: null, source: "manual" },
    technical: { value: { provenCapability: null, uncontrolledDesignOrStructuralRisk: null }, confidence: null, source: "manual" },
    location: { value: { region: null, travelOrSupervisionBurdenHigh: null }, confidence: null, source: "manual" },
  };
}

// ============================================================================
// TENANT-CONFIGURED THRESHOLDS
// ============================================================================

export interface QualificationConfig {
  /** Minimum acceptable margin %, after all costs, before any variations. Plan default: 15. */
  minMarginPct: number;
  /** Principal types this tenant will not price for, matched case-insensitively against ClientFactorInput.principalType. */
  disallowedPrincipalTypes: string[];
  /** Max "major unknowns" the scope factor tolerates before it's a no-go. Plan intent: investigated/defined scope, so default 0. */
  maxAcceptableScopeUnknowns: number;
  /** Max AUD unfunded upfront exposure the cash-flow factor tolerates. */
  maxUnfundedUpfrontExposure: number;
  /** Regions this tenant treats as operationally efficient. Plan default: Greater Sydney, southern Sydney. Matched case-insensitively. */
  preferredRegions: string[];
}

export const DEFAULT_QUALIFICATION_CONFIG: QualificationConfig = {
  minMarginPct: 15,
  disallowedPrincipalTypes: [],
  maxAcceptableScopeUnknowns: 0,
  maxUnfundedUpfrontExposure: 50000,
  preferredRegions: ["greater sydney", "southern sydney", "sydney"],
};

// ============================================================================
// EVALUATION RESULT
// ============================================================================

export interface FactorEvaluation {
  factor: QualificationFactor;
  verdict: FactorVerdict;
  /** Always populated — never just the verdict label (EQ-AS-CONDUIT rule #11). */
  reason: string;
}

export interface QualificationEvaluation {
  decision: QualificationDecision;
  /** The full reasoning trail — every no_go/needs_review reason, or a clean-pass summary when every factor is preferred. Never just the label. */
  reasons: string[];
  perFactor: FactorEvaluation[];
  /**
   * risk_answers in the exact shape tender_qualification persists —
   * ready to drop straight into the commit payload.
   */
  riskAnswers: Record<QualificationFactor, FactorAnswer>;
}

// ============================================================================
// HEADER FIELDS + EXTRACTION
// ============================================================================

/** Header fields extracted from (or manually entered for) the tender bundle — everything in tender_qualification that isn't risk_answers/decision. */
export interface QualificationHeader {
  customerNameRaw: string | null;
  contactRaw: string | null;
  siteAddressRaw: string | null;
  scopeSummary: string | null;
  contractValueEstimate: number | null;
}

export interface SourceFileRef {
  fileName: string;
  sha256: string | null;
  sizeBytes: number | null;
  kind: "contract" | "spec" | "photo" | "other" | null;
}

/**
 * Raw shape returned by the vision extraction call — mirrors
 * schema.ts's TENDER_QUALIFICATION_EXTRACT_SCHEMA field names exactly, one
 * object per file. `null` on any field means the model found no clear
 * evidence for it; extract.ts must never turn that into a guess.
 */
export interface TenderExtractRaw {
  customer_name_raw: string | null;
  contact_raw: string | null;
  site_address_raw: string | null;
  scope_summary: string | null;
  contract_value_estimate: number | null;
  client_principal_type: string | null;
  scope_investigated_and_defined: boolean | null;
  scope_major_unknowns_count: number | null;
  cash_flow_claims_fund_delivery: boolean | null;
  contract_liability_capped: boolean | null;
  contract_disproportionate_liability: boolean | null;
  program_achievable: boolean | null;
  program_penalty_heavy_or_compressed: boolean | null;
  technical_uncontrolled_design_or_structural_risk: boolean | null;
}

export const EMPTY_EXTRACT_RAW: TenderExtractRaw = {
  customer_name_raw: null,
  contact_raw: null,
  site_address_raw: null,
  scope_summary: null,
  contract_value_estimate: null,
  client_principal_type: null,
  scope_investigated_and_defined: null,
  scope_major_unknowns_count: null,
  cash_flow_claims_fund_delivery: null,
  contract_liability_capped: null,
  contract_disproportionate_liability: null,
  program_achievable: null,
  program_penalty_heavy_or_compressed: null,
  technical_uncontrolled_design_or_structural_risk: null,
};

export interface SkillFileInput {
  bytes: Buffer | Uint8Array | ArrayBuffer;
  fileName?: string;
  /** Caller's best guess at what this file is — used for source_files.kind and to steer the vision prompt. */
  kind?: SourceFileRef["kind"];
}

/** Non-fatal warnings the skill couldn't recover from but didn't fatal-error on. */
export interface SkillWarning {
  code: SkillWarningCode;
  message: string;
  context?: Record<string, unknown>;
}

export type SkillWarningCode =
  | "vision_unavailable"
  | "no_fields_extracted"
  | "vision_low_confidence"
  | "factor_needs_review";

export interface ExtractQualificationResult {
  header: Partial<QualificationHeader>;
  /** Only the factors the extractor could produce SOME signal for — merged onto emptyQualificationAnswers() by the caller, never overwriting a manual answer. */
  answers: Partial<QualificationAnswers>;
  sources: SourceFileRef[];
  warnings: SkillWarning[];
}

export interface AssembleQualificationInput {
  files: SkillFileInput[];
  /** AI provider for vision extraction. See extract.ts's header comment for why this must never be wired to a synchronous Netlify function. */
  ai?: import("@eq/ai").AIProvider;
  config?: Partial<QualificationConfig>;
  /**
   * Manual answers layered on top of the extracted ones — e.g. the
   * estimator's own answers to "needs review" questions. Manual always wins
   * over extracted for a given factor, matching risk_answers.source.
   */
  manualAnswers?: Partial<QualificationAnswers>;
  manualHeader?: Partial<QualificationHeader>;
}

export interface AssembleQualificationResult {
  header: QualificationHeader;
  answers: QualificationAnswers;
  evaluation: QualificationEvaluation;
  sourceFiles: SourceFileRef[];
  warnings: SkillWarning[];
}

/** The canonical tender_qualification row candidate — ready for eq_intake_commit_qualification's p_payload. */
export interface TenderQualificationCandidate {
  customer_name_raw: string | null;
  contact_raw: string | null;
  site_address_raw: string | null;
  scope_summary: string | null;
  contract_value_estimate: number | null;
  margin_estimate_pct: number | null;
  risk_answers: Record<QualificationFactor, FactorAnswer>;
  decision: QualificationDecision | null;
  decision_reason: string | null;
  source_files: SourceFileRef[];
  status: "draft" | "decided" | "archived";
}
