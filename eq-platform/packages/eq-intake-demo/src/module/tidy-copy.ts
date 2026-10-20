/**
 * The words the old Tidy tabs use, in plain English. Each quick fix says why it is being made;
 * nothing here changes what the fixes do.
 */

export interface FixLike {
  fix_type: string;
  old_value: string | null;
  new_value: string | null;
}

const squash = (v: string | null): string => (v ?? "").toLowerCase().replace(/[\s_-]+/g, "");

/** One sentence on why this value is being changed. */
export function fixReason(f: FixLike): string {
  switch (f.fix_type) {
    case "phone": return "Phone number set out the standard Australian way";
    case "au_state": return "State written in its short form, like NSW";
    case "email": return "Email put in lower case";
    case "abn": return "ABN set out in the standard groups of digits";
    case "date": return "Date written in one standard form";
    case "boolean": return "Yes or no written the standard way";
    default: break;
  }
  const oldV = f.old_value ?? "";
  const newV = f.new_value ?? "";
  if (oldV.trim() === newV.trim() && oldV !== newV) return "Extra spaces removed";
  if (squash(oldV) === squash(newV)) return "Only the capital letters or spacing change, not the meaning";
  return "Written the way the template expects";
}

export const TIDY_WORDS = {
  fixesTitle: "Quick fixes",
  fixesHint: "Small changes to how things are written. Each line shows what it says now, what it will say, and why. Tick the ones you want, then press Apply. Nothing changes until you do.",
  gapsTitle: "Missing details",
  gapsHint: "Details that are blank or don't look right. Fill them in one at a time below, fill one detail in for several records at once, or download this list to fix in a spreadsheet and bring it back on the Reconcile tab.",
  reviewTitle: "Worth a look",
  reviewHint: "These need a person to decide. They can't be fixed automatically.",
  allGood: "All good",
  scanning: "Checking your records…",
  failed: "Couldn't check your records:",
} as const;

export const FIX_HEADERS = { who: "Who or what", what: "Detail", now: "Says now", will: "Will say", why: "Why" } as const;

export const GAP_KIND: Record<string, string> = {
  required_missing: "Missing",
  format_invalid: "Doesn't look right",
  fk_no_match: "Points at nothing",
};

export const FLAG_KIND: Record<string, string> = {
  phone_kept_raw: "Phone left as typed",
  date_ambiguous: "Date can be read two ways",
  value_unusual: "Looks unusual",
  cross_field_warning: "Doesn't match another detail",
};

/** What the small note beside a record count says about the ones left out of it. */
export function hiddenNote(entity: string, n: number): string {
  if (entity === "staff") return `${n} who have left hidden`;
  if (entity === "sites") return `${n} merged hidden`;
  return `${n} inactive hidden`;
}

export function hiddenNoteTitle(entity: string): string {
  if (entity === "staff") return "People who have left. Not counted or checked for missing details.";
  if (entity === "sites") return "Merged into another record, so not counted or checked for duplicates";
  return "Marked inactive, so not counted or checked for missing details";
}

export const plainCounts = {
  fixes: (n: number): string => `${n.toLocaleString()} quick ${n === 1 ? "fix" : "fixes"}`,
  gaps: (n: number): string => `${n.toLocaleString()} missing ${n === 1 ? "detail" : "details"}`,
  review: (n: number): string => `${n.toLocaleString()} to look at`,
  notScanned: (n: number): string => `${n.toLocaleString()} not checked`,
};
