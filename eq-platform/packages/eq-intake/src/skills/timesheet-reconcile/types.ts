/**
 * Timesheet reconcile — types.
 *
 * Read-only: extract weekly timesheets from a payroll-portal PDF and compare
 * every line with a snapshot of what the app (EQ Field) already holds. Nothing
 * here writes anywhere. Rules for how pay types map to app data are config
 * (`ReconcileConfig`), not code.
 */

export interface Allowance {
  qty: number;
  name: string;
}

export interface ExtractedEntry {
  /** ISO date (YYYY-MM-DD), resolved from the week-ending date. */
  date: string;
  /** Pay-type label exactly as printed, e.g. "Base Hourly". */
  payType: string;
  start: string | null;
  finish: string | null;
  breaksMin: number | null;
  hours: number;
  /** "Note 3" etc. as printed in the Notes column. */
  noteRef: string | null;
  /** Job text from the Notes page, e.g. "27798 MP1 uplift". */
  noteText: string | null;
  allowances: Allowance[];
}

export interface ExtractedTimesheet {
  personName: string;
  /** ISO date of the week-ending (Sunday) printed on the document. */
  weekEnding: string;
  award: string;
  /** e.g. "Pending Approval", "Not Opened". Empty string if none printed. */
  status: string;
  entries: ExtractedEntry[];
  /** The lone "NN.NN hr" line under the day grid, or null if absent. */
  printedTotal: number | null;
  /** 1-based page numbers the document spans. */
  pages: number[];
  warnings: string[];
}

// ---- Field snapshot (what the app already holds) --------------------------

export interface SnapshotPerson {
  id: string;
  name: string;
}
export interface SnapshotTimesheet {
  staffId: string;
  date: string;
  hours: number;
  task: string;
}
export interface SnapshotRoster {
  personId: string;
  date: string;
  task: string | null;
  leaveType: string | null;
}
export interface SnapshotLeave {
  staffId: string | null;
  requesterName: string | null;
  leaveType: string;
  dateStart: string;
  dateEnd: string;
  hoursRequested: number | null;
  status: string;
}
export interface FieldSnapshot {
  people: SnapshotPerson[];
  timesheets: SnapshotTimesheet[];
  roster: SnapshotRoster[];
  leave: SnapshotLeave[];
}

// ---- Config ---------------------------------------------------------------

export type PayTypeKind = "job" | "roster-tafe" | "leave" | "code";

export interface PayTypeRule {
  /** Case-insensitive regex source tested against the printed pay type. */
  match: string;
  kind: PayTypeKind;
  /** leave: leave type ("annual"); code: the literal timesheet task ("NECA"). */
  value?: string;
}

export interface ReconcileConfig {
  payTypeRules: PayTypeRule[];
  /** Regex source; group 1 (or whole match) is the job code in the note text. */
  jobCodePattern: string;
  hoursTolerance: number;
  /** Roster task / leave_type values (lower-case) that mean TAFE. */
  tafeTaskValues: string[];
  /** Document statuses (case-insensitive) that are reconciled; others are listed as skipped. */
  includeStatuses: string[];
  /** leave_requests statuses that count as authoritative. */
  approvedLeaveStatuses: string[];
  /** leave_requests statuses on file but not yet approved: reported as `pending-leave`. */
  pendingLeaveStatuses: string[];
  /**
   * Time signatures that identify a TAFE day when the pay type does not say so
   * (e.g. TAFE keyed as "Base Hourly" with no note). Only used with no note and,
   * for a match, corroborated by the roster.
   */
  tafeSignatures: { start: string; finish: string; breaksMin?: number }[];
}

export const DEFAULT_CONFIG: ReconcileConfig = {
  payTypeRules: [
    { match: "^base hourly", kind: "job" },
    { match: "college|tafe|block release", kind: "roster-tafe" },
    { match: "annual leave", kind: "leave", value: "annual" },
    { match: "sick/personal|^sick", kind: "leave", value: "sick" },
    { match: "^rdo", kind: "leave", value: "rdo" },
    { match: "^neca", kind: "code", value: "NECA" },
  ],
  // First run of 4-6 digits in the note text: "27798 MP1 uplift", "Digico - 28622".
  jobCodePattern: "(?:^|\\D)(\\d{4,6})(?:\\D|$)",
  hoursTolerance: 0.01,
  tafeTaskValues: ["tafe"],
  includeStatuses: ["pending approval", "approved", "submitted"],
  approvedLeaveStatuses: ["approved"],
  pendingLeaveStatuses: ["pending"],
  tafeSignatures: [{ start: "7:30am", finish: "4:00pm", breaksMin: 30 }],
};

// ---- Result ---------------------------------------------------------------

export type Verdict =
  | "match"
  | "missing-in-app"
  | "hours-differ"
  | "conflict"
  | "pending-leave"
  | "unknown-pay-type"
  | "app-only";

export interface LineResult {
  person: string;
  date: string;
  payType: string;
  kind: PayTypeKind | "unknown";
  /** Job code, TAFE, leave type or literal code compared. */
  key: string | null;
  pdfHours: number | null;
  appHours: number | null;
  verdict: Verdict;
  detail: string;
  /** True when a rule could not decide and a human (or a later AI step) should look. */
  ambiguous?: boolean;
}

export interface DocumentCheck {
  person: string;
  weekEnding: string;
  status: string;
  printedTotal: number | null;
  summedEntries: number;
  totalsAgree: boolean | null;
}

export interface SkippedDocument {
  person: string;
  weekEnding: string;
  status: string;
  reason: string;
}

export interface ReconcileReport {
  lines: LineResult[];
  documents: DocumentCheck[];
  skipped: SkippedDocument[];
  /** Snapshot people with app hours in the window but no reconciled document. */
  noFile: { person: string; weekEnding: string; appHours: number }[];
  /** PDF documents whose person was not found in the snapshot. */
  unmatchedPeople: string[];
  /** Entries whose printed hours differ from finish - start - break. Empty when the portal is self-consistent. */
  /** Per person-day: total hours on the document vs total hours the app holds (roster/leave matches count as the document's hours). */
  dayTotals: { person: string; date: string; pdfHours: number; appHours: number; agree: boolean }[];
  hoursArithmetic: { person: string; date: string; payType: string; printed: number; computed: number }[];
  counts: Record<Verdict, number>;
}
