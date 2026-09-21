/**
 * QualifyModule — the go/no-go tender screening tab (plan §C.1).
 *
 * A single Q&A-driven decision, not a spreadsheet import: drop a tender
 * bundle (contract / spec / photos), let vision fill in whatever it can
 * confidently read, then answer whatever's left as "needs review" by hand.
 * The decision + reasoning trail update live after every answer.
 *
 * Deliberately its own small component driven by createQualifyFlow()
 * (../qualify/qualify-store.js) rather than @eq/confirm-ui's ConfirmFlow —
 * see qualify-types.ts's header comment for why that machine's
 * spreadsheet-shaped phases don't fit here.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { createQualifyFlow } from "../qualify/qualify-store.js";
import type { CommitQualificationResult } from "../qualify/qualify-types.js";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import {
  QUALIFICATION_FACTORS,
  type QualificationAnswers,
  type QualificationFactor,
} from "@eq/intake/remedial-tender-qualify";

export interface QualifyModuleProps {
  /** Authenticated Supabase client — same one IntakeModule.tsx receives. Commits call eq_intake_commit_qualification through it. */
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  /** Vision provider for extraction. See qualify-types.ts's QualifyFlowConfig.ai doc — omit in any context where file bytes should instead go to a background function. */
  ai?: import("@eq/ai").AIProvider | null;
}

const FACTOR_TITLE: Record<QualificationFactor, string> = {
  client: "Client",
  scope: "Scope",
  margin: "Margin",
  cash_flow: "Cash flow",
  contract: "Contract",
  program: "Program",
  technical: "Technical",
  location: "Location",
};

const VERDICT_LABEL: Record<string, string> = {
  preferred: "Clear",
  no_go: "No-go",
  needs_review: "Needs review",
};

export function QualifyModule({ supabase, tenantId, ai }: QualifyModuleProps): JSX.Element {
  const { useStore, driver } = useMemo(() => createQualifyFlow(), []);
  const state = useStore();
  const [files, setFilesLocal] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    driver.configure({
      // Not read anywhere in qualify-store — only the commit closure's own
      // `tenantId` (checked below) is load-bearing for the actual write.
      // Required by QualifyFlowConfig's type, so an empty string stands in
      // rather than a fixture UUID that could be mistaken for a real one.
      tenantId: tenantId ?? "",
      ai: ai ?? undefined,
      commit: async (payload) => {
        if (!supabase) {
          throw new Error("EQ isn't connected yet — ask whoever set this up to fill in the connection details.");
        }
        if (!tenantId) {
          throw new Error("Missing tenant — can't save.");
        }
        const { data, error: rpcError } = await supabase.rpc("eq_intake_commit_qualification", {
          p_tenant_id: tenantId,
          p_payload: payload,
        });
        if (rpcError) throw new Error(rpcError.message);
        return data as CommitQualificationResult;
      },
    });
    // Re-configure whenever the identity of the wiring changes; driver.configure() resets the in-progress flow, which is the right call when the tenant/session actually changes underneath this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, ai, supabase]);

  const runExtract = async () => {
    setError(null);
    try {
      const withBytes = await Promise.all(
        files.map(async (f) => ({
          fileName: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
          kind: guessKind(f.name),
        })),
      );
      useStore.getState().setFiles(withBytes);
      await driver.extract();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="eq-qualify-module">
      <h2>Go / no-go screening</h2>
      <p>
        Drop the tender's contract, spec, and any scope photos. We'll pull what we can from the
        documents; answer whatever's flagged "needs review" and the decision updates as you go.
      </p>

      {!supabase && (
        <div className="eq-intake-info-strip">
          EQ isn't connected yet — ask whoever set this up to fill in the connection details.
          Saving stays inactive until then.
        </div>
      )}

      {supabase && !tenantId && (
        <div className="eq-intake-info-strip">
          Missing tenant — saving stays inactive until this is fixed.
        </div>
      )}

      {error && (
        <div role="alert" className="eq-intake-alert">
          {error}
        </div>
      )}

      <div className="eq-qualify-dropzone">
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          onChange={(e) => setFilesLocal(Array.from(e.target.files ?? []))}
        />
        <button
          type="button"
          className="eq-intake-btn-primary"
          disabled={state.status.kind === "extracting" || files.length === 0}
          onClick={runExtract}
        >
          {state.status.kind === "extracting" ? "Reading documents…" : "Extract from documents"}
        </button>
        {!ai && (
          <p className="eq-qualify-hint">
            No vision provider configured — extraction will flag every field as needing review;
            answer the questions below by hand.
          </p>
        )}
      </div>

      {state.warnings.length > 0 && (
        <ul className="eq-qualify-warnings">
          {state.warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      )}

      <div className="eq-qualify-header-fields">
        <label>
          Client / customer
          <input
            type="text"
            value={state.header.customerNameRaw ?? ""}
            onChange={(e) => useStore.getState().setHeaderField("customerNameRaw", e.target.value || null)}
          />
        </label>
        <label>
          Site address
          <input
            type="text"
            value={state.header.siteAddressRaw ?? ""}
            onChange={(e) => useStore.getState().setHeaderField("siteAddressRaw", e.target.value || null)}
          />
        </label>
      </div>

      <div className="eq-qualify-factors">
        {QUALIFICATION_FACTORS.map((factor) => (
          <FactorCard
            key={factor}
            factor={factor}
            title={FACTOR_TITLE[factor]}
            answers={state.answers}
            verdict={state.evaluation?.perFactor.find((f) => f.factor === factor)}
            onAnswer={(value) => driver.answerFactor(factor, value)}
          />
        ))}
      </div>

      {state.evaluation && (
        <div className={`eq-qualify-decision eq-qualify-decision--${state.evaluation.decision}`}>
          <strong>{decisionLabel(state.evaluation.decision)}</strong>
          <ul>
            {state.evaluation.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="eq-qualify-actions">
        <button
          type="button"
          disabled={!supabase || state.status.kind === "saving"}
          onClick={() => driver.saveDraft().catch((e) => setError(e instanceof Error ? e.message : String(e)))}
        >
          Save draft
        </button>
        <button
          type="button"
          className="eq-intake-btn-primary"
          disabled={!supabase || state.status.kind === "saving"}
          onClick={() => driver.decide().catch((e) => setError(e instanceof Error ? e.message : String(e)))}
        >
          Record decision
        </button>
        {state.qualificationId && (
          <button
            type="button"
            disabled={state.status.kind === "saving"}
            onClick={() => driver.archive().catch((e) => setError(e instanceof Error ? e.message : String(e)))}
          >
            Archive
          </button>
        )}
      </div>

      {state.status.kind === "saved" && (
        <p className="eq-qualify-saved">Saved — qualification {state.status.qualificationId} ({state.status.status}).</p>
      )}
    </div>
  );
}

function guessKind(fileName: string): "contract" | "spec" | "photo" | "other" {
  const lower = fileName.toLowerCase();
  if (lower.includes("contract")) return "contract";
  if (lower.includes("spec")) return "spec";
  if (/\.(jpe?g|png|heic|webp)$/.test(lower)) return "photo";
  return "other";
}

function decisionLabel(decision: string): string {
  if (decision === "price") return "Price it — proceed with estimating.";
  if (decision === "walk") return "Walk — do not spend estimating hours on this.";
  return "Needs review — a human call is required before proceeding.";
}

// ============================================================================
// Per-factor Q&A card. Each factor has its own specific sub-fields (see
// remedial-tender-qualify/types.ts) — kept as explicit small forms rather
// than a generic schema-driven renderer, matching this pack's "fast path for
// the demo" scope.
// ============================================================================

function FactorCard({
  factor,
  title,
  answers,
  verdict,
  onAnswer,
}: {
  factor: QualificationFactor;
  title: string;
  answers: QualificationAnswers;
  verdict?: { verdict: string; reason: string };
  onAnswer: (value: QualificationAnswers[typeof factor]["value"]) => void;
}): JSX.Element {
  const current = answers[factor];

  return (
    <fieldset className="eq-qualify-factor">
      <legend>
        {title}
        {verdict && (
          <span className={`eq-qualify-badge eq-qualify-badge--${verdict.verdict}`}>
            {VERDICT_LABEL[verdict.verdict] ?? verdict.verdict}
          </span>
        )}
      </legend>
      {verdict && <p className="eq-qualify-factor-reason">{verdict.reason}</p>}

      {factor === "client" && (
        <ClientFields value={current.value as QualificationAnswers["client"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["client"]["value"]) => void} />
      )}
      {factor === "scope" && (
        <ScopeFields value={current.value as QualificationAnswers["scope"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["scope"]["value"]) => void} />
      )}
      {factor === "margin" && (
        <MarginFields value={current.value as QualificationAnswers["margin"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["margin"]["value"]) => void} />
      )}
      {factor === "cash_flow" && (
        <CashFlowFields value={current.value as QualificationAnswers["cash_flow"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["cash_flow"]["value"]) => void} />
      )}
      {factor === "contract" && (
        <ContractFields value={current.value as QualificationAnswers["contract"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["contract"]["value"]) => void} />
      )}
      {factor === "program" && (
        <ProgramFields value={current.value as QualificationAnswers["program"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["program"]["value"]) => void} />
      )}
      {factor === "technical" && (
        <TechnicalFields value={current.value as QualificationAnswers["technical"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["technical"]["value"]) => void} />
      )}
      {factor === "location" && (
        <LocationFields value={current.value as QualificationAnswers["location"]["value"]} onAnswer={onAnswer as (v: QualificationAnswers["location"]["value"]) => void} />
      )}
    </fieldset>
  );
}

function TriBool({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}): JSX.Element {
  return (
    <label className="eq-qualify-tribool">
      {label}
      <select
        value={value === null ? "unknown" : String(value)}
        onChange={(e) => onChange(e.target.value === "unknown" ? null : e.target.value === "true")}
      >
        <option value="unknown">Unknown</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </label>
  );
}

function ClientFields({ value, onAnswer }: { value: QualificationAnswers["client"]["value"]; onAnswer: (v: QualificationAnswers["client"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Known, reputable client?" value={value.knownReputableClient} onChange={(v) => onAnswer({ ...value, knownReputableClient: v })} />
      <TriBool label="Any payment history issue?" value={value.paymentHistoryIssue} onChange={(v) => onAnswer({ ...value, paymentHistoryIssue: v })} />
      <TriBool label="Decision-maker clear?" value={value.decisionMakerClear} onChange={(v) => onAnswer({ ...value, decisionMakerClear: v })} />
      <label>
        Principal type
        <input type="text" value={value.principalType ?? ""} onChange={(e) => onAnswer({ ...value, principalType: e.target.value || null })} />
      </label>
    </>
  );
}

function ScopeFields({ value, onAnswer }: { value: QualificationAnswers["scope"]["value"]; onAnswer: (v: QualificationAnswers["scope"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Scope investigated and defined?" value={value.scopeInvestigatedAndDefined} onChange={(v) => onAnswer({ ...value, scopeInvestigatedAndDefined: v })} />
      <label>
        Major unknowns (count)
        <input
          type="number"
          min={0}
          value={value.majorUnknownsCount ?? ""}
          onChange={(e) => onAnswer({ ...value, majorUnknownsCount: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
    </>
  );
}

function MarginFields({ value, onAnswer }: { value: QualificationAnswers["margin"]["value"]; onAnswer: (v: QualificationAnswers["margin"]["value"]) => void }): JSX.Element {
  return (
    <>
      <label>
        Estimated margin %
        <input
          type="number"
          step="0.1"
          value={value.marginEstimatePct ?? ""}
          onChange={(e) => onAnswer({ ...value, marginEstimatePct: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
      <TriBool label="Relies on optimistic variations?" value={value.reliesOnOptimisticVariations} onChange={(v) => onAnswer({ ...value, reliesOnOptimisticVariations: v })} />
    </>
  );
}

function CashFlowFields({ value, onAnswer }: { value: QualificationAnswers["cash_flow"]["value"]; onAnswer: (v: QualificationAnswers["cash_flow"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Claims fund delivery?" value={value.claimsFundDelivery} onChange={(v) => onAnswer({ ...value, claimsFundDelivery: v })} />
      <label>
        Unfunded upfront exposure ($)
        <input
          type="number"
          min={0}
          value={value.unfundedUpfrontExposure ?? ""}
          onChange={(e) => onAnswer({ ...value, unfundedUpfrontExposure: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
    </>
  );
}

function ContractFields({ value, onAnswer }: { value: QualificationAnswers["contract"]["value"]; onAnswer: (v: QualificationAnswers["contract"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Liability capped?" value={value.liabilityCapped} onChange={(v) => onAnswer({ ...value, liabilityCapped: v })} />
      <TriBool label="Disproportionate liability?" value={value.disproportionateLiability} onChange={(v) => onAnswer({ ...value, disproportionateLiability: v })} />
    </>
  );
}

function ProgramFields({ value, onAnswer }: { value: QualificationAnswers["program"]["value"]; onAnswer: (v: QualificationAnswers["program"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Program achievable?" value={value.programAchievable} onChange={(v) => onAnswer({ ...value, programAchievable: v })} />
      <TriBool label="Penalty-heavy / compressed?" value={value.penaltyHeavyOrCompressed} onChange={(v) => onAnswer({ ...value, penaltyHeavyOrCompressed: v })} />
    </>
  );
}

function TechnicalFields({ value, onAnswer }: { value: QualificationAnswers["technical"]["value"]; onAnswer: (v: QualificationAnswers["technical"]["value"]) => void }): JSX.Element {
  return (
    <>
      <TriBool label="Proven capability?" value={value.provenCapability} onChange={(v) => onAnswer({ ...value, provenCapability: v })} />
      <TriBool label="Uncontrolled design/structural risk?" value={value.uncontrolledDesignOrStructuralRisk} onChange={(v) => onAnswer({ ...value, uncontrolledDesignOrStructuralRisk: v })} />
    </>
  );
}

function LocationFields({ value, onAnswer }: { value: QualificationAnswers["location"]["value"]; onAnswer: (v: QualificationAnswers["location"]["value"]) => void }): JSX.Element {
  return (
    <>
      <label>
        Region
        <input type="text" value={value.region ?? ""} onChange={(e) => onAnswer({ ...value, region: e.target.value || null })} />
      </label>
      <TriBool label="Travel/supervision burden high?" value={value.travelOrSupervisionBurdenHigh} onChange={(v) => onAnswer({ ...value, travelOrSupervisionBurdenHigh: v })} />
    </>
  );
}
