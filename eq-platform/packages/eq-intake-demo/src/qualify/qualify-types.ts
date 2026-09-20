/**
 * State-machine types for the go/no-go qualify flow (plan §C.1).
 *
 * Deliberately NOT built on @eq/confirm-ui's createConfirmFlow — that state
 * machine's phases (confirm_sheet / mapping / confirm_rows) are shaped for
 * spreadsheet row-mapping, which doesn't fit a single Q&A-driven decision
 * with no rows at all. This mirrors createConfirmFlow's STRUCTURAL style
 * (a factory returning a headless Zustand store + an async driver class)
 * without forcing the spreadsheet-shaped phases onto a different problem.
 *
 * The flow:
 *   idle -> extracting (vision, if a bundle was dropped) -> answering
 *   (Q&A over whichever factors came back needs_review, re-evaluating live
 *   as each answer lands) -> saving -> saved
 *
 * "answering" has no hard exit condition — the estimator can save a draft at
 * any point (saveDraft) or finalise once every factor has cleared one way or
 * another (decide). There's no confirm_rows-style gate here: a decision with
 * open needs_review factors is still a legitimate decision (the matrix
 * itself resolves that to an overall "needs_review" outcome), it just isn't
 * "price" or "walk" yet.
 */
import type {
  AssembleQualificationResult,
  QualificationAnswers,
  QualificationConfig,
  QualificationEvaluation,
  QualificationFactor,
  QualificationHeader,
  SkillFileInput,
  SkillWarning,
  SourceFileRef,
  TenderQualificationCandidate,
} from "@eq/intake/remedial-tender-qualify";

export type QualifyFlowStatus =
  | { kind: "idle" }
  | { kind: "extracting" }
  | { kind: "answering" }
  | { kind: "saving" }
  | { kind: "saved"; qualificationId: string; status: "draft" | "decided" | "archived" }
  | { kind: "error"; error: string; phase: string };

/** What the commit RPC hands back — mirrors eq_intake_commit_qualification's `RETURNS jsonb` (to_jsonb(the row)). */
export interface CommitQualificationResult {
  qualification_id: string;
  [key: string]: unknown;
}

export type CommitQualificationFn = (
  payload: TenderQualificationCandidate & { qualification_id?: string },
) => Promise<CommitQualificationResult>;

export interface QualifyFlowConfig {
  tenantId: string;
  /**
   * AI provider for vision extraction. In a real embed (eq-shell, a real
   * tenant), file bytes should go to a BACKGROUND function endpoint, not
   * straight to an AIProvider instantiated in the browser with a real key —
   * see the skill's extract.ts header comment (the maximo-pdf-wo lesson: a
   * sync function hits Netlify's 26s cap on a multi-document bundle). The
   * standalone demo passes a mock/local provider or omits this entirely and
   * relies on manual answers only, same as Cards' own on-device pipeline
   * pattern for the "client-side extraction" alternative.
   */
  ai?: import("@eq/ai").AIProvider;
  /** Tenant-configured go/no-go thresholds. Falls back to DEFAULT_QUALIFICATION_CONFIG for anything omitted. */
  qualificationConfig?: Partial<QualificationConfig>;
  /** Wired to eq_intake_commit_qualification by the host. */
  commit: CommitQualificationFn;
}

export interface QualifyFlowState {
  status: QualifyFlowStatus;
  files: SkillFileInput[];
  qualificationId?: string;
  header: QualificationHeader;
  answers: QualificationAnswers;
  evaluation?: QualificationEvaluation;
  sourceFiles: SourceFileRef[];
  warnings: SkillWarning[];

  // ---- actions ----
  // Raw setters only — deliberately dumb. Re-evaluating live as an answer
  // lands needs the tenant's QualificationConfig, which only the driver
  // holds (set via configure()), so that orchestration lives on
  // QualifyFlowDriver.answerFactor(), not here. Components should call the
  // driver method, not setAnswer directly, unless they're happy to compute
  // and push their own QualificationEvaluation.
  setFiles: (files: SkillFileInput[]) => void;
  setHeaderField: <K extends keyof QualificationHeader>(field: K, value: QualificationHeader[K]) => void;
  setAnswer: <F extends QualificationFactor>(
    factor: F,
    value: QualificationAnswers[F]["value"],
    notes?: string | null,
  ) => void;
  setEvaluation: (evaluation: QualificationEvaluation) => void;
  setStatus: (status: QualifyFlowStatus) => void;
  applyAssembled: (result: AssembleQualificationResult) => void;
  reset: () => void;
}
