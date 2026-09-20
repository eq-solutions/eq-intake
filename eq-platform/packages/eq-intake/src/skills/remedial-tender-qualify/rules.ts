/**
 * rules.ts — the real 8-factor go/no-go matrix from the remedial-building
 * business plan (§8), implemented as a pure, synchronous, unit-testable
 * evaluator. No AI, no DB, no I/O of any kind.
 *
 * evaluateQualification() is deliberately the FIRST thing this skill builds
 * and tests, before any vision extraction is wired in — see the plan's
 * Part C.1 note "test this against sample tenders before any AI is in the
 * loop." Every other module in this skill (extract.ts, to-canonical.ts)
 * exists to produce this function's input or consume its output.
 *
 * Composition rule (deliberately simple and total):
 *   - Any factor verdict === "no_go"        -> overall decision "walk"
 *   - Else any factor verdict === "needs_review" -> overall decision "needs_review"
 *   - Else (all 8 "preferred")              -> overall decision "price"
 *
 * `reasons` is EVERY factor's reason, always — not just the ones that drove
 * the decision. EQ-AS-CONDUIT rule #11 ("never silently drop ... an
 * unanswerable question") argues for maximal honesty over a terse label: a
 * "walk" trail still tells you which OTHER factors were also unclear, and a
 * clean "price" trail still shows its working rather than asserting the
 * label. Every FactorEvaluation.reason is populated unconditionally,
 * including the preferred cases — never just the verdict word.
 *
 * An input field left `null` means "unknown". Unknown is NEVER silently
 * treated as preferred — it can only ever push a factor toward needs_review
 * (or, where the plan describes an explicit negative trigger, no_go still
 * fires from the fields that ARE known; a hard stop doesn't wait on an
 * unrelated unknown field to clear).
 */
import {
  QUALIFICATION_FACTORS,
  type CashFlowFactorInput,
  type ClientFactorInput,
  type ContractFactorInput,
  type FactorAnswer,
  type FactorEvaluation,
  type FactorVerdict,
  type LocationFactorInput,
  type MarginFactorInput,
  type ProgramFactorInput,
  type QualificationAnswers,
  type QualificationConfig,
  type QualificationDecision,
  type QualificationEvaluation,
  type QualificationFactor,
  type ScopeFactorInput,
  type TechnicalFactorInput,
} from "./types.js";

const FACTOR_LABEL: Record<QualificationFactor, string> = {
  client: "Client",
  scope: "Scope",
  margin: "Margin",
  cash_flow: "Cash flow",
  contract: "Contract",
  program: "Program",
  technical: "Technical",
  location: "Location",
};

/** Evaluate the full 8-factor matrix. Pure + synchronous — safe to unit test with plain objects, no mocks. */
export function evaluateQualification(
  answers: QualificationAnswers,
  config: QualificationConfig,
): QualificationEvaluation {
  const perFactor: FactorEvaluation[] = [
    evaluateClient(answers.client.value, config),
    evaluateScope(answers.scope.value, config),
    evaluateMargin(answers.margin.value, config),
    evaluateCashFlow(answers.cash_flow.value, config),
    evaluateContract(answers.contract.value),
    evaluateProgram(answers.program.value),
    evaluateTechnical(answers.technical.value),
    evaluateLocation(answers.location.value, config),
  ];

  const decision = composeDecision(perFactor);
  const reasons = perFactor.map((f) => `${FACTOR_LABEL[f.factor]}: ${f.reason}`);

  const riskAnswers = {} as Record<QualificationFactor, FactorAnswer>;
  for (const factor of QUALIFICATION_FACTORS) {
    const input = answers[factor];
    const verdict = perFactor.find((f) => f.factor === factor)!.verdict;
    riskAnswers[factor] = {
      answer: verdict,
      confidence: input.confidence,
      source: input.source,
      notes: input.notes ?? null,
    };
  }

  return { decision, reasons, perFactor, riskAnswers };
}

function composeDecision(perFactor: FactorEvaluation[]): QualificationDecision {
  if (perFactor.some((f) => f.verdict === "no_go")) return "walk";
  if (perFactor.some((f) => f.verdict === "needs_review")) return "needs_review";
  return "price";
}

function mk(factor: QualificationFactor, verdict: FactorVerdict, reason: string): FactorEvaluation {
  return { factor, verdict, reason };
}

// ============================================================================
// PER-FACTOR EVALUATORS
// Each checks its no_go trigger(s) first (a known hard-stop fires regardless
// of what else is unknown), then its preferred condition (requires every
// relevant field to be known-good), then falls through to needs_review.
// ============================================================================

function evaluateClient(v: ClientFactorInput, config: QualificationConfig): FactorEvaluation {
  const disallowed =
    v.principalType != null &&
    config.disallowedPrincipalTypes.some((d) => d.toLowerCase() === v.principalType!.toLowerCase());

  if (v.paymentHistoryIssue === true) {
    return mk("client", "no_go", "Known payment history issue with this client.");
  }
  if (v.decisionMakerClear === false) {
    return mk("client", "no_go", "The decision-maker is unclear.");
  }
  if (disallowed) {
    return mk("client", "no_go", `Principal type '${v.principalType}' is on this tenant's disallowed list.`);
  }
  if (v.knownReputableClient === true && v.paymentHistoryIssue === false && v.decisionMakerClear === true) {
    return mk("client", "preferred", "Known, reputable client with a clean payment history and a clear decision-maker.");
  }
  const unknowns = [
    v.knownReputableClient === null && "whether the client is known/reputable",
    v.paymentHistoryIssue === null && "payment history",
    v.decisionMakerClear === null && "whether the decision-maker is clear",
    v.principalType == null && "the principal type",
  ].filter((x): x is string => Boolean(x));
  return mk("client", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateScope(v: ScopeFactorInput, config: QualificationConfig): FactorEvaluation {
  if (v.scopeInvestigatedAndDefined === false) {
    return mk("scope", "no_go", "Scope has not been investigated or defined.");
  }
  if (v.majorUnknownsCount != null && v.majorUnknownsCount > config.maxAcceptableScopeUnknowns) {
    return mk(
      "scope",
      "no_go",
      `${v.majorUnknownsCount} major scope unknown(s) exceeds the tolerance of ${config.maxAcceptableScopeUnknowns}.`,
    );
  }
  if (
    v.scopeInvestigatedAndDefined === true &&
    v.majorUnknownsCount != null &&
    v.majorUnknownsCount <= config.maxAcceptableScopeUnknowns
  ) {
    return mk("scope", "preferred", "Scope has been investigated and defined, with no material unknowns.");
  }
  const unknowns = [
    v.scopeInvestigatedAndDefined === null && "whether the scope has been investigated/defined",
    v.majorUnknownsCount == null && "the count of major unknowns",
  ].filter((x): x is string => Boolean(x));
  return mk("scope", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateMargin(v: MarginFactorInput, config: QualificationConfig): FactorEvaluation {
  if (v.marginEstimatePct != null && v.marginEstimatePct < config.minMarginPct) {
    return mk(
      "margin",
      "no_go",
      `Estimated margin ${v.marginEstimatePct}% is below the ${config.minMarginPct}% minimum.`,
    );
  }
  if (v.reliesOnOptimisticVariations === true) {
    return mk("margin", "no_go", "Margin only meets target if optimistic variations land.");
  }
  if (
    v.marginEstimatePct != null &&
    v.marginEstimatePct >= config.minMarginPct &&
    v.reliesOnOptimisticVariations === false
  ) {
    return mk(
      "margin",
      "preferred",
      `Estimated margin ${v.marginEstimatePct}% meets the ${config.minMarginPct}% minimum without relying on variations.`,
    );
  }
  const unknowns = [
    v.marginEstimatePct == null && "the margin estimate",
    v.reliesOnOptimisticVariations === null && "whether it relies on optimistic variations",
  ].filter((x): x is string => Boolean(x));
  return mk("margin", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateCashFlow(v: CashFlowFactorInput, config: QualificationConfig): FactorEvaluation {
  if (v.claimsFundDelivery === false) {
    return mk("cash_flow", "no_go", "Progress claims do not fund delivery.");
  }
  if (v.unfundedUpfrontExposure != null && v.unfundedUpfrontExposure > config.maxUnfundedUpfrontExposure) {
    return mk(
      "cash_flow",
      "no_go",
      `$${v.unfundedUpfrontExposure.toLocaleString()} unfunded upfront exposure exceeds the $${config.maxUnfundedUpfrontExposure.toLocaleString()} tolerance.`,
    );
  }
  if (
    v.claimsFundDelivery === true &&
    v.unfundedUpfrontExposure != null &&
    v.unfundedUpfrontExposure <= config.maxUnfundedUpfrontExposure
  ) {
    return mk("cash_flow", "preferred", "Claims fund delivery, with acceptable unfunded upfront exposure.");
  }
  const unknowns = [
    v.claimsFundDelivery === null && "whether claims fund delivery",
    v.unfundedUpfrontExposure == null && "the unfunded upfront exposure",
  ].filter((x): x is string => Boolean(x));
  return mk("cash_flow", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateContract(v: ContractFactorInput): FactorEvaluation {
  if (v.liabilityCapped === false) {
    return mk("contract", "no_go", "Liability is uncapped.");
  }
  if (v.disproportionateLiability === true) {
    return mk("contract", "no_go", "Contract carries disproportionate liability.");
  }
  if (v.liabilityCapped === true && v.disproportionateLiability === false) {
    return mk("contract", "preferred", "Liability is capped and proportionate.");
  }
  const unknowns = [
    v.liabilityCapped === null && "whether liability is capped",
    v.disproportionateLiability === null && "whether liability is disproportionate",
  ].filter((x): x is string => Boolean(x));
  return mk("contract", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateProgram(v: ProgramFactorInput): FactorEvaluation {
  if (v.programAchievable === false) {
    return mk("program", "no_go", "Program is not achievable as specified.");
  }
  if (v.penaltyHeavyOrCompressed === true) {
    return mk("program", "no_go", "Program is artificially compressed or penalty-heavy.");
  }
  if (v.programAchievable === true && v.penaltyHeavyOrCompressed === false) {
    return mk("program", "preferred", "Program is achievable and not penalty-heavy.");
  }
  const unknowns = [
    v.programAchievable === null && "whether the program is achievable",
    v.penaltyHeavyOrCompressed === null && "whether it's penalty-heavy/compressed",
  ].filter((x): x is string => Boolean(x));
  return mk("program", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateTechnical(v: TechnicalFactorInput): FactorEvaluation {
  if (v.provenCapability === false) {
    return mk("technical", "no_go", "Capability for this work is not proven.");
  }
  if (v.uncontrolledDesignOrStructuralRisk === true) {
    return mk("technical", "no_go", "Uncontrolled design or structural risk is present.");
  }
  if (v.provenCapability === true && v.uncontrolledDesignOrStructuralRisk === false) {
    return mk("technical", "preferred", "Proven capability, with design/structural risk under control.");
  }
  const unknowns = [
    v.provenCapability === null && "whether capability is proven",
    v.uncontrolledDesignOrStructuralRisk === null && "design/structural risk control",
  ].filter((x): x is string => Boolean(x));
  return mk("technical", "needs_review", `Not enough information to clear this factor — unknown: ${unknowns.join(", ")}.`);
}

function evaluateLocation(v: LocationFactorInput, config: QualificationConfig): FactorEvaluation {
  if (v.travelOrSupervisionBurdenHigh === true) {
    return mk("location", "no_go", "Travel/supervision burden is high enough to erode margin.");
  }
  const inPreferredRegion =
    v.region != null && config.preferredRegions.some((r) => v.region!.toLowerCase().includes(r.toLowerCase()));
  if (inPreferredRegion && v.travelOrSupervisionBurdenHigh === false) {
    return mk("location", "preferred", `'${v.region}' is within the preferred operating area, with no travel/supervision burden.`);
  }
  if (v.region == null) {
    return mk("location", "needs_review", "Not enough information to clear this factor — unknown: the site region.");
  }
  if (!inPreferredRegion) {
    return mk(
      "location",
      "needs_review",
      `'${v.region}' is outside the preferred operating area and travel/supervision burden hasn't been confirmed — needs a human call.`,
    );
  }
  return mk("location", "needs_review", "Not enough information to clear this factor — unknown: travel/supervision burden.");
}
