import { useState, useEffect, useCallback, useMemo, type JSX } from "react";
import {
  fetchCanonicalRows,
  runTidyPass,
  commitTidyFixes,
  suggestGaps,
  flagSitePairForMerge,
  getSiteDupeUsage,
  applyFilters,
  getFlaggableFields,
  getFieldTier,
  getFieldEnumValues,
  archiveDuplicateRecord,
  isArchivableDuplicate,
} from "@eq/intake";
import type {
  CanonicalFetchClient,
  TidyFix,
  GapItem,
  ReviewFlag,
  TidyReport,
  TidyCommitResult,
  TidyEntity,
  GapSuggestResult,
  GapSuggestion,
  EdgeFnCaller,
  SiteDupeUsage,
  AskFilter,
  FieldImportanceOverride,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { fieldLabel } from "../shared/entity-label.js";
import { Table, type TableColumn } from "@eq-solutions/ui/Table";

export interface EntityDrillDownProps {
  entity: string;
  /** Full Supabase client — used for row fetching, tidy pass, and fix commits. */
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  /** Which filter tab to open on mount. Defaults to "all". */
  initialMode?: FilterMode;
  /**
   * Filters carried over from an Ask question (see AskCanonical's "Open
   * {entity} →" button) — applied on top of whatever filterMode is active,
   * so the drill-down actually shows the rows that answered the question
   * instead of silently reverting to every row. Clearable in the header.
   */
  initialFilters?: AskFilter[];
  /** Human-readable description of initialFilters, shown in the clearable chip. */
  initialFilterLabel?: string;
  /** Set from a Health Overview "Fix these" card (e.g. "phone") — opens the
   * Tidy tab's gap section straight into the bulk-fill grid for this one
   * field instead of the full mixed gap list. */
  initialGapField?: string | null;
  onBack?: () => void;
  onBulkFix?: (csvBlob: Blob, filename: string) => void;
  /**
   * Whether the caller may flag a Sites duplicate pair for merge review (same
   * role model as IntakeModuleProps.canMergeSites — manager-only). Only used
   * when entity === "sites"; ignored otherwise. The flag RPC is also gated
   * server-side, so this only controls whether the button renders.
   */
  canMergeSites?: boolean;
  /**
   * Whether the caller may edit a record's fields inline, or archive/dismiss
   * a flagged duplicate — eq-shell's intake.edit_canonical (manager/
   * supervisor). Without this, cells stay read-only (no click-to-edit) and
   * the duplicate-row Archive / Not-a-duplicate actions don't render. CSV
   * download and viewing are unaffected — those stay behind the module's own
   * intake.view gate.
   */
  canEditCanonical?: boolean;
  /**
   * Tenant's saved field-importance corrections (from the settings screen).
   * Additive — omit it and gaps/tiers fall back to the code defaults exactly
   * as before. Passed down from IntakeModule, which owns the one fetch.
   */
  fieldImportanceOverrides?: FieldImportanceOverride[];
}

type Row = Record<string, unknown>;
type DrillRow = Row & { _dupeField?: string; _dupeKey?: string };
type FilterMode = "all" | "gaps" | "duplicates" | "tidy";

// Every entity reads from the shared field-importance rulebook (see
// @eq/intake's field-importance.ts) so this list can't quietly disagree
// with the Overview score's gap list again — that drift (this list once
// skipped `trade` and `emergency_contact_name`, which Overview docked
// points for) is what prompted the rulebook. Only critical/important
// fields are pulled in — "optional"-tier fields never show as a gap here.
// Customers/Contacts' `phone` is a coalesced field (mobile_phone OR
// primary/work_phone) — `row.phone` here is already the coalesced value
// from `deriveRow()` below, so a plain blank-check on it is correct as
// long as the rulebook's own `field: 'phone'` entry is what's being read.
//
// A function, not a module-level constant, so a tenant's field-importance
// overrides (fetched once by IntakeModule, passed down as a prop) can shift
// which fields count as a gap without a page reload.
function buildGapFields(overrides?: FieldImportanceOverride[]): Record<string, string[]> {
  return {
    staff: getFlaggableFields("staff", overrides),
    sites: getFlaggableFields("sites", overrides),
    contacts: getFlaggableFields("contacts", overrides),
    customers: getFlaggableFields("customers", overrides),
    assets: getFlaggableFields("assets", overrides),
    licences: getFlaggableFields("licences", overrides),
  };
}

const DUPE_KEYS: Record<string, string[]> = {
  staff: ["email"],
  sites: ["name"],
  contacts: ["email"],
  customers: ["abn", "company_name"],
  assets: ["serial_number"],
  // licences: licence_number legitimately repeats across different staff/states
};

// Entity string used in the UI → TidyEntity used by the tidy pass engine.
const ENTITY_TO_TIDY: Partial<Record<string, TidyEntity>> = {
  customers: "customer",
  sites: "site",
  contacts: "contact",
  staff: "staff",
  assets: "asset",
  licences: "licence",
};

const DISPLAY_COLUMNS: Record<string, string[]> = {
  staff: ["first_name", "last_name", "email", "phone"],
  sites: ["name", "address_line_1", "suburb", "state", "postcode"],
  contacts: ["full_name", "email", "phone"],
  customers: ["company_name", "email", "phone", "abn"],
  assets: ["name", "asset_type", "serial_number"],
  licences: ["licence_number", "licence_type", "expiry_date", "staff_id"],
};

// Some entities are checked/displayed under a field name that has no direct
// DB column (contacts.full_name, contacts/customers.phone) — derived from
// the real columns right after fetch so GAP_FIELDS/DISPLAY_COLUMNS/DUPE_KEYS
// above can reference one canonical key per concept instead of forcing every
// consumer to know which of 2-3 raw columns to coalesce.
function deriveRow(entity: string, row: Row): Row {
  if (entity === "contacts") {
    const first = String(row["first_name"] ?? "").trim();
    const last = String(row["last_name"] ?? "").trim();
    const full_name = `${first} ${last}`.trim();
    const phone = row["mobile_phone"] || row["work_phone"] || null;
    return { ...row, full_name: full_name || null, phone };
  }
  if (entity === "customers") {
    const phone = row["mobile_phone"] || row["primary_phone"] || null;
    return { ...row, phone };
  }
  return row;
}

// Real app_data tables use `<entity>_id`, never a bare `id` column. Row
// identity (dedup, inline-edit targeting, Suggest-accept, Table's React
// key) must key off the real PK — matching on `row.id` silently resolves
// to '' for every row of every real entity, which made every row look
// identical to dedup/edit/accept logic.
const ROW_ID_FIELD: Record<string, string> = {
  staff: "staff_id",
  sites: "site_id",
  contacts: "contact_id",
  customers: "customer_id",
  assets: "asset_id",
  licences: "licence_id",
};

function rowKey(entity: string, row: Row): string {
  const field = ROW_ID_FIELD[entity] ?? "id";
  const v = row[field];
  return v !== null && v !== undefined ? String(v) : "";
}

// Display label for a row when committing a fix — only used for the audit
// trail's row_label column, so a rough best-effort match is fine.
function fallbackRowLabel(row: Row): string {
  const candidates = ["company_name", "full_name", "name", "licence_number", "first_name"];
  for (const c of candidates) {
    const v = row[c];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "record";
}

// A gap row's own row_label is often bare ("Accounts", "Rafael" — a company
// name or first name with nothing else) — this pulls one more identifying
// value from the full row so the Tidy tab's "Record" column isn't a dead
// end for telling two same-labelled rows apart.
function gapContextLine(row: Row | undefined): string | null {
  if (!row) return null;
  const email = row["email"];
  if (typeof email === "string" && email.trim()) return email.trim();
  const phone = row["phone"] ?? row["mobile_phone"] ?? row["work_phone"] ?? row["primary_phone"];
  if (typeof phone === "string" && phone.trim()) return phone.trim();
  const company = row["company_name"];
  if (typeof company === "string" && company.trim()) return company.trim();
  return null;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function rowHasGap(row: Row, gapFields: string[]): boolean {
  return gapFields.some((f) => isBlank(row[f]));
}

function formatLabel(entity: string): string {
  return entity.charAt(0).toUpperCase() + entity.slice(1);
}

function buildCsvContent(rows: Row[], columns: string[]): string {
  const header = columns.map((c) => `"${fieldLabel(c)}"`).join(",");
  const body = rows.map((row) =>
    columns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      })
      .join(","),
  );
  return [header, ...body].join("\r\n");
}

function todayString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface EditState {
  rowId: string;
  field: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export function EntityDrillDown({
  entity,
  supabase,
  tenantId,
  initialMode,
  initialFilters,
  initialFilterLabel,
  initialGapField,
  onBack,
  onBulkFix,
  canMergeSites,
  canEditCanonical,
  fieldImportanceOverrides,
}: EntityDrillDownProps): JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // ── Flag-for-merge state (sites only) ──────────────────────────────────
  const [flagBusy, setFlagBusy] = useState<Record<string, boolean>>({});
  const [flagError, setFlagError] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Record<string, string[]>>({}); // groupKey -> advisoryId[] (one per loser)

  // ── Archive-duplicate state (staff/contacts — the entities eq_archive_
  // duplicate_record supports) ────────────────────────────────────────────
  const [archiveBusy, setArchiveBusy] = useState<Record<string, boolean>>({});
  const [archiveError, setArchiveError] = useState<Record<string, string>>({});

  // ── "Not a duplicate" dismiss state (non-sites entities — Sites already
  // has its own Same/Different/Unsure verdict flow) ──────────────────────
  const [dismissedGroups, setDismissedGroups] = useState<Set<string>>(new Set());
  const [dismissBusy, setDismissBusy] = useState<Record<string, boolean>>({});
  const [dismissError, setDismissError] = useState<Record<string, string>>({});

  // ── Usage counts (sites duplicates only) — decision support for survivor
  // pick. See eq-shell 0187: a fast triage subset of the full merge-preview
  // sweep, deep enough to tell a real site from an empty shell (the SY9 case
  // — the "expected wrong" active row actually held every real record).
  const [usage, setUsage] = useState<Record<string, SiteDupeUsage>>({});
  const [usageLoading, setUsageLoading] = useState(false);

  // Honour initialMode only if the entity supports that mode (e.g. "tidy"
  // needs a tidy entity mapping; fall back to "all" if not).
  const resolvedInitialMode: FilterMode =
    initialMode === "tidy" && !ENTITY_TO_TIDY[entity]
      ? "all"
      : (initialMode ?? "all");

  const [filterMode, setFilterMode] = useState<FilterMode>(resolvedInitialMode);
  const [askFilters, setAskFilters] = useState<AskFilter[] | null>(
    initialFilters && initialFilters.length > 0 ? initialFilters : null,
  );
  const [editState, setEditState] = useState<EditState | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editSaveError, setEditSaveError] = useState<string | null>(null);

  // Tidy pass state
  const [tidyReport, setTidyReport] = useState<TidyReport | null>(null);
  const [tidyLoading, setTidyLoading] = useState(false);
  const [tidyError, setTidyError] = useState<string | null>(null);
  const [tidyProgress, setTidyProgress] = useState("");
  const [selectedFixKeys, setSelectedFixKeys] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<TidyCommitResult | null>(null);

  // Bulk-fill state — a fast, non-AI grid for genuinely-missing fields
  // (phone, email, emergency contact) that suggestGaps() has no signal to
  // infer. One draft value per row_id, one commitTidyFixes() call for the
  // whole batch instead of a modal per record.
  const [bulkFillField, setBulkFillField] = useState<string | null>(initialGapField ?? null);
  const [bulkFillDrafts, setBulkFillDrafts] = useState<Record<string, string>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResult, setBulkResult] = useState<TidyCommitResult | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Gap suggestion state
  const [suggestRowId, setSuggestRowId] = useState<string | null>(null);
  const [suggestRowLabel, setSuggestRowLabel] = useState("");
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestResult, setSuggestResult] = useState<GapSuggestResult | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const gapFields = useMemo(
    () => buildGapFields(fieldImportanceOverrides)[entity] ?? [],
    [entity, fieldImportanceOverrides],
  );
  const displayColumns = DISPLAY_COLUMNS[entity] ?? [];
  const dupeKeys = DUPE_KEYS[entity] ?? [];
  const tidyEntity = ENTITY_TO_TIDY[entity] ?? null;

  // ── Fetch canonical rows ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      if (!supabase) {
        setLoading(false);
        setError("No database connection available.");
        return;
      }

      try {
        const data = await fetchCanonicalRows(supabase as unknown as CanonicalFetchClient, entity);
        if (!cancelled) setRows(data.map((row) => deriveRow(entity, row)));
      } catch (err: unknown) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load records.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [entity, supabase, refreshCounter]);

  // ── Tidy pass ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (filterMode !== "tidy" || !supabase || !tidyEntity || !tenantId) return;

    let cancelled = false;
    setTidyLoading(true);
    setTidyError(null);
    setTidyReport(null);
    setSelectedFixKeys(new Set());
    setCommitResult(null);
    setTidyProgress("Scanning records…");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runTidyPass({
      supabase: supabase as any,
      tenantId,
      entities: [tidyEntity],
      onProgress: (msg) => {
        if (!cancelled) setTidyProgress(msg);
      },
    })
      .then((report) => {
        if (cancelled) return;
        setTidyReport(report);
        // Pre-select all auto-fixes
        setSelectedFixKeys(
          new Set(report.auto_fixes.map((f) => `${f.row_id}:${f.field}`)),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setTidyError(err instanceof Error ? err.message : "Tidy pass failed.");
      })
      .finally(() => {
        if (!cancelled) setTidyLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filterMode, supabase, tidyEntity, tenantId]);

  // Reset tidy state when leaving tidy mode
  useEffect(() => {
    if (filterMode !== "tidy") {
      setTidyReport(null);
      setTidyError(null);
      setCommitResult(null);
    }
  }, [filterMode]);

  // ── Duplicate detection ────────────────────────────────────────────────
  const duplicateRows = useMemo<DrillRow[]>(() => {
    if (dupeKeys.length === 0) return [];

    const allGroups: DrillRow[][] = [];

    for (const keyField of dupeKeys) {
      const seenIds = new Set<string>();
      const byValue = new Map<string, Row[]>();
      for (const row of rows) {
        const val = row[keyField];
        if (val === null || val === undefined || String(val).trim() === "") continue;
        const normalized = String(val).trim().toLowerCase();
        if (!byValue.has(normalized)) byValue.set(normalized, []);
        byValue.get(normalized)!.push(row);
      }
      for (const [normalized, group] of byValue) {
        if (group.length < 2) continue;
        const fresh = group.filter((r) => !seenIds.has(rowKey(entity, r)));
        if (fresh.length < 2) continue;
        // The normalized value is the group key used everywhere a caller
        // needs to identify "this group" (merge candidates, dismiss) — using
        // each row's own raw value here would let two differently-cased
        // members of the same group (e.g. "John@x.com" / "john@x.com")
        // silently disagree on their own group's key.
        if (dismissedGroups.has(`${keyField}:${normalized}`)) continue;
        fresh.forEach((r) => seenIds.add(rowKey(entity, r)));
        allGroups.push(
          fresh.map((r) => ({
            ...r,
            _dupeField: keyField,
            _dupeKey: normalized,
          })),
        );
      }
    }

    return allGroups.flat();
  }, [rows, dupeKeys, dismissedGroups]);

  const dupeGroupIndex = useMemo<Map<string, number>>(() => {
    if (filterMode !== "duplicates") return new Map();
    const m = new Map<string, number>();
    let idx = 0;
    for (const row of duplicateRows) {
      const key = `${row._dupeField}:${row._dupeKey}`;
      if (!m.has(key)) m.set(key, idx++);
    }
    return m;
  }, [duplicateRows, filterMode]);

  // ── Fetch usage counts for every site row in a "duplicates" view ────────
  // One batched call per distinct set of duplicate rows — refetches whenever
  // the underlying row set changes (e.g. after a refresh).
  useEffect(() => {
    if (entity !== "sites" || filterMode !== "duplicates" || !supabase) return;
    const ids = Array.from(new Set(duplicateRows.map((r) => rowKey(entity, r)).filter(Boolean)));
    if (ids.length === 0) return;

    let cancelled = false;
    setUsageLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    getSiteDupeUsage(sb, ids)
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch((err: unknown) => {
        // Non-critical — the merge cell falls back to the legacy heuristic
        // when usage data is unavailable.
        // eslint-disable-next-line no-console
        console.warn("[EntityDrillDown] getSiteDupeUsage failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [entity, filterMode, supabase, duplicateRows]);

  // ── Fetch previously-dismissed "not a duplicate" groups (non-sites) ─────
  // Independent of duplicateRows (which filters against this) to avoid a
  // fetch loop — keyed only on entity/mode/refresh.
  useEffect(() => {
    if (entity === "sites" || filterMode !== "duplicates" || !supabase) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    sb.rpc("eq_duplicate_dismissals_list", { p_entity: entity })
      .then(({ data, error: rpcError }: { data: unknown; error: { message: string } | null }) => {
        if (cancelled || rpcError) return;
        const rows = (data as { dupe_field: string; dupe_key: string }[] | null) ?? [];
        setDismissedGroups(new Set(rows.map((r) => `${r.dupe_field}:${r.dupe_key}`)));
      })
      .catch(() => {
        // Non-critical — dismissed groups just won't be pre-filtered this load.
      });
    return () => {
      cancelled = true;
    };
  }, [entity, filterMode, supabase, refreshCounter]);

  // ── Site groups eligible for "Flag for merge" ───────────────────────────
  // Usage is the primary signal: a site with real records (assets/quotes/
  // contract scopes/jobs/maintenance checks) beats an empty shell, regardless
  // of active/customer status — the SY9 case: the "expected wrong" active row
  // actually held every real record, an active+customer heuristic alone would
  // have picked backwards. Rules, in order:
  //   1. Exactly one row in the group has nonzero usage -> that's the
  //      survivor, every other row is a loser. Works for ANY group size —
  //      this is what unlocks 3+-row groups (the SY9-hospital-trio shape)
  //      that used to be locked out entirely.
  //   2. All rows have zero usage (or usage hasn't loaded yet) -> fall back
  //      to the legacy active+customer heuristic, but ONLY for exact 2-row
  //      groups — a 3+ group with no usage evidence is still a real human
  //      decision (see North Shore/Port Macquarie/St George Private Hospital).
  //   3. Two or more rows have nonzero usage -> a genuine multi-owner
  //      conflict. For a 2-row group, still suggest the higher-total row
  //      (it's only a suggestion; the human confirms via Same before merge
  //      is reachable). For 3+ rows, leave for manual review.
  const siteMergeCandidates = useMemo<Map<string, { survivorId: string; loserIds: string[] }>>(() => {
    const m = new Map<string, { survivorId: string; loserIds: string[] }>();
    if (entity !== "sites") return m;

    const groups = new Map<string, DrillRow[]>();
    for (const row of duplicateRows) {
      const key = `${row._dupeField}:${row._dupeKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const legacyScore = (r: Row): [number, number] => [
      r["active"] === true ? 1 : 0,
      r["customer_id"] ? 1 : 0,
    ];

    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const ids = group.map((r) => rowKey(entity, r));
      if (ids.some((id) => !id)) continue;

      const totals = ids.map((id) => usage[id]?.total ?? 0);
      const nonZero = totals.filter((t) => t > 0);

      let survivorIdx: number | null = null;

      if (nonZero.length === 1) {
        survivorIdx = totals.findIndex((t) => t > 0);
      } else if (nonZero.length === 0 && group.length === 2) {
        const [a, b] = group;
        const [aActive, aCust] = legacyScore(a);
        const [bActive, bCust] = legacyScore(b);
        if (bActive !== aActive) survivorIdx = bActive > aActive ? 1 : 0;
        else if (bCust !== aCust) survivorIdx = bCust > aCust ? 1 : 0;
        else survivorIdx = ids[1] < ids[0] ? 1 : 0;
      } else if (nonZero.length >= 2 && group.length === 2) {
        survivorIdx = totals[1] > totals[0] ? 1 : 0;
      }
      // nonZero.length >= 2 && group.length >= 3, or nonZero.length === 0 &&
      // group.length >= 3: no auto pick, leave the group out of the map.

      if (survivorIdx === null) continue;
      const survivorId = ids[survivorIdx];
      const loserIds = ids.filter((_, i) => i !== survivorIdx);
      m.set(key, { survivorId, loserIds });
    }

    return m;
  }, [duplicateRows, entity, usage]);

  const handleFlagPair = useCallback(
    async (groupKey: string, survivorId: string, loserIds: string[]) => {
      if (!supabase || flagBusy[groupKey]) return;
      setFlagBusy((prev) => ({ ...prev, [groupKey]: true }));
      setFlagError((prev) => {
        const next = { ...prev };
        delete next[groupKey];
        return next;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const advisoryIds: string[] = [];
      let firstError: string | null = null;
      for (const loserId of loserIds) {
        try {
          const res = await flagSitePairForMerge(sb, { survivorSiteId: survivorId, loserSiteId: loserId });
          advisoryIds.push(res.advisoryId);
        } catch (err: unknown) {
          firstError = err instanceof Error ? err.message : "Couldn't flag this pair.";
          break;
        }
      }
      if (advisoryIds.length > 0) {
        setFlagged((prev) => ({ ...prev, [groupKey]: [...(prev[groupKey] ?? []), ...advisoryIds] }));
      }
      if (firstError) {
        setFlagError((prev) => ({ ...prev, [groupKey]: firstError! }));
      }
      setFlagBusy((prev) => ({ ...prev, [groupKey]: false }));
    },
    [supabase, flagBusy],
  );

  const handleArchiveDuplicate = useCallback(
    async (rowId: string) => {
      if (!supabase || archiveBusy[rowId] || !rowId || !canEditCanonical) return;
      setArchiveBusy((prev) => ({ ...prev, [rowId]: true }));
      setArchiveError((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      try {
        await archiveDuplicateRecord(sb, { table: entity, rowId });
        setRefreshCounter((c) => c + 1);
      } catch (err: unknown) {
        setArchiveError((prev) => ({
          ...prev,
          [rowId]: err instanceof Error ? err.message : "Couldn't archive this record.",
        }));
      } finally {
        setArchiveBusy((prev) => ({ ...prev, [rowId]: false }));
      }
    },
    [supabase, archiveBusy, entity, canEditCanonical],
  );

  // First row_id encountered per dupe group, in duplicateRows order — the
  // dismiss action renders once per group (dismissing applies to the whole
  // group, not one row), same "action on one row, hint on the rest" shape
  // Sites' merge cell already uses.
  const groupFirstRowId = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const row of duplicateRows) {
      const key = `${row._dupeField}:${row._dupeKey}`;
      if (!m.has(key)) m.set(key, rowKey(entity, row));
    }
    return m;
  }, [duplicateRows, entity]);

  const handleDismissDuplicate = useCallback(
    async (dupeField: string, dupeKey: string) => {
      const groupKey = `${dupeField}:${dupeKey}`;
      if (!supabase || dismissBusy[groupKey] || !canEditCanonical) return;
      setDismissBusy((prev) => ({ ...prev, [groupKey]: true }));
      setDismissError((prev) => {
        const next = { ...prev };
        delete next[groupKey];
        return next;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      try {
        const { error: rpcError } = await sb.rpc("eq_duplicate_dismiss", {
          p_entity: entity,
          p_dupe_field: dupeField,
          p_dupe_key: dupeKey,
        });
        if (rpcError) throw new Error(rpcError.message);
        setDismissedGroups((prev) => new Set(prev).add(groupKey));
      } catch (err: unknown) {
        setDismissError((prev) => ({
          ...prev,
          [groupKey]: err instanceof Error ? err.message : "Couldn't dismiss this group.",
        }));
      } finally {
        setDismissBusy((prev) => ({ ...prev, [groupKey]: false }));
      }
    },
    [supabase, dismissBusy, entity, canEditCanonical],
  );

  // Full row lookup by PK — lets the Tidy tab's gap table show real context
  // (email/phone/company) for a bare row_label without a second fetch or a
  // GapItem type change; the tidy pass engine's own row_label logic stays
  // untouched, this is purely a display join inside the demo module.
  const rowContext = useMemo<Map<string, Row>>(
    () => new Map(rows.map((r) => [rowKey(entity, r), r])),
    [rows, entity],
  );

  const baseRows = useMemo<DrillRow[]>(() => {
    if (filterMode === "gaps") return rows.filter((r) => rowHasGap(r, gapFields));
    if (filterMode === "duplicates") return duplicateRows;
    return rows;
  }, [rows, filterMode, gapFields, duplicateRows]);

  const displayRows = useMemo<DrillRow[]>(() => {
    if (!askFilters || askFilters.length === 0) return baseRows;
    return applyFilters(baseRows, askFilters) as DrillRow[];
  }, [baseRows, askFilters]);

  const gapCount = useMemo(
    () => rows.filter((r) => rowHasGap(r, gapFields)).length,
    [rows, gapFields],
  );
  const totalCount = rows.length;
  const dupeCount = duplicateRows.length;

  // ── Edit handlers (by row ID) ──────────────────────────────────────────
  const startEdit = useCallback(
    (rowId: string, field: string) => {
      if (!canEditCanonical) return;
      const targetRow = rows.find((r) => rowKey(entity, r) === rowId);
      const current = targetRow?.[field];
      setEditState({ rowId, field });
      setEditDraft(current === null || current === undefined ? "" : String(current));
    },
    [rows, entity, canEditCanonical],
  );

  const commitEdit = useCallback(async () => {
    if (!editState || !canEditCanonical) return;
    const { rowId, field } = editState;
    const targetRow = rows.find((r) => rowKey(entity, r) === rowId);
    const newValue = editDraft;

    // No live client (e.g. a static preview) — nothing to save against, fall
    // back to the old local-only behaviour rather than pretending to persist.
    if (!supabase) {
      setRows((prev) => prev.map((r) => (rowKey(entity, r) === rowId ? { ...r, [field]: newValue } : r)));
      setHasLocalEdits(true);
      setEditState(null);
      setEditDraft("");
      return;
    }

    if (!tenantId) {
      setEditSaveError("Missing tenant — can't save this change.");
      return;
    }

    const tidyEntity = ENTITY_TO_TIDY[entity];
    if (!tidyEntity || !targetRow) return;

    const gapMatch = tidyReport?.gaps.find((g) => g.row_id === rowId && g.field === field);
    const oldValue = targetRow[field] == null ? "" : String(targetRow[field]);
    const fix: TidyFix = {
      entity:    tidyEntity,
      table:     entity,
      row_id:    rowId,
      row_label: gapMatch?.row_label ?? fallbackRowLabel(targetRow),
      field,
      fix_type:  "other",
      old_value: oldValue,
      new_value: newValue,
    };

    setEditSaving(true);
    setEditSaveError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await commitTidyFixes({ supabase: supabase as any, tenantId, fixes: [fix] });
      if (result.applied > 0) {
        setRows((prev) => prev.map((r) => (rowKey(entity, r) === rowId ? { ...r, [field]: newValue } : r)));
        if (tidyReport) {
          setTidyReport({ ...tidyReport, gaps: tidyReport.gaps.filter((g) => !(g.row_id === rowId && g.field === field)) });
        }
        setEditState(null);
        setEditDraft("");
      } else {
        setEditSaveError(`"${fieldLabel(field)}" wasn't saved — the server doesn't allow editing this field yet.`);
      }
    } catch (err) {
      setEditSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
  }, [editState, editDraft, entity, rows, supabase, tidyReport, tenantId, canEditCanonical]);

  const cancelEdit = useCallback(() => {
    setEditState(null);
    setEditDraft("");
    setEditSaveError(null);
  }, []);

  // ── Tidy fix commit ────────────────────────────────────────────────────
  const handleApplyFixes = useCallback(async () => {
    if (!supabase || !tidyReport || selectedFixKeys.size === 0 || committing) return;

    if (!tenantId) {
      setTidyError("Missing tenant — can't apply fixes.");
      return;
    }

    const fixes = tidyReport.auto_fixes.filter((f) =>
      selectedFixKeys.has(`${f.row_id}:${f.field}`),
    );

    setCommitting(true);
    setCommitResult(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await commitTidyFixes({
        supabase: supabase as any,
        tenantId,
        fixes,
      });
      setCommitResult(result);
      if (result.applied > 0) {
        // Refresh main rows and re-run tidy on next entry
        setRefreshCounter((c) => c + 1);
        setTidyReport(null);
      }
    } catch (err: unknown) {
      setTidyError(err instanceof Error ? err.message : "Failed to apply fixes.");
    } finally {
      setCommitting(false);
    }
  }, [supabase, tidyReport, selectedFixKeys, committing, tenantId]);

  const handleBulkDraftChange = useCallback((rowId: string, value: string) => {
    setBulkFillDrafts((prev) => ({ ...prev, [rowId]: value }));
  }, []);

  const exitBulkFill = useCallback(() => {
    setBulkFillField(null);
    setBulkFillDrafts({});
    setBulkResult(null);
    setBulkError(null);
  }, []);

  // ── Bulk-fill commit — one commitTidyFixes() call for every row the
  // operator typed a value into, instead of a save per record. ────────────
  const handleBulkSave = useCallback(async () => {
    if (!supabase || !tidyReport || !bulkFillField || !canEditCanonical || bulkSaving) return;

    if (!tenantId) {
      setBulkError("Missing tenant — can't save.");
      return;
    }

    const tidyEntity = ENTITY_TO_TIDY[entity];
    if (!tidyEntity) return;

    const fixes: TidyFix[] = tidyReport.gaps
      .filter((g) => g.field === bulkFillField && (bulkFillDrafts[g.row_id] ?? "").trim() !== "")
      .map((g) => {
        const targetRow = rows.find((r) => rowKey(entity, r) === g.row_id);
        const oldValue = targetRow?.[bulkFillField] == null ? "" : String(targetRow[bulkFillField]);
        return {
          entity:    tidyEntity,
          table:     entity,
          row_id:    g.row_id,
          row_label: g.row_label,
          field:     bulkFillField,
          fix_type:  "other",
          old_value: oldValue,
          new_value: bulkFillDrafts[g.row_id].trim(),
        };
      });

    if (fixes.length === 0) return;

    setBulkSaving(true);
    setBulkError(null);
    setBulkResult(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await commitTidyFixes({ supabase: supabase as any, tenantId, fixes });
      setBulkResult(result);
      if (result.applied > 0) {
        setBulkFillDrafts({});
        setRefreshCounter((c) => c + 1);
        setTidyReport(null);
      }
    } catch (err: unknown) {
      setBulkError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBulkSaving(false);
    }
  }, [supabase, tidyReport, bulkFillField, bulkFillDrafts, canEditCanonical, bulkSaving, entity, rows, tenantId]);

  // ── Gap suggestions ───────────────────────────────────────────────────
  const callEdgeFn = useMemo<EdgeFnCaller | null>(() => {
    if (!supabase) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    return (action: string, payload: Record<string, unknown>) =>
      sb.functions.invoke('eq-ai-assist', { body: { action, ...payload } }) as Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
  }, [supabase]);

  const handleSuggest = useCallback(
    async (row: Row, fieldsOverride?: string[]) => {
      if (!callEdgeFn) return;
      const rowId = rowKey(entity, row);
      const missingFields = fieldsOverride ?? gapFields.filter((f) => isBlank(row[f]));
      if (missingFields.length === 0) return;

      const label = String(
        row['company_name'] ?? row['first_name'] ?? row['name'] ??
        row['licence_number'] ?? rowId
      );

      setSuggestRowId(rowId);
      setSuggestRowLabel(label);
      setSuggestLoading(true);
      setSuggestResult(null);
      setSuggestError(null);

      try {
        const result = await suggestGaps(entity, row, missingFields, callEdgeFn);
        setSuggestResult(result);
      } catch (err: unknown) {
        setSuggestError(err instanceof Error ? err.message : String(err));
      } finally {
        setSuggestLoading(false);
      }
    },
    [callEdgeFn, entity, gapFields],
  );

  const acceptSuggestion = useCallback(
    async (field: string, value: string) => {
      if (!suggestRowId) return;
      const targetRow = rows.find((r) => rowKey(entity, r) === suggestRowId);

      if (!supabase) {
        setRows((prev) => prev.map((r) => (rowKey(entity, r) === suggestRowId ? { ...r, [field]: value } : r)));
        setHasLocalEdits(true);
        return;
      }

      if (!tenantId) {
        setSuggestError("Missing tenant — can't save this change.");
        return;
      }

      const tidyEntity = ENTITY_TO_TIDY[entity];
      if (!tidyEntity || !targetRow) return;

      const gapMatch = tidyReport?.gaps.find((g) => g.row_id === suggestRowId && g.field === field);
      const oldValue = targetRow[field] == null ? "" : String(targetRow[field]);
      const fix: TidyFix = {
        entity:    tidyEntity,
        table:     entity,
        row_id:    suggestRowId,
        row_label: gapMatch?.row_label ?? suggestRowLabel ?? fallbackRowLabel(targetRow),
        field,
        fix_type:  "other",
        old_value: oldValue,
        new_value: value,
      };

      setSuggestError(null);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await commitTidyFixes({ supabase: supabase as any, tenantId, fixes: [fix] });
        if (result.applied > 0) {
          setRows((prev) => prev.map((r) => (rowKey(entity, r) === suggestRowId ? { ...r, [field]: value } : r)));
          if (tidyReport) {
            setTidyReport({ ...tidyReport, gaps: tidyReport.gaps.filter((g) => !(g.row_id === suggestRowId && g.field === field)) });
          }
          setSuggestRowId(null);
          setSuggestResult(null);
        } else {
          setSuggestError(`"${fieldLabel(field)}" wasn't saved — the server doesn't allow editing this field yet.`);
        }
      } catch (err) {
        setSuggestError(err instanceof Error ? err.message : String(err));
      }
    },
    [suggestRowId, suggestRowLabel, entity, rows, supabase, tidyReport, tenantId],
  );

  // ── Column definitions ────────────────────────────────────────────────
  const columns = useMemo<TableColumn<DrillRow>[]>(() => {
    const cols: TableColumn<DrillRow>[] = displayColumns.map((col) => {
      const isGapField = gapFields.includes(col);
      return {
        key: col,
        header: fieldLabel(col),
        sortAccessor: (row: DrillRow) => {
          const v = row[col];
          return typeof v === "string" || typeof v === "number" ? v : null;
        },
        filterable: "text" as const,
        render: (row: DrillRow) => {
          const rowId = rowKey(entity, row);
          const isEditing = editState?.rowId === rowId && editState?.field === col;
          const blank = isGapField && isBlank(row[col]);

          if (isEditing) {
            const enumValues = getFieldEnumValues(ENTITY_TO_TIDY[entity] ?? "customer", col);
            return (
              <span className="eq-drill__inline-edit">
                {enumValues ? (
                  <select
                    className="eq-drill__inline-select"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    autoFocus
                    aria-label={`Edit ${fieldLabel(col)}`}
                  >
                    <option value="" disabled>Choose a value…</option>
                    {enumValues.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="eq-drill__inline-input"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitEdit();
                      if (e.key === "Escape") cancelEdit();
                    }}
                    autoFocus
                    aria-label={`Edit ${fieldLabel(col)}`}
                  />
                )}
                <button className="eq-drill__inline-save" onClick={() => void commitEdit()} disabled={editSaving} type="button">
                  {editSaving ? "Saving…" : "Save"}
                </button>
                <button className="eq-drill__inline-cancel" onClick={cancelEdit} type="button">
                  Cancel
                </button>
                {editSaveError && <span className="eq-drill__inline-error" role="alert">{editSaveError}</span>}
              </span>
            );
          }

          const gapTier = blank ? getFieldTier(entity, col, fieldImportanceOverrides) : null;
          const cellClass = [
            "eq-drill__cell-value",
            blank ? "eq-drill__cell-value--gap" : "",
            blank && gapTier === "critical" ? "eq-drill__cell-value--gap-critical" : "",
            isGapField && !blank ? "eq-drill__cell-value--filled" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <span
              className={cellClass}
              onClick={
                isGapField && !isEditing && canEditCanonical
                  ? (e) => {
                      e.stopPropagation();
                      startEdit(rowId, col);
                    }
                  : undefined
              }
              title={isGapField && !isEditing && canEditCanonical ? "Click to edit" : undefined}
            >
              {isBlank(row[col]) ? (
                <span className="eq-drill__cell-empty">—</span>
              ) : (
                String(row[col])
              )}
            </span>
          );
        },
      };
    });

    if (filterMode === "duplicates") {
      cols.push({
        key: "_dupeKey",
        header: "Matched on",
        // no sortAccessor = not sortable
        render: (row: DrillRow) =>
          row._dupeField ? (
            <span className="eq-drill__dupe-badge">
              {fieldLabel(row._dupeField)}
            </span>
          ) : null,
      });
    }

    if (filterMode === "duplicates" && entity === "sites") {
      cols.push({
        key: "_usage",
        header: "Records",
        sortable: false,
        render: (row: DrillRow) => {
          const rowId = rowKey(entity, row);
          if (usageLoading && usage[rowId] === undefined) {
            return <span className="eq-drill__dupe-hint">checking…</span>;
          }
          const total = usage[rowId]?.total ?? 0;
          return (
            <span className={total > 0 ? "eq-drill__usage-badge eq-drill__usage-badge--has-data" : "eq-drill__usage-badge"}>
              {total.toLocaleString()} record{total === 1 ? "" : "s"}
            </span>
          );
        },
      });

      cols.push({
        key: "_merge",
        header: "Merge",
        sortable: false,
        render: (row: DrillRow) => {
          const groupKey = `${row._dupeField}:${row._dupeKey}`;
          const candidate = siteMergeCandidates.get(groupKey);
          const rowId = rowKey(entity, row);

          if (!candidate) {
            return usageLoading ? (
              <span className="eq-drill__dupe-hint">checking usage…</span>
            ) : (
              <span className="eq-drill__dupe-hint">
                more than one owns real data — review manually
              </span>
            );
          }

          if (rowId !== candidate.survivorId) {
            // Only the survivor row carries the action; other rows in the
            // group just say where they're headed so it isn't N buttons.
            return <span className="eq-drill__dupe-hint">duplicate of survivor above</span>;
          }

          const flaggedIds = flagged[groupKey] ?? [];
          if (flaggedIds.length >= candidate.loserIds.length) {
            return (
              <span className="eq-drill__dupe-flagged">
                ✓ Flagged{onBack ? " — " : ""}
                {onBack && (
                  <button type="button" className="eq-drill__suggest-btn" onClick={(e) => { e.stopPropagation(); onBack(); }}>
                    review on Health tab
                  </button>
                )}
              </span>
            );
          }

          if (!canMergeSites) {
            return <span className="eq-drill__dupe-hint">Ask a manager to flag this for merging</span>;
          }

          const busy = !!flagBusy[groupKey];
          const err = flagError[groupKey];
          const remaining = candidate.loserIds.length - flaggedIds.length;
          return (
            <span className="eq-drill__merge-cell">
              <button
                type="button"
                className="eq-drill__suggest-btn"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleFlagPair(groupKey, candidate.survivorId, candidate.loserIds);
                }}
              >
                {busy
                  ? "Flagging…"
                  : candidate.loserIds.length > 1
                    ? `Flag ${remaining} for merge`
                    : "Flag for merge"}
              </button>
              {err && <span className="eq-drill__dupe-error">{err}</span>}
            </span>
          );
        },
      });
    }

    if (filterMode === "duplicates" && entity !== "sites" && canEditCanonical) {
      cols.push({
        key: "_dismiss",
        header: "Not a duplicate",
        sortable: false,
        render: (row: DrillRow) => {
          const groupKey = `${row._dupeField}:${row._dupeKey}`;
          const rowId = rowKey(entity, row);
          if (groupFirstRowId.get(groupKey) !== rowId) {
            return <span className="eq-drill__dupe-hint">part of the group above</span>;
          }
          const busy = !!dismissBusy[groupKey];
          const err = dismissError[groupKey];
          return (
            <span className="eq-drill__merge-cell">
              <button
                type="button"
                className="eq-drill__suggest-btn"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDismissDuplicate(row._dupeField ?? "", row._dupeKey ?? "");
                }}
              >
                {busy ? "Dismissing…" : "Not a duplicate"}
              </button>
              {err && <span className="eq-drill__dupe-error">{err}</span>}
            </span>
          );
        },
      });
    }

    if (filterMode === "duplicates" && entity !== "sites" && isArchivableDuplicate(entity) && canEditCanonical) {
      cols.push({
        key: "_archive",
        header: "Archive",
        sortable: false,
        render: (row: DrillRow) => {
          const rowId = rowKey(entity, row);
          const busy = !!archiveBusy[rowId];
          const err = archiveError[rowId];
          return (
            <span className="eq-drill__merge-cell">
              <button
                type="button"
                className="eq-drill__suggest-btn"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleArchiveDuplicate(rowId);
                }}
              >
                {busy ? "Archiving…" : "Archive"}
              </button>
              {err && <span className="eq-drill__dupe-error">{err}</span>}
            </span>
          );
        },
      });
    }

    if (filterMode === "gaps" && callEdgeFn) {
      cols.push({
        key: "_suggest",
        header: "Suggest",
        render: (row: DrillRow) => {
          const missing = gapFields.filter((f) => isBlank(row[f]));
          if (missing.length === 0) return null;
          return (
            <button
              type="button"
              className="eq-drill__suggest-btn"
              onClick={(e) => { e.stopPropagation(); handleSuggest(row); }}
            >
              Suggest
            </button>
          );
        },
      });
    }

    return cols;
  }, [
    displayColumns,
    gapFields,
    filterMode,
    editState,
    editDraft,
    commitEdit,
    cancelEdit,
    startEdit,
    callEdgeFn,
    handleSuggest,
    entity,
    siteMergeCandidates,
    usage,
    usageLoading,
    flagged,
    flagBusy,
    flagError,
    canMergeSites,
    canEditCanonical,
    handleFlagPair,
    archiveBusy,
    archiveError,
    handleArchiveDuplicate,
    groupFirstRowId,
    dismissBusy,
    dismissError,
    handleDismissDuplicate,
    onBack,
  ]);

  // ── CSV download ──────────────────────────────────────────────────────
  const handleDownloadCsv = useCallback(() => {
    const csv = buildCsvContent(displayRows, displayColumns);
    const suffix =
      filterMode === "gaps"
        ? "-gaps"
        : filterMode === "duplicates"
          ? "-dupes"
          : "";
    const filename = `${entity}${suffix}-${todayString()}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

    if (onBulkFix) {
      onBulkFix(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }, [displayRows, displayColumns, entity, filterMode, onBulkFix]);

  // ── Render ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="eq-drill">
        <Table<DrillRow>
          columns={displayColumns.map((col) => ({
            key: col,
            header: fieldLabel(col),
          }))}
          rows={[]}
          loading={true}
          loadingRows={8}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="eq-drill">
        {onBack && (
          <button className="eq-drill__back" onClick={onBack} type="button">
            ← Back
          </button>
        )}
        <div className="eq-drill__error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      </div>
    );
  }

  const emptyMsg =
    askFilters && askFilters.length > 0 && baseRows.length > 0
      ? "No records match your question within this filter — try Clear to see the rest."
      : filterMode === "gaps"
        ? `No gaps found — all ${formatLabel(entity).toLowerCase()} records are complete.`
        : filterMode === "duplicates"
          ? `No duplicates detected in ${formatLabel(entity).toLowerCase()}.`
          : `No ${entity} records found — import some via the Import tab.`;

  return (
    <div className="eq-drill">
      <div className="eq-drill__header">
        <div className="eq-drill__header-left">
          {onBack && (
            <button className="eq-drill__back" onClick={onBack} type="button">
              ← Back
            </button>
          )}
          <h2 className="eq-drill__title">
            {formatLabel(entity)} — {totalCount.toLocaleString()} record
            {totalCount !== 1 ? "s" : ""}
            {gapCount > 0 && (
              <span className="eq-drill__gap-badge">{gapCount} with gaps</span>
            )}
            {dupeCount > 0 && (
              <span className="eq-drill__dupe-count-badge">
                {dupeCount} possible dupes
              </span>
            )}
          </h2>
        </div>
        <div className="eq-drill__actions">
          <div className="eq-drill__filter" role="group" aria-label="Filter rows">
            <button
              className={`eq-drill__filter-btn${filterMode === "all" ? " eq-drill__filter-btn--active" : ""}`}
              onClick={() => setFilterMode("all")}
              type="button"
              aria-pressed={filterMode === "all"}
            >
              All
            </button>
            <button
              className={`eq-drill__filter-btn${filterMode === "gaps" ? " eq-drill__filter-btn--active" : ""}`}
              onClick={() => setFilterMode("gaps")}
              type="button"
              aria-pressed={filterMode === "gaps"}
            >
              Gaps
            </button>
            {dupeKeys.length > 0 && (
              <button
                className={`eq-drill__filter-btn${filterMode === "duplicates" ? " eq-drill__filter-btn--active" : ""}`}
                onClick={() => setFilterMode("duplicates")}
                type="button"
                aria-pressed={filterMode === "duplicates"}
              >
                Dupes{dupeCount > 0 ? ` (${dupeCount})` : ""}
              </button>
            )}
            {tidyEntity && (
              <button
                className={`eq-drill__filter-btn${filterMode === "tidy" ? " eq-drill__filter-btn--active" : ""}`}
                onClick={() => setFilterMode("tidy")}
                type="button"
                aria-pressed={filterMode === "tidy"}
              >
                Tidy
              </button>
            )}
          </div>
          {askFilters && askFilters.length > 0 && (
            <span className="eq-drill__ask-filter">
              Filtered: {initialFilterLabel ?? "matches your question"}
              <button
                type="button"
                className="eq-drill__ask-filter-clear"
                onClick={() => setAskFilters(null)}
              >
                Clear
              </button>
            </span>
          )}
          {filterMode !== "tidy" && (
            <button
              className="eq-drill__download"
              onClick={handleDownloadCsv}
              type="button"
              disabled={displayRows.length === 0}
            >
              Download CSV
            </button>
          )}
        </div>
      </div>

      {hasLocalEdits && (
        <div className="eq-drill__edit-notice" role="status">
          Changes are local only — use Download to export and re-import via Reconcile.
        </div>
      )}

      {filterMode === "tidy" ? (
        <TidyPanel
          loading={tidyLoading}
          progress={tidyProgress}
          error={tidyError}
          report={tidyReport}
          selectedFixKeys={selectedFixKeys}
          onSelectionChange={setSelectedFixKeys}
          onApply={handleApplyFixes}
          committing={committing}
          commitResult={commitResult}
          entityLabel={formatLabel(entity)}
          editState={editState}
          editDraft={editDraft}
          onEditDraftChange={setEditDraft}
          onStartEdit={startEdit}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
          onSuggest={(rowId, field) => {
            const row = rows.find((r) => rowKey(entity, r) === rowId);
            if (row) void handleSuggest(row, [field]);
          }}
          canSuggest={!!callEdgeFn}
          editSaving={editSaving}
          editSaveError={editSaveError}
          rowContext={rowContext}
          bulkFillField={bulkFillField}
          onEnterBulkFill={setBulkFillField}
          onExitBulkFill={exitBulkFill}
          bulkFillDrafts={bulkFillDrafts}
          onBulkDraftChange={handleBulkDraftChange}
          onBulkSave={handleBulkSave}
          bulkSaving={bulkSaving}
          bulkResult={bulkResult}
          bulkError={bulkError}
        />
      ) : (
        <Table<DrillRow>
          columns={columns}
          rows={displayRows}
          getRowId={(row) => rowKey(entity, row)}
          emptyMessage={emptyMsg}
          rowStyle={
            filterMode === "duplicates"
              ? (row) => {
                  const key = `${row._dupeField}:${row._dupeKey}`;
                  const idx = dupeGroupIndex.get(key) ?? 0;
                  return idx % 2 === 1
                    ? { backgroundColor: "var(--eq-ice)" }
                    : undefined;
                }
              : undefined
          }
          className="eq-drill__data-table"
        />
      )}

      {suggestRowId && (
        <SuggestPanel
          rowLabel={suggestRowLabel}
          loading={suggestLoading}
          result={suggestResult}
          error={suggestError}
          onAccept={acceptSuggestion}
          onClose={() => { setSuggestRowId(null); setSuggestResult(null); setSuggestError(null); }}
        />
      )}
    </div>
  );
}

// ── TidyPanel ─────────────────────────────────────────────────────────────────

interface TidyPanelProps {
  loading: boolean;
  progress: string;
  error: string | null;
  report: TidyReport | null;
  selectedFixKeys: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onApply: () => void;
  committing: boolean;
  commitResult: TidyCommitResult | null;
  entityLabel: string;
  editState: { rowId: string; field: string } | null;
  editDraft: string;
  onEditDraftChange: (v: string) => void;
  onStartEdit: (rowId: string, field: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onSuggest: (rowId: string, field: string) => void;
  canSuggest: boolean;
  editSaving: boolean;
  editSaveError: string | null;
  /** row_id -> full canonical row, for showing real context (email/phone/company) next to a bare row_label. */
  rowContext: Map<string, Row>;
  /** Non-null while the gap section is showing the bulk-fill grid for one field. */
  bulkFillField: string | null;
  onEnterBulkFill: (field: string) => void;
  onExitBulkFill: () => void;
  bulkFillDrafts: Record<string, string>;
  onBulkDraftChange: (rowId: string, value: string) => void;
  onBulkSave: () => void;
  bulkSaving: boolean;
  bulkResult: TidyCommitResult | null;
  bulkError: string | null;
}

const FIX_TYPE_LABELS: Record<string, string> = {
  phone: "Phone",
  au_state: "State",
  email: "Email",
  abn: "ABN",
  date: "Date",
  string: "Text",
  boolean: "Boolean",
  other: "Other",
};

const GAP_TYPE_LABELS: Record<string, string> = {
  required_missing: "Missing",
  format_invalid: "Invalid format",
  fk_no_match: "Broken link",
};

const FLAG_TYPE_LABELS: Record<string, string> = {
  phone_kept_raw: "Phone kept raw",
  date_ambiguous: "Date ambiguous",
  value_unusual: "Unusual value",
  cross_field_warning: "Cross-field",
};

function TidyPanel({
  loading,
  progress,
  error,
  report,
  selectedFixKeys,
  onSelectionChange,
  onApply,
  committing,
  commitResult,
  entityLabel,
  editState,
  editDraft,
  onEditDraftChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onSuggest,
  canSuggest,
  editSaving,
  editSaveError,
  rowContext,
  bulkFillField,
  onEnterBulkFill,
  onExitBulkFill,
  bulkFillDrafts,
  onBulkDraftChange,
  onBulkSave,
  bulkSaving,
  bulkResult,
  bulkError,
}: TidyPanelProps): JSX.Element {
  if (loading) {
    return (
      <div className="eq-tidy">
        <div className="eq-tidy__loading">
          <span className="eq-health-spinner" aria-hidden="true" />
          <span>{progress || "Scanning…"}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="eq-tidy">
        <div className="eq-drill__error" role="alert">
          <strong>Tidy pass error:</strong> {error}
        </div>
      </div>
    );
  }

  if (!report) return <div className="eq-tidy" />;

  const { auto_fixes, gaps, review_flags, not_scanned = [], summary } = report;

  // Fields with more than one gap are worth a bulk-fill link — a single gap
  // isn't worth switching views for, the inline "Edit" below is just as fast.
  const bulkFillCandidates = new Map<string, number>();
  for (const g of gaps) {
    bulkFillCandidates.set(g.field, (bulkFillCandidates.get(g.field) ?? 0) + 1);
  }
  const bulkFillGaps = bulkFillField ? gaps.filter((g) => g.field === bulkFillField) : [];

  const allClean =
    auto_fixes.length === 0 &&
    gaps.length === 0 &&
    review_flags.length === 0 &&
    not_scanned.length === 0;

  const fixColumns: TableColumn<TidyFix>[] = [
    {
      key: "row_label",
      header: "Record",
      sortAccessor: (f) => f.row_label,
      filterable: "text",
    },
    {
      key: "field",
      header: "Field",
      sortAccessor: (f) => f.field,
      render: (f) => <span>{fieldLabel(f.field)}</span>,
    },
    {
      key: "old_value",
      header: "Current",
      render: (f) => <span className="eq-tidy__old-value">{f.old_value}</span>,
    },
    {
      key: "new_value",
      header: "Normalised",
      render: (f) => <span className="eq-tidy__new-value">{f.new_value}</span>,
    },
    {
      key: "fix_type",
      header: "Type",
      sortable: false,
      render: (f) => (
        <span className="eq-tidy__fix-badge">
          {FIX_TYPE_LABELS[f.fix_type] ?? f.fix_type}
        </span>
      ),
    },
  ];

  const gapColumns: TableColumn<GapItem>[] = [
    {
      key: "row_label",
      header: "Record",
      sortAccessor: (g) => g.row_label,
      filterable: "text",
      render: (g) => {
        const context = gapContextLine(rowContext.get(g.row_id));
        return (
          <span>
            {g.row_label}
            {context && context !== g.row_label && (
              <span className="eq-tidy__row-context"> · {context}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "field",
      header: "Field",
      sortAccessor: (g) => g.field,
      render: (g) => <span>{fieldLabel(g.field)}</span>,
    },
    {
      key: "message",
      header: "Issue",
      render: (g) => <span>{g.message}</span>,
    },
    {
      key: "gap_type",
      header: "Type",
      sortable: false,
      render: (g) => (
        <span className={`eq-tidy__gap-badge eq-tidy__gap-badge--${g.gap_type}`}>
          {GAP_TYPE_LABELS[g.gap_type] ?? g.gap_type}
        </span>
      ),
    },
    {
      key: "_fix",
      header: "Fix",
      sortable: false,
      render: (g) => {
        const isEditing = editState?.rowId === g.row_id && editState?.field === g.field;
        if (isEditing) {
          return (
            <span className="eq-drill__inline-edit">
              {g.allowed_values ? (
                <select
                  className="eq-drill__inline-select"
                  value={editDraft}
                  onChange={(e) => onEditDraftChange(e.target.value)}
                  autoFocus
                  aria-label={`Edit ${fieldLabel(g.field)} for ${g.row_label}`}
                >
                  <option value="" disabled>Choose a value…</option>
                  {g.allowed_values.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="eq-drill__inline-input"
                  value={editDraft}
                  onChange={(e) => onEditDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitEdit();
                    if (e.key === "Escape") onCancelEdit();
                  }}
                  autoFocus
                  aria-label={`Edit ${fieldLabel(g.field)} for ${g.row_label}`}
                />
              )}
              <button className="eq-drill__inline-save" onClick={onCommitEdit} disabled={editSaving} type="button">
                {editSaving ? "Saving…" : "Save"}
              </button>
              <button className="eq-drill__inline-cancel" onClick={onCancelEdit} type="button">
                Cancel
              </button>
              {editSaveError && <span className="eq-drill__inline-error" role="alert">{editSaveError}</span>}
            </span>
          );
        }
        return (
          <span className="eq-tidy__fix-actions">
            <button
              type="button"
              className="eq-drill__edit-btn"
              onClick={() => onStartEdit(g.row_id, g.field)}
            >
              Edit
            </button>
            {canSuggest && (
              <button
                type="button"
                className="eq-drill__suggest-btn"
                onClick={() => onSuggest(g.row_id, g.field)}
              >
                Suggest
              </button>
            )}
          </span>
        );
      },
    },
  ];

  const flagColumns: TableColumn<ReviewFlag>[] = [
    {
      key: "row_label",
      header: "Record",
      sortAccessor: (r) => r.row_label,
      filterable: "text",
    },
    {
      key: "field",
      header: "Field",
      sortAccessor: (r) => r.field,
      render: (r) => <span>{fieldLabel(r.field)}</span>,
    },
    {
      key: "message",
      header: "Note",
      render: (r) => <span>{r.message}</span>,
    },
    {
      key: "flag_type",
      header: "Flag",
      sortable: false,
      render: (r) => (
        <span className="eq-tidy__flag-badge">
          {FLAG_TYPE_LABELS[r.flag_type] ?? r.flag_type}
        </span>
      ),
    },
  ];

  return (
    <div className="eq-tidy">
      {/* Summary strip */}
      <div className="eq-tidy__summary">
        <span className="eq-tidy__summary-label">
          {summary.total_rows_scanned.toLocaleString()} {entityLabel.toLowerCase()} scanned
        </span>
        {auto_fixes.length > 0 && (
          <span className="eq-tidy__count eq-tidy__count--fix">
            {auto_fixes.length} auto-fixable
          </span>
        )}
        {gaps.length > 0 && (
          <span className="eq-tidy__count eq-tidy__count--gap">
            {gaps.length} gap{gaps.length !== 1 ? "s" : ""}
          </span>
        )}
        {review_flags.length > 0 && (
          <span className="eq-tidy__count eq-tidy__count--flag">
            {review_flags.length} need review
          </span>
        )}
        {not_scanned.length > 0 && (
          <span className="eq-tidy__count eq-tidy__count--flag">
            {not_scanned.length} not scanned
          </span>
        )}
        {allClean && (
          <span className="eq-tidy__count eq-tidy__count--ok">All clean</span>
        )}
      </div>

      {not_scanned.length > 0 && (
        <div className="eq-tidy__section" role="status">
          <div className="eq-tidy__section-header">
            <div className="eq-tidy__section-header-text">
              <h3 className="eq-tidy__section-title">Not scanned</h3>
              <p className="eq-tidy__section-hint">
                These lists were requested but not checked — so we don&apos;t pretend they&apos;re clean.
              </p>
            </div>
          </div>
          <ul className="eq-tidy__not-scanned-list">
            {not_scanned.map((item) => (
              <li key={item.entity}>{item.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Auto-fixes */}
      {auto_fixes.length > 0 && (
        <div className="eq-tidy__section">
          <div className="eq-tidy__section-header">
            <div className="eq-tidy__section-header-text">
              <h3 className="eq-tidy__section-title">Auto-fixes</h3>
              <p className="eq-tidy__section-hint">
                These values can be normalised automatically. Select the ones to apply.
              </p>
            </div>
          </div>

          <Table<TidyFix>
            columns={fixColumns}
            rows={auto_fixes}
            getRowId={(f) => `${f.row_id}:${f.field}`}
            selectable
            selectedIds={selectedFixKeys}
            onSelectionChange={onSelectionChange}
            emptyMessage="No auto-fixes found."
            className="eq-tidy__table"
          />

          <div className="eq-tidy__apply-bar">
            {commitResult && (
              <span
                className={`eq-tidy__commit-result${commitResult.errors.length > 0 ? " eq-tidy__commit-result--warn" : " eq-tidy__commit-result--ok"}`}
              >
                {commitResult.applied > 0 && `${commitResult.applied} applied`}
                {commitResult.skipped > 0 && ` · ${commitResult.skipped} skipped`}
                {commitResult.errors.length > 0 &&
                  ` · ${commitResult.errors.length} error${commitResult.errors.length !== 1 ? "s" : ""}`}
              </span>
            )}
            <button
              className="eq-intake-btn-primary"
              type="button"
              onClick={onApply}
              disabled={selectedFixKeys.size === 0 || committing}
            >
              {committing
                ? "Applying…"
                : `Apply ${selectedFixKeys.size} fix${selectedFixKeys.size !== 1 ? "es" : ""}`}
            </button>
          </div>
        </div>
      )}

      {/* Format gaps */}
      {gaps.length > 0 && (
        <div className="eq-tidy__section">
          {bulkFillField && bulkFillGaps.length > 0 ? (
            <BulkFillGrid
              field={bulkFillField}
              gaps={bulkFillGaps}
              rowContext={rowContext}
              drafts={bulkFillDrafts}
              onDraftChange={onBulkDraftChange}
              onSave={onBulkSave}
              onBack={onExitBulkFill}
              saving={bulkSaving}
              result={bulkResult}
              error={bulkError}
            />
          ) : (
            <>
              <div className="eq-tidy__section-header">
                <div className="eq-tidy__section-header-text">
                  <h3 className="eq-tidy__section-title">Data gaps</h3>
                  <p className="eq-tidy__section-hint">
                    Missing required fields or invalid formats. Fix one at a time below, use "Fill
                    in bulk" for a field with several gaps, or download this list and re-upload it
                    on the Reconcile tab.
                  </p>
                </div>
                <button
                  type="button"
                  className="eq-drill__download"
                  onClick={() => {
                    const csv = buildCsvContent(
                      gaps.map((g) => ({ ...g })),
                      ["row_label", "field", "message", "gap_type"],
                    );
                    const filename = `${entityLabel.toLowerCase()}-gaps-${todayString()}.csv`;
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download {gaps.length} gap{gaps.length !== 1 ? "s" : ""} as CSV
                </button>
              </div>
              {bulkFillCandidates.size > 0 && (
                <div className="eq-tidy__bulkfill-links">
                  {[...bulkFillCandidates.entries()]
                    .filter(([, count]) => count > 1)
                    .map(([field, count]) => (
                      <button
                        key={field}
                        type="button"
                        className="eq-drill__suggest-btn"
                        onClick={() => onEnterBulkFill(field)}
                      >
                        Fill in {count} missing {fieldLabel(field)} in bulk
                      </button>
                    ))}
                </div>
              )}
              <Table<GapItem>
                columns={gapColumns}
                rows={gaps}
                getRowId={(g) => `${g.row_id}:${g.field}`}
                emptyMessage="No gaps."
                className="eq-tidy__table"
              />
            </>
          )}
        </div>
      )}

      {/* Review flags */}
      {review_flags.length > 0 && (
        <div className="eq-tidy__section">
          <div className="eq-tidy__section-header">
            <div className="eq-tidy__section-header-text">
              <h3 className="eq-tidy__section-title">Needs review</h3>
              <p className="eq-tidy__section-hint">
                These could not be auto-fixed — a human should check them.
              </p>
            </div>
          </div>
          <Table<ReviewFlag>
            columns={flagColumns}
            rows={review_flags}
            getRowId={(r) => `${r.row_id}:${r.field}`}
            emptyMessage="Nothing to review."
            className="eq-tidy__table"
          />
        </div>
      )}
    </div>
  );
}

// ── BulkFillGrid ─────────────────────────────────────────────────────────────
// A fast, non-AI grid for one gap field at a time: type a value per row, save
// once. Exists because suggestGaps() has no signal to infer phone/email/
// emergency-contact from other fields on the same record — there's nothing to
// suggest, so the fix is faster manual entry, not AI.

interface BulkFillGridProps {
  field: string;
  gaps: GapItem[]; // already filtered to `field`
  rowContext: Map<string, Row>;
  drafts: Record<string, string>;
  onDraftChange: (rowId: string, value: string) => void;
  onSave: () => void;
  onBack: () => void;
  saving: boolean;
  result: TidyCommitResult | null;
  error: string | null;
}

function BulkFillGrid({
  field, gaps, rowContext, drafts, onDraftChange, onSave, onBack, saving, result, error,
}: BulkFillGridProps): JSX.Element {
  const filledCount = gaps.filter((g) => (drafts[g.row_id] ?? "").trim() !== "").length;
  const allowedValues = gaps[0]?.allowed_values;

  return (
    <div className="eq-bulkfill">
      <div className="eq-tidy__section-header">
        <div className="eq-tidy__section-header-text">
          <button type="button" className="eq-drill__back" onClick={onBack}>
            ‹ Back to full list
          </button>
          <h3 className="eq-tidy__section-title">
            Fill in {fieldLabel(field)} for {gaps.length} record{gaps.length !== 1 ? "s" : ""}
          </h3>
          <p className="eq-tidy__section-hint">
            Type a value for as many as you can, then save once — the rest stay on the list for later.
          </p>
        </div>
      </div>
      <div className="eq-bulkfill__rows">
        {gaps.map((g, i) => {
          const context = gapContextLine(rowContext.get(g.row_id));
          return (
            <div key={g.row_id} className="eq-bulkfill__row">
              <span className="eq-bulkfill__label">
                {g.row_label}
                {context && context !== g.row_label && (
                  <span className="eq-tidy__row-context"> · {context}</span>
                )}
              </span>
              {allowedValues ? (
                <select
                  className="eq-drill__inline-select"
                  value={drafts[g.row_id] ?? ""}
                  onChange={(e) => onDraftChange(g.row_id, e.target.value)}
                  aria-label={`${fieldLabel(field)} for ${g.row_label}`}
                >
                  <option value="">—</option>
                  {allowedValues.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="eq-bulkfill__input"
                  value={drafts[g.row_id] ?? ""}
                  onChange={(e) => onDraftChange(g.row_id, e.target.value)}
                  placeholder={fieldLabel(field)}
                  aria-label={`${fieldLabel(field)} for ${g.row_label}`}
                  autoFocus={i === 0}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="eq-tidy__apply-bar">
        {result && (
          <span
            className={`eq-tidy__commit-result${result.errors.length > 0 ? " eq-tidy__commit-result--warn" : " eq-tidy__commit-result--ok"}`}
          >
            {result.applied > 0 && `${result.applied} saved`}
            {result.skipped > 0 && ` · ${result.skipped} skipped`}
          </span>
        )}
        {error && <span className="eq-drill__inline-error" role="alert">{error}</span>}
        <button
          className="eq-intake-btn-primary"
          type="button"
          onClick={onSave}
          disabled={filledCount === 0 || saving}
        >
          {saving ? "Saving…" : `Save ${filledCount} of ${gaps.length}`}
        </button>
      </div>
    </div>
  );
}

// ── SuggestPanel ──────────────────────────────────────────────────────────────

interface SuggestPanelProps {
  rowLabel: string;
  loading: boolean;
  result: GapSuggestResult | null;
  error: string | null;
  onAccept: (field: string, value: string) => void;
  onClose: () => void;
}

function SuggestPanel({ rowLabel, loading, result, error, onAccept, onClose }: SuggestPanelProps): JSX.Element {
  return (
    <div className="eq-suggest-panel" role="region" aria-label="Gap suggestions">
      <div className="eq-suggest-panel__header">
        <span className="eq-suggest-panel__title">Suggestions for {rowLabel}</span>
        <button type="button" className="eq-suggest-panel__close" onClick={onClose} aria-label="Close suggestions">
          ×
        </button>
      </div>

      {loading && (
        <div className="eq-suggest-panel__loading">
          <span className="eq-health-spinner" aria-hidden="true" />
          Asking Claude…
        </div>
      )}

      {error && (
        <div role="alert" className="eq-suggest-panel__error">{error}</div>
      )}

      {result && result.suggestions.length === 0 && !loading && (
        <p className="eq-suggest-panel__empty">
          No suggestions — not enough context to infer values for the missing fields.
        </p>
      )}

      {result && result.suggestions.length > 0 && (
        <div className="eq-suggest-panel__list">
          {result.suggestions.map((s: GapSuggestion) => (
            <div key={s.field} className="eq-suggest-panel__row">
              <div className="eq-suggest-panel__field-info">
                <span className="eq-suggest-panel__field-name">
                  {fieldLabel(s.field)}
                </span>
                <span className={`eq-suggest-panel__confidence eq-suggest-panel__confidence--${s.confidence}`}>
                  {s.confidence}
                </span>
                <span className="eq-suggest-panel__reasoning">{s.reasoning}</span>
              </div>
              <div className="eq-suggest-panel__value-row">
                {s.suggested_value !== null ? (
                  <>
                    <code className="eq-suggest-panel__value">{s.suggested_value}</code>
                    <button
                      type="button"
                      className="eq-intake-btn-primary eq-suggest-panel__accept"
                      onClick={() => onAccept(s.field, s.suggested_value!)}
                    >
                      Accept
                    </button>
                  </>
                ) : (
                  <span className="eq-suggest-panel__no-value">No suggestion</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
