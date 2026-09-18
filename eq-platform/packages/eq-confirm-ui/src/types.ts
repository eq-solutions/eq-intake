/**
 * State-machine types for the confirm flow.
 *
 * The flow:
 *   idle → parsing → [confirm_sheet (multi-sheet XLSX only)] →
 *   classifying → mapping (AI) → confirm_mapping →
 *   validating → confirm_rows → committing → complete
 *
 * Each phase populates a slice of the store. Going back from any confirm
 * state re-runs from the appropriate phase forward — validation is cached
 * by file hash so re-confirm is instant.
 *
 * confirm_sheet only shows up when the parser returns more than one sheet
 * (real SimPRO exports have 5 tabs). For single-sheet inputs the driver
 * skips straight from parsing to classifying.
 */

import type {
  ValidationResult,
  ValidationError,
  Flag,
  TransformSpec,
} from "@eq/validation";
import type { ParsedSheet, ClassifyResult } from "@eq/intake";
import type { MapResult, AIProvider } from "@eq/ai";

/** Where the user is in the flow. */
export type FlowStatus =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "confirm_sheet" }
  | { kind: "classifying" }
  | { kind: "mapping" }
  | { kind: "confirm_mapping" }
  | { kind: "validating" }
  | { kind: "confirm_rows" }
  | { kind: "committing"; committed: number; total: number }
  | { kind: "complete"; committed: number; flagged: number; rejected: number }
  | { kind: "error"; error: string; phase: string };

/** Resolution to apply to a flagged row before commit. */
export type FlagResolution =
  | { kind: "accept_canonical" } // commit as-is (e.g. accept fuzzy match)
  | { kind: "pick_candidate"; flagKind: Flag["kind"]; chosen: string } // pick from candidates
  | { kind: "set_value"; field: string; value: unknown } // override a value
  | { kind: "set_fields"; values: Record<string, unknown> } // set several fields (e.g. accepted AI suggestions)
  | { kind: "skip_row" } // drop this row from the commit
  | { kind: "create_missing_fk"; field: string; newName: string } // create-new flow
  | { kind: "split_row"; field: string; values: string[] }; // confirmed multi_value_candidate: fan this row into one record per value

/** Commit function signature — caller wires this to their Supabase RPC. */
export type CommitFn = (rows: CommittableRow[]) => Promise<{
  committed: number;
  failed: number;
}>;

export interface CommittableRow {
  source_row_index: number;
  /**
   * Set when this row was produced by fanning one multi-value source row out
   * into several (a confirmed split_row resolution) — 0-based position within
   * that split group. Absent for every ordinary (non-split) row.
   */
  split_index?: number;
  canonical: Record<string, unknown>;
}

/**
 * Inputs the consumer hands to the flow when they wire it up.
 */
export interface FlowConfig {
  /** Target JSON schema for the canonical entity. */
  schema: Record<string, unknown>;
  /** Tenant ID for FK lookups + audit. */
  tenantId: string;
  /** AI provider for column mapping + classification. Optional but recommended. */
  ai?: AIProvider;
  /** FK lookup function for resolveFk. Optional — disables FK matching when absent. */
  fkLookup?: import("@eq/validation").FkLookup;
  /** Commit function invoked when the user clicks "commit". */
  commit: CommitFn;
  /** Schemas registry for the classifier. Used when no schema is fixed up-front. */
  schemaRegistry?: Record<string, Record<string, unknown>>;
  /**
   * Whether to run AI enrichment after validation (infer missing
   * asset_type / criticality / ppm_frequency as accept/reject suggestions).
   * Requires `ai.enrich`. Defaults to on when the schema entity is `asset`,
   * off otherwise. Set explicitly to override.
   */
  enableEnrichment?: boolean;
  /** Fields to infer when enrichment runs. Default asset_type/criticality/ppm_frequency. */
  enrichFields?: string[];
  /**
   * Lookup of existing assets for duplicate detection (serial / external_id+site).
   * Host wires this to a Supabase query. When absent, only within-batch
   * duplicates are detected (not against the DB).
   */
  dupLookup?: import("@eq/intake").DupLookup;
}

/**
 * The full store shape. Every field is observable; the React components
 * subscribe to slices via Zustand selectors.
 */
export interface FlowState {
  status: FlowStatus;
  config?: FlowConfig;

  // upload phase
  file?: File | { name: string; bytes: Uint8Array };
  fileHash?: string;

  // parsing phase
  parsedSheet?: ParsedSheet;
  /**
   * All sheets returned by the parser, set when the file produced more than
   * one. Used by SheetPicker; cleared once the user picks one.
   */
  parsedWorkbook?: { sheets: ParsedSheet[] };

  // classification phase
  classification?: ClassifyResult;

  // mapping phase
  aiMapping?: MapResult;
  userOverrides: Record<string, string | null>;
  transformations: Record<string, TransformSpec>;
  clarificationAnswers: Record<string, string>;

  // validation phase
  validationResult?: ValidationResult;

  // confirm_rows phase
  resolutions: Record<number, FlagResolution>;

  /**
   * Where the user is sending this data next. Non-blocking input — the
   * flow does not require it. Captured to build a route map over time:
   * "people drop SimPRO customer CSVs to send to SharePoint" tells us
   * which export profiles are worth building.
   */
  destination?: string;
  /** "suggested" if picked from a chip, "free_text" if typed in. */
  destinationSource?: "suggested" | "free_text";

  // ---- actions ----
  setFile: (file: File | { name: string; bytes: Uint8Array }) => void;
  setStatus: (status: FlowStatus) => void;
  setParsedSheet: (sheet: ParsedSheet) => void;
  setParsedWorkbook: (workbook: { sheets: ParsedSheet[] } | undefined) => void;
  setClassification: (c: ClassifyResult) => void;
  setAiMapping: (m: MapResult) => void;
  setUserOverride: (sourceCol: string, canonicalField: string | null) => void;
  setTransform: (sourceCol: string, spec: TransformSpec) => void;
  answerClarification: (questionId: string, answer: string) => void;
  setValidationResult: (r: ValidationResult) => void;
  resolveFlag: (rowIndex: number, resolution: FlagResolution) => void;
  resolveBulk: (flagKind: Flag["kind"], resolution: FlagResolution) => void;
  /** Bulk-resolve fuzzy/date flags by picking each row's own top candidate. */
  resolveBulkPickTop: (flagKind: Flag["kind"]) => void;
  setDestination: (value: string | undefined, source: "suggested" | "free_text") => void;
  reset: () => void;
}

/**
 * Result of merging user overrides with the AI mapping.
 *   - User-set entries win over AI suggestions.
 *   - Unset source columns are dropped (canonical = null).
 */
export interface EffectiveMapping {
  mapping: Record<string, string | null>;
  transformations: Record<string, TransformSpec>;
}

/** Rows ready to commit after flag resolutions are applied. */
export interface CommitReady {
  /** Rows that were already valid + flagged rows whose resolutions made them committable. */
  committable: CommittableRow[];
  /** Rows the user explicitly skipped. */
  skipped: number[];
  /** Rows rejected at validation that the user can't fix here (need to retry at source). */
  rejected: Array<{
    source_row_index: number;
    errors: ValidationError[];
  }>;
}
