/**
 * Qualify-flow store — Zustand state machine for the go/no-go screening pack
 * (plan §C.1). Same structural style as @eq/confirm-ui's createConfirmFlow
 * (a factory returning a headless store + an async driver class), built
 * fresh rather than reusing that machine directly — see qualify-types.ts's
 * header comment for why the spreadsheet-shaped confirm_sheet/confirm_rows
 * phases don't fit a single Q&A-driven decision.
 *
 * Single createQualifyFlow() factory so each consumer instance gets its own
 * store. The store is headless — React components subscribe to slices and
 * call actions; the driver coordinates extract -> answer -> save.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  assembleQualification,
  buildQualificationCandidate,
  DEFAULT_QUALIFICATION_CONFIG,
  emptyQualificationAnswers,
  evaluateQualification,
} from "@eq/intake/remedial-tender-qualify";
import type {
  AssembleQualificationResult,
  QualificationAnswers,
  QualificationConfig,
  QualificationFactor,
  QualificationHeader,
} from "@eq/intake/remedial-tender-qualify";
import type { QualifyFlowConfig, QualifyFlowState } from "./qualify-types.js";

const EMPTY_HEADER: QualificationHeader = {
  customerNameRaw: null,
  contactRaw: null,
  siteAddressRaw: null,
  scopeSummary: null,
  contractValueEstimate: null,
};

export function createQualifyFlow(): {
  useStore: UseBoundStore<StoreApi<QualifyFlowState>>;
  driver: QualifyFlowDriver;
} {
  const useStore = create<QualifyFlowState>((set, get) => ({
    status: { kind: "idle" },
    files: [],
    header: EMPTY_HEADER,
    answers: emptyQualificationAnswers(),
    sourceFiles: [],
    warnings: [],

    setFiles: (files) => set({ files }),
    setHeaderField: (field, value) => set((s) => ({ header: { ...s.header, [field]: value } })),
    setAnswer: (factor, value, notes) => {
      const current = get().answers[factor];
      set((s) => ({
        answers: {
          ...s.answers,
          [factor]: { value, confidence: null, source: "manual", notes: notes ?? current?.notes ?? null },
        },
      }));
    },
    setEvaluation: (evaluation) => set({ evaluation }),
    setStatus: (status) => set({ status }),
    applyAssembled: (result: AssembleQualificationResult) =>
      set({
        header: result.header,
        answers: result.answers,
        evaluation: result.evaluation,
        sourceFiles: result.sourceFiles,
        warnings: result.warnings,
      }),
    reset: () =>
      set({
        status: { kind: "idle" },
        files: [],
        qualificationId: undefined,
        header: EMPTY_HEADER,
        answers: emptyQualificationAnswers(),
        evaluation: undefined,
        sourceFiles: [],
        warnings: [],
      }),
  }));

  const driver = new QualifyFlowDriverImpl(useStore);
  return { useStore, driver };
}

export interface QualifyFlowDriver {
  configure(config: QualifyFlowConfig): void;
  /** Drop a tender bundle and run vision extraction over it. No-op (moves straight to "answering") if no files were staged. */
  extract(): Promise<void>;
  /**
   * Answer one factor by hand and re-evaluate immediately, using the tenant
   * thresholds passed to configure() — the decision + reasoning trail update
   * live as each question is answered. Manual always wins over whatever
   * extraction produced for that factor (matches risk_answers.source).
   */
  answerFactor<F extends QualificationFactor>(
    factor: F,
    value: QualificationAnswers[F]["value"],
    notes?: string | null,
  ): void;
  /** Save progress without requiring every factor to have cleared — status stays 'draft'. */
  saveDraft(): Promise<void>;
  /** Finalise — commits with status='decided' and the current evaluation's decision + full reasoning trail. */
  decide(): Promise<void>;
  /** The only form of rollback — a plain status update to 'archived' on the existing row, per the plan's C.1 note. Requires a prior save (qualificationId set). */
  archive(): Promise<void>;
}

class QualifyFlowDriverImpl implements QualifyFlowDriver {
  private config?: QualifyFlowConfig;
  private useStore: UseBoundStore<StoreApi<QualifyFlowState>>;

  constructor(useStore: UseBoundStore<StoreApi<QualifyFlowState>>) {
    this.useStore = useStore;
  }

  configure(config: QualifyFlowConfig): void {
    this.config = config;
    this.useStore.getState().reset();
  }

  private resolvedConfig(): QualificationConfig {
    return { ...DEFAULT_QUALIFICATION_CONFIG, ...this.config?.qualificationConfig };
  }

  answerFactor<F extends QualificationFactor>(
    factor: F,
    value: QualificationAnswers[F]["value"],
    notes?: string | null,
  ): void {
    const store = this.useStore.getState();
    store.setAnswer(factor, value, notes);
    const evaluation = evaluateQualification(this.useStore.getState().answers, this.resolvedConfig());
    store.setEvaluation(evaluation);
  }

  async extract(): Promise<void> {
    const store = this.useStore.getState();
    if (!this.config) throw new Error("extract() called before configure().");

    store.setStatus({ kind: "extracting" });
    try {
      const result = await assembleQualification({
        files: store.files,
        ai: this.config.ai,
        config: this.config.qualificationConfig,
        manualAnswers: onlyManual(store.answers),
        manualHeader: store.header,
      });
      store.applyAssembled(result);
      store.setStatus({ kind: "answering" });
    } catch (e) {
      store.setStatus({ kind: "error", error: errString(e), phase: "extracting" });
      throw e;
    }
  }

  async saveDraft(): Promise<void> {
    await this.save("draft");
  }

  async decide(): Promise<void> {
    await this.save("decided");
  }

  async archive(): Promise<void> {
    const store = this.useStore.getState();
    if (!store.qualificationId) {
      throw new Error("archive() called before this qualification was ever saved — nothing to archive.");
    }
    await this.save("archived");
  }

  private async save(status: "draft" | "decided" | "archived"): Promise<void> {
    const store = this.useStore.getState();
    if (!this.config) throw new Error("save() called before configure().");

    // A fresh evaluation right before saving, never a stale one from before
    // the last answer — cheap (pure + synchronous) so there's no reason to
    // risk persisting a decision that doesn't match the current answers.
    const evaluation = evaluateQualification(store.answers, this.resolvedConfig());
    const candidate = buildQualificationCandidate(store.header, store.answers, evaluation, store.sourceFiles, status);

    store.setStatus({ kind: "saving" });
    try {
      const result = await this.config.commit({
        ...candidate,
        qualification_id: store.qualificationId,
      });
      this.useStore.setState({ qualificationId: result.qualification_id, evaluation });
      store.setStatus({ kind: "saved", qualificationId: result.qualification_id, status });
    } catch (e) {
      store.setStatus({ kind: "error", error: errString(e), phase: "saving" });
      throw e;
    }
  }
}

/** Strip source==='extracted' entries so a re-run of extract() (e.g. dropping a revised contract) never lets a stale vision answer masquerade as the caller's own manual input. */
function onlyManual(answers: QualificationAnswers): Partial<QualificationAnswers> {
  const out: Partial<QualificationAnswers> = {};
  for (const factor of Object.keys(answers) as QualificationFactor[]) {
    if (answers[factor].source === "manual") {
      // TS can't prove the two union-indexed accesses narrow to the same
      // member here even though `factor` is shared — a well-known limitation
      // (writing back a value read from the same mapped-union key). Verified
      // correct by remedial-tender-qualify.test.ts's assembleQualification
      // coverage.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[factor] = answers[factor];
    }
  }
  return out;
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
