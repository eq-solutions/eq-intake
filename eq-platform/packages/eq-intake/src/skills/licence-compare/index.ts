/**
 * Licence compare skill: read-only prototype.
 *
 * Compares a staff licence list (a file someone is about to enter) against a
 * SNAPSHOT of the worker's own record (jvkn public.licences) and reports what
 * already matches, what differs and what is missing. It proposes nothing to a
 * system and writes nothing: the report is for a person to read before they use
 * Shell "Add licence". See docs/worker-record-reconciliation-role-DRAFT.md.
 *
 * No database connection lives here. The snapshot is a JSON file a person with
 * read access exports (scripts/licence-snapshot.sql). Not exported from the
 * package index.
 */

export interface FileLicenceRow {
  /** 1-based data row number in the source file, for the report. */
  rowNumber: number;
  email: string;
  licenceType: string;
  licenceNumber: string;
  /** ISO date, or "" when the file has none / it could not be read. */
  expiryDate: string;
  neverExpires: boolean;
}

export interface SnapshotWorker {
  userId: string;
  email: string;
}

export interface SnapshotLicence {
  id: string;
  userId: string;
  licenceType: string;
  licenceNumber: string;
  expiryDate: string;
  neverExpires: boolean;
}

export interface JvknSnapshot {
  workers: SnapshotWorker[];
  licences: SnapshotLicence[];
}

export type Verdict =
  | "match"
  | "expiry_differs"
  | "missing_in_jvkn"
  | "person_not_found"
  | "ambiguous"
  | "duplicate_in_file"
  | "unreadable";

export interface CompareLine {
  rowNumber: number;
  email: string;
  licenceType: string;
  verdict: Verdict;
  fileExpiry: string;
  jvknExpiry: string;
  jvknLicenceId: string;
  detail: string;
}

export interface CompareReport {
  lines: CompareLine[];
  counts: Record<Verdict, number>;
}

const VERDICTS: Verdict[] = [
  "match",
  "expiry_differs",
  "missing_in_jvkn",
  "person_not_found",
  "ambiguous",
  "duplicate_in_file",
  "unreadable",
];

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normaliseType(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normaliseNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** ISO yyyy-mm-dd, or d/m/yyyy (Australian order). "" when unreadable. */
export function normaliseDate(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (hit) {
    y = +hit[1]!;
    m = +hit[2]!;
    d = +hit[3]!;
  } else {
    hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!hit) return "";
    d = +hit[1]!;
    m = +hit[2]!;
    y = +hit[3]!;
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return "";
  return dt.toISOString().slice(0, 10);
}

const HEADER_ALIASES: Record<"email" | "licenceType" | "licenceNumber" | "expiry", string[]> = {
  email: ["email", "emailaddress", "workemail", "staffemail"],
  licenceType: ["licencetype", "licensetype", "licence", "license", "ticket", "tickettype", "credential", "type"],
  licenceNumber: ["licencenumber", "licensenumber", "licenceno", "licenseno", "number", "cardnumber", "ticketnumber"],
  expiry: ["expiry", "expirydate", "expires", "expirydt", "expirationdate", "validuntil"],
};

function pick(row: Record<string, unknown>, field: keyof typeof HEADER_ALIASES): string {
  for (const key of Object.keys(row)) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (HEADER_ALIASES[field].includes(k)) {
      const v = row[key];
      return v == null ? "" : String(v).trim();
    }
  }
  return "";
}

/** Turn parsed CSV rows (header -> value) into compare rows. */
export function rowsFromSheet(rows: Record<string, unknown>[]): FileLicenceRow[] {
  return rows.map((r, i) => {
    const expiryRaw = pick(r, "expiry");
    const never = /^(never|n\/?a|none|no expiry|nil)$/i.test(expiryRaw);
    return {
      rowNumber: i + 1,
      email: normaliseEmail(pick(r, "email")),
      licenceType: pick(r, "licenceType"),
      licenceNumber: pick(r, "licenceNumber"),
      expiryDate: never ? "" : normaliseDate(expiryRaw),
      neverExpires: never,
    };
  });
}

function emptyCounts(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
}

export function compareLicences(rows: FileLicenceRow[], snapshot: JvknSnapshot): CompareReport {
  const userByEmail = new Map<string, string[]>();
  for (const w of snapshot.workers) {
    const e = normaliseEmail(w.email);
    if (!e) continue;
    userByEmail.set(e, [...(userByEmail.get(e) ?? []), w.userId]);
  }
  const licencesByUser = new Map<string, SnapshotLicence[]>();
  for (const l of snapshot.licences) licencesByUser.set(l.userId, [...(licencesByUser.get(l.userId) ?? []), l]);

  const seen = new Set<string>();
  const lines: CompareLine[] = [];

  for (const r of rows) {
    const base = {
      rowNumber: r.rowNumber,
      email: r.email,
      licenceType: r.licenceType,
      fileExpiry: r.neverExpires ? "never" : r.expiryDate,
      jvknExpiry: "",
      jvknLicenceId: "",
    };
    const line = (verdict: Verdict, detail: string, extra: Partial<CompareLine> = {}): void => {
      lines.push({ ...base, verdict, detail, ...extra });
    };

    if (!r.email || !normaliseType(r.licenceType)) {
      line("unreadable", "row has no email or no licence type");
      continue;
    }

    const key = `${r.email}|${normaliseType(r.licenceType)}|${normaliseNumber(r.licenceNumber)}`;
    if (seen.has(key)) {
      line("duplicate_in_file", "same person, licence type and number appear earlier in the file");
      continue;
    }
    seen.add(key);

    const users = userByEmail.get(r.email) ?? [];
    if (users.length === 0) {
      line("person_not_found", "no worker with this email in the snapshot");
      continue;
    }
    if (users.length > 1) {
      line("ambiguous", "more than one worker has this email in the snapshot");
      continue;
    }

    const sameType = (licencesByUser.get(users[0]!) ?? []).filter(
      (l) => normaliseType(l.licenceType) === normaliseType(r.licenceType),
    );
    const wantNumber = normaliseNumber(r.licenceNumber);
    const candidates = wantNumber
      ? sameType.filter((l) => normaliseNumber(l.licenceNumber) === wantNumber)
      : sameType;

    if (candidates.length === 0) {
      line(
        "missing_in_jvkn",
        sameType.length > 0
          ? "worker has this licence type but with a different number"
          : "worker has no licence of this type",
      );
      continue;
    }
    if (candidates.length > 1) {
      line("ambiguous", "more than one licence of this type matches; add the number to the file");
      continue;
    }

    const l = candidates[0]!;
    const jvknExpiry = l.neverExpires ? "never" : l.expiryDate;
    const found = { jvknExpiry, jvknLicenceId: l.id };
    // A blank expiry in the file cannot disagree with anything.
    const fileHasExpiry = r.neverExpires || r.expiryDate !== "";
    if (!fileHasExpiry || base.fileExpiry === jvknExpiry) {
      line("match", fileHasExpiry ? "type, number and expiry agree" : "found; file has no expiry to compare", found);
    } else {
      line("expiry_differs", "found, but the expiry dates are different", found);
    }
  }

  const counts = emptyCounts();
  for (const l of lines) counts[l.verdict]++;
  return { lines, counts };
}
