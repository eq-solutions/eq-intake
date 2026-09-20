/**
 * remedial-tender-qualify skill — the 8-factor go/no-go evaluator (pure, no
 * AI / no DB). Built and tested before any vision extraction is wired in,
 * per the plan's own instruction. Covers both the preferred and no_go side
 * of every one of the 8 business-plan factors, the needs_review default for
 * unknown/unanswered input, the decision-composition rule, and a light
 * end-to-end pass through assembleQualification()'s manual-only path.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateQualification,
  assembleQualification,
  buildQualificationCandidate,
  emptyQualificationAnswers,
  DEFAULT_QUALIFICATION_CONFIG,
  QUALIFICATION_FACTORS,
} from "../../src/skills/remedial-tender-qualify/index.js";
import type {
  QualificationAnswers,
  QualificationConfig,
  QualificationFactor,
} from "../../src/skills/remedial-tender-qualify/index.js";

const CONFIG: QualificationConfig = DEFAULT_QUALIFICATION_CONFIG;

/** A full set of answers where every factor clears as "preferred" — the good tender. */
function allPreferredAnswers(): QualificationAnswers {
  return {
    client: {
      value: { knownReputableClient: true, paymentHistoryIssue: false, decisionMakerClear: true, principalType: "strata" },
      confidence: 0.9,
      source: "extracted",
    },
    scope: {
      value: { scopeInvestigatedAndDefined: true, majorUnknownsCount: 0 },
      confidence: 0.85,
      source: "extracted",
    },
    margin: {
      value: { marginEstimatePct: 22, reliesOnOptimisticVariations: false },
      confidence: null,
      source: "manual",
    },
    cash_flow: {
      value: { claimsFundDelivery: true, unfundedUpfrontExposure: 5000 },
      confidence: 0.7,
      source: "extracted",
    },
    contract: {
      value: { liabilityCapped: true, disproportionateLiability: false },
      confidence: 0.8,
      source: "extracted",
    },
    program: {
      value: { programAchievable: true, penaltyHeavyOrCompressed: false },
      confidence: 0.75,
      source: "extracted",
    },
    technical: {
      value: { provenCapability: true, uncontrolledDesignOrStructuralRisk: false },
      confidence: null,
      source: "manual",
    },
    location: {
      value: { region: "Southern Sydney", travelOrSupervisionBurdenHigh: false },
      confidence: 0.9,
      source: "extracted",
    },
  };
}

/** Deep-clone + patch one factor's value, keeping everything else preferred. */
function withFactor<F extends QualificationFactor>(
  factor: F,
  patch: Partial<QualificationAnswers[F]["value"]>,
): QualificationAnswers {
  const base = allPreferredAnswers();
  return {
    ...base,
    [factor]: { ...base[factor], value: { ...base[factor].value, ...patch } },
  };
}

describe("evaluateQualification — decision composition", () => {
  it("all 8 factors preferred -> decision price, full 8-line reasoning trail", () => {
    const result = evaluateQualification(allPreferredAnswers(), CONFIG);
    expect(result.decision).toBe("price");
    expect(result.perFactor).toHaveLength(8);
    expect(result.perFactor.every((f) => f.verdict === "preferred")).toBe(true);
    // Never just the label — every factor's own reason is in the trail.
    expect(result.reasons).toHaveLength(8);
    for (const r of result.reasons) expect(r.length).toBeGreaterThan(10);
  });

  it("a single no_go factor decides walk even when the other 7 are preferred", () => {
    const answers = withFactor("contract", { liabilityCapped: false });
    const result = evaluateQualification(answers, CONFIG);
    expect(result.decision).toBe("walk");
    expect(result.perFactor.find((f) => f.factor === "contract")?.verdict).toBe("no_go");
  });

  it("a single needs_review factor (no no_go present) decides needs_review, not price", () => {
    const answers = withFactor("technical", { provenCapability: null, uncontrolledDesignOrStructuralRisk: null });
    const result = evaluateQualification(answers, CONFIG);
    expect(result.decision).toBe("needs_review");
  });

  it("no_go outranks needs_review when both are present", () => {
    let answers = withFactor("contract", { liabilityCapped: false });
    answers = { ...answers, technical: { ...answers.technical, value: { provenCapability: null, uncontrolledDesignOrStructuralRisk: null } } };
    const result = evaluateQualification(answers, CONFIG);
    expect(result.decision).toBe("walk");
  });

  it("a completely empty/unanswered tender is needs_review across all 8 factors, never a silent preferred (EQ-AS-CONDUIT rule #11)", () => {
    const result = evaluateQualification(emptyQualificationAnswers(), CONFIG);
    expect(result.decision).toBe("needs_review");
    expect(result.perFactor.every((f) => f.verdict === "needs_review")).toBe(true);
    expect(result.perFactor).toHaveLength(QUALIFICATION_FACTORS.length);
    expect(result.reasons).toHaveLength(8);
  });

  it("decision_reason is always a real trail, not just the label, on every branch", () => {
    for (const answers of [allPreferredAnswers(), withFactor("margin", { marginEstimatePct: 2 }), emptyQualificationAnswers()]) {
      const result = evaluateQualification(answers, CONFIG);
      expect(result.reasons.join(" ")).not.toMatch(/^(price|walk|needs_review)$/i);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluateQualification — client factor (both sides)", () => {
  it("preferred: known/reputable, clean payment history, clear decision-maker", () => {
    const r = evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "client")!;
    expect(r.verdict).toBe("preferred");
  });
  it("no_go: known payment history issue", () => {
    const answers = withFactor("client", { paymentHistoryIssue: true });
    const r = evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "client")!;
    expect(r.verdict).toBe("no_go");
    expect(r.reason).toMatch(/payment history/i);
  });
  it("no_go: unclear decision-maker", () => {
    const answers = withFactor("client", { decisionMakerClear: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "client")!.verdict).toBe("no_go");
  });
  it("no_go: disallowed principal type, tenant-configured", () => {
    const config: QualificationConfig = { ...CONFIG, disallowedPrincipalTypes: ["owner_builder"] };
    const answers = withFactor("client", { principalType: "Owner_Builder" }); // case-insensitive match
    const r = evaluateQualification(answers, config).perFactor.find((f) => f.factor === "client")!;
    expect(r.verdict).toBe("no_go");
    expect(r.reason).toMatch(/disallowed/i);
  });
});

describe("evaluateQualification — scope factor (both sides)", () => {
  it("preferred: investigated/defined, no unknowns", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "scope")!.verdict).toBe("preferred");
  });
  it("no_go: scope not investigated/defined", () => {
    const answers = withFactor("scope", { scopeInvestigatedAndDefined: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "scope")!.verdict).toBe("no_go");
  });
  it("no_go: major unknowns exceed the tenant's tolerance", () => {
    const config: QualificationConfig = { ...CONFIG, maxAcceptableScopeUnknowns: 1 };
    const answers = withFactor("scope", { majorUnknownsCount: 3 });
    const r = evaluateQualification(answers, config).perFactor.find((f) => f.factor === "scope")!;
    expect(r.verdict).toBe("no_go");
    expect(r.reason).toMatch(/3.*exceeds.*1/);
  });
});

describe("evaluateQualification — margin factor (both sides, tenant threshold)", () => {
  it("preferred: meets the configured minimum without optimistic variations", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "margin")!.verdict).toBe("preferred");
  });
  it("no_go: below the configured minimum margin", () => {
    const config: QualificationConfig = { ...CONFIG, minMarginPct: 18 };
    const answers = withFactor("margin", { marginEstimatePct: 12 });
    const r = evaluateQualification(answers, config).perFactor.find((f) => f.factor === "margin")!;
    expect(r.verdict).toBe("no_go");
    expect(r.reason).toMatch(/12.*18/);
  });
  it("no_go: relies on optimistic variations even if the base margin clears", () => {
    const answers = withFactor("margin", { reliesOnOptimisticVariations: true });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "margin")!.verdict).toBe("no_go");
  });
  it("exactly at the threshold clears as preferred (>=, not >)", () => {
    const answers = withFactor("margin", { marginEstimatePct: CONFIG.minMarginPct });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "margin")!.verdict).toBe("preferred");
  });
});

describe("evaluateQualification — cash_flow factor (both sides)", () => {
  it("preferred: claims fund delivery, exposure within tolerance", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "cash_flow")!.verdict).toBe("preferred");
  });
  it("no_go: claims do not fund delivery", () => {
    const answers = withFactor("cash_flow", { claimsFundDelivery: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "cash_flow")!.verdict).toBe("no_go");
  });
  it("no_go: unfunded upfront exposure exceeds the tenant's tolerance", () => {
    const config: QualificationConfig = { ...CONFIG, maxUnfundedUpfrontExposure: 10000 };
    const answers = withFactor("cash_flow", { unfundedUpfrontExposure: 250000 });
    expect(evaluateQualification(answers, config).perFactor.find((f) => f.factor === "cash_flow")!.verdict).toBe("no_go");
  });
});

describe("evaluateQualification — contract factor (both sides)", () => {
  it("preferred: liability capped and proportionate", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "contract")!.verdict).toBe("preferred");
  });
  it("no_go: liability uncapped", () => {
    const answers = withFactor("contract", { liabilityCapped: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "contract")!.verdict).toBe("no_go");
  });
  it("no_go: disproportionate liability even when nominally capped", () => {
    const answers = withFactor("contract", { disproportionateLiability: true });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "contract")!.verdict).toBe("no_go");
  });
});

describe("evaluateQualification — program factor (both sides)", () => {
  it("preferred: achievable, not penalty-heavy", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "program")!.verdict).toBe("preferred");
  });
  it("no_go: program not achievable", () => {
    const answers = withFactor("program", { programAchievable: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "program")!.verdict).toBe("no_go");
  });
  it("no_go: penalty-heavy / artificially compressed", () => {
    const answers = withFactor("program", { penaltyHeavyOrCompressed: true });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "program")!.verdict).toBe("no_go");
  });
});

describe("evaluateQualification — technical factor (both sides)", () => {
  it("preferred: proven capability, controlled design/structural risk", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "technical")!.verdict).toBe("preferred");
  });
  it("no_go: capability not proven", () => {
    const answers = withFactor("technical", { provenCapability: false });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "technical")!.verdict).toBe("no_go");
  });
  it("no_go: uncontrolled design/structural risk", () => {
    const answers = withFactor("technical", { uncontrolledDesignOrStructuralRisk: true });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "technical")!.verdict).toBe("no_go");
  });
});

describe("evaluateQualification — location factor (both sides, tenant region preference)", () => {
  it("preferred: within the tenant's preferred operating area, no travel burden", () => {
    expect(evaluateQualification(allPreferredAnswers(), CONFIG).perFactor.find((f) => f.factor === "location")!.verdict).toBe("preferred");
  });
  it("no_go: travel/supervision burden explicitly high, even inside the preferred area", () => {
    const answers = withFactor("location", { travelOrSupervisionBurdenHigh: true });
    expect(evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "location")!.verdict).toBe("no_go");
  });
  it("needs_review (not an automatic no_go): outside the preferred region with travel burden unconfirmed", () => {
    const answers = withFactor("location", { region: "Regional NSW", travelOrSupervisionBurdenHigh: null });
    const r = evaluateQualification(answers, CONFIG).perFactor.find((f) => f.factor === "location")!;
    expect(r.verdict).toBe("needs_review");
    expect(r.reason).toMatch(/human call/i);
  });
});

describe("assembleQualification — manual-only path (no files/AI)", () => {
  it("merges manual header + answers over the empty defaults and evaluates", async () => {
    const result = await assembleQualification({
      manualHeader: { customerNameRaw: "Example Strata Plan", siteAddressRaw: "Southern Sydney" },
      manualAnswers: allPreferredAnswers(),
    });
    expect(result.header.customerNameRaw).toBe("Example Strata Plan");
    expect(result.evaluation.decision).toBe("price");
    expect(result.warnings.filter((w) => w.code === "factor_needs_review")).toHaveLength(0);
  });

  it("with no manual answers at all, every factor needs_review and each is warned about individually", async () => {
    const result = await assembleQualification({});
    expect(result.evaluation.decision).toBe("needs_review");
    const needsReviewWarnings = result.warnings.filter((w) => w.code === "factor_needs_review");
    expect(needsReviewWarnings).toHaveLength(8);
  });

  it("buildQualificationCandidate produces a decision + non-empty decision_reason only once status is decided (never a label-only reason)", async () => {
    const result = await assembleQualification({ manualAnswers: allPreferredAnswers() });
    const draft = buildQualificationCandidate(result.header, result.answers, result.evaluation, result.sourceFiles, "draft");
    expect(draft.decision).toBeNull();
    expect(draft.decision_reason).toBeNull();

    const decided = buildQualificationCandidate(result.header, result.answers, result.evaluation, result.sourceFiles, "decided");
    expect(decided.decision).toBe("price");
    expect(decided.decision_reason).toBeTruthy();
    expect(decided.decision_reason!.length).toBeGreaterThan(20);
    expect(decided.margin_estimate_pct).toBe(22);
  });
});
