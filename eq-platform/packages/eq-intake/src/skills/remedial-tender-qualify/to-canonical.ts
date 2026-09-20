/**
 * to-canonical.ts — two mapping directions for this skill:
 *
 *   1. mapExtractedToAnswers()  raw vision fields  -> QualificationHeader + QualificationAnswers
 *   2. buildQualificationCandidate()  evaluated state -> TenderQualificationCandidate
 *      (the exact eq_intake_commit_qualification p_payload shape, matching
 *      schemas/tender_qualification.schema.json)
 *
 * Mirrors calibration-cert's to-canonical.ts role: the pure, synchronous
 * mapping step between "what was extracted/decided" and "what the canonical
 * entity looks like". No AI, no DB.
 */
import type {
  FactorAnswer,
  QualificationAnswers,
  QualificationEvaluation,
  QualificationFactor,
  QualificationHeader,
  SourceFileRef,
  TenderExtractRaw,
  TenderQualificationCandidate,
} from "./types.js";

export interface MappedExtraction {
  header: Partial<QualificationHeader>;
  answers: Partial<QualificationAnswers>;
}

/**
 * Map the merged raw vision record into header fields + per-factor answers.
 * Every value stays `null` unless the extractor found real evidence for it
 * (see extract.ts / schema.ts) — this function does no guessing of its own,
 * it only reshapes what extraction already decided.
 */
export function mapExtractedToAnswers(
  raw: TenderExtractRaw,
  fieldConfidence: Partial<Record<keyof TenderExtractRaw, number>>,
): MappedExtraction {
  const header: Partial<QualificationHeader> = {
    customerNameRaw: nullIfBlank(raw.customer_name_raw),
    contactRaw: nullIfBlank(raw.contact_raw),
    siteAddressRaw: nullIfBlank(raw.site_address_raw),
    scopeSummary: nullIfBlank(raw.scope_summary),
    contractValueEstimate: raw.contract_value_estimate,
  };

  const answers: Partial<QualificationAnswers> = {};

  // client — only principalType is ever extractable from the documents
  // themselves; relationship history/decision-maker clarity is business
  // knowledge the estimator supplies manually (see schema.ts's own note).
  if (raw.client_principal_type != null) {
    answers.client = {
      value: {
        knownReputableClient: null,
        paymentHistoryIssue: null,
        decisionMakerClear: null,
        principalType: raw.client_principal_type,
      },
      confidence: fieldConfidence.client_principal_type ?? null,
      source: "extracted",
    };
  }

  if (raw.scope_investigated_and_defined != null || raw.scope_major_unknowns_count != null) {
    answers.scope = {
      value: {
        scopeInvestigatedAndDefined: raw.scope_investigated_and_defined,
        majorUnknownsCount: raw.scope_major_unknowns_count,
      },
      confidence: pickConfidence(fieldConfidence, "scope_investigated_and_defined", "scope_major_unknowns_count"),
      source: "extracted",
    };
  }

  if (raw.cash_flow_claims_fund_delivery != null) {
    answers.cash_flow = {
      value: {
        claimsFundDelivery: raw.cash_flow_claims_fund_delivery,
        unfundedUpfrontExposure: null,
      },
      confidence: fieldConfidence.cash_flow_claims_fund_delivery ?? null,
      source: "extracted",
    };
  }

  if (raw.contract_liability_capped != null || raw.contract_disproportionate_liability != null) {
    answers.contract = {
      value: {
        liabilityCapped: raw.contract_liability_capped,
        disproportionateLiability: raw.contract_disproportionate_liability,
      },
      confidence: pickConfidence(fieldConfidence, "contract_liability_capped", "contract_disproportionate_liability"),
      source: "extracted",
    };
  }

  if (raw.program_achievable != null || raw.program_penalty_heavy_or_compressed != null) {
    answers.program = {
      value: {
        programAchievable: raw.program_achievable,
        penaltyHeavyOrCompressed: raw.program_penalty_heavy_or_compressed,
      },
      confidence: pickConfidence(fieldConfidence, "program_achievable", "program_penalty_heavy_or_compressed"),
      source: "extracted",
    };
  }

  if (raw.technical_uncontrolled_design_or_structural_risk != null) {
    answers.technical = {
      value: {
        provenCapability: null,
        uncontrolledDesignOrStructuralRisk: raw.technical_uncontrolled_design_or_structural_risk,
      },
      confidence: fieldConfidence.technical_uncontrolled_design_or_structural_risk ?? null,
      source: "extracted",
    };
  }

  if (raw.site_address_raw != null) {
    answers.location = {
      value: {
        region: raw.site_address_raw,
        travelOrSupervisionBurdenHigh: null,
      },
      confidence: null,
      source: "extracted",
    };
  }

  // margin is never extracted — it's the business's own cost estimate, not
  // something a tender pack states. Always left for a manual answer.

  return { header, answers };
}

function pickConfidence(
  conf: Partial<Record<keyof TenderExtractRaw, number>>,
  ...fields: Array<keyof TenderExtractRaw>
): number | null {
  const values = fields.map((f) => conf[f]).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function nullIfBlank(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

/**
 * Build the eq_intake_commit_qualification payload from the assembled
 * header + answers + evaluation. `status` defaults to 'draft' unless a
 * decision has actually been recorded (matching the DB's
 * decided_status_has_decision constraint). margin_estimate_pct is pulled
 * from the margin factor's own input, since that's the one place it's
 * captured (see MarginFactorInput) — the header itself carries no margin
 * field of its own.
 */
export function buildQualificationCandidate(
  header: QualificationHeader,
  answers: QualificationAnswers | Partial<QualificationAnswers>,
  evaluation: QualificationEvaluation | null,
  sourceFiles: SourceFileRef[],
  status: "draft" | "decided" | "archived" = "draft",
): TenderQualificationCandidate {
  const riskAnswers = evaluation?.riskAnswers ?? ({} as Record<QualificationFactor, FactorAnswer>);
  return {
    customer_name_raw: header.customerNameRaw,
    contact_raw: header.contactRaw,
    site_address_raw: header.siteAddressRaw,
    scope_summary: header.scopeSummary,
    contract_value_estimate: header.contractValueEstimate,
    margin_estimate_pct: answers.margin?.value.marginEstimatePct ?? null,
    risk_answers: riskAnswers,
    decision: status === "decided" ? (evaluation?.decision ?? null) : null,
    decision_reason:
      status === "decided" && evaluation ? evaluation.reasons.join(" • ") : null,
    source_files: sourceFiles,
    status,
  };
}
