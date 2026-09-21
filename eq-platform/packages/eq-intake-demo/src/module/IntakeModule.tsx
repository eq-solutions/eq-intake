/**
 * IntakeModule — the production-mount entry-point for EQ Intake.
 *
 * Host app (the EQ Shell) imports this and mounts it at /intake.
 *
 * One screen, two questions:
 *   1. Drop a file — parsed + classified once by the shared useIntakeBundle
 *      hook ("looks like customers — 92% sure").
 *   2. Pick where it goes — Into EQ (canonical commit) or out to Xero / MYOB /
 *      Outlook / SharePoint / Equinix (reshape-out CSV). The same dropped
 *      files feed every destination, so nobody drops twice.
 *
 * This replaces the old three-stacked-sections layout (QuickExportSection +
 * RollupDropZone + CanonicalCommitSection), which made the bookkeeper drop
 * files once per flow. QuickExportSection and CanonicalCommitSection have
 * been removed; their reusable pieces now live in src/shared/. RollupDropZone
 * survives for the standalone playground (App.tsx) and the package barrel.
 *
 * Routes log to `eq-intake:routes` in localStorage by default. Host can
 * override via the onDestinationChange prop.
 */

import { useMemo, useState, useEffect, useCallback, type JSX } from "react";
import { type ParsedSheet, readSiteAdvisory, readContactAdvisory, type AskFilter } from "@eq/intake";
import { useIntakeBundle, type IntakeBundle, type FileSlot } from "../shared/intake-bundle.js";
import { IntakeDropZone } from "../shared/IntakeDropZone.js";
import {
  DestinationPicker,
  INTO_EQ_ID,
  findQuickDestination,
} from "../shared/DestinationPicker.js";
import { RowsDisclosure } from "../shared/RowsDisclosure.js";
import { DownloadResultView, quickExportSpec } from "../shared/DownloadResultView.js";
import { ResultPanel } from "../shared/ResultPanel.js";
import { FreeformIntakeInput, type AiClient } from "../shared/FreeformIntakeInput.js";
import { ReconcileModule } from "./ReconcileModule.js";
import { QualifyModule } from "./QualifyModule.js";
import { IntakeHealthHome } from "./IntakeHealthHome.js";
import { EntityDrillDown } from "./EntityDrillDown.js";
import { AskCanonical } from "./AskCanonical.js";
import { RemediationQueue } from "./RemediationQueue.js";
import { FieldImportanceSettings } from "./FieldImportanceSettings.js";
import { useFieldImportanceOverrides } from "../shared/use-field-importance-overrides.js";
import { TradesSettings } from "./TradesSettings.js";
import { useTenantTrades } from "../shared/use-tenant-trades.js";
import {
  commitBundleToCanonical,
  type SupabaseLikeClient,
  type CommitResult,
  type StageCommitFn,
} from "../canonical/commit-canonical.js";
import {
  collectPreCommitWarnings,
  warningsFingerprint,
  filterResolvedWarnings,
  duplicateRowsKey,
  multiValueKey,
  type DuplicateRowsResolution,
  type MultiValueResolution,
} from "../shared/precommit-warnings.js";
import {
  useLiveDuplicateWarnings,
  liveDuplicateKey,
  skippedRowIndices,
} from "../shared/use-live-duplicate-warnings.js";
import { PrecommitQuestionQueue, type ResolvedLogEntry } from "../shared/PrecommitQuestionQueue.js";
import type { RoleName } from "../rollup/roles.js";

export interface IntakeModuleProps {
  /**
   * Authenticated Supabase client. Passed by the EQ Shell via getSupabase().
   * When omitted, the Into-EQ destination renders disabled with a "Configure
   * Supabase to enable" hint. The standalone Vite demo passes nothing.
   */
  supabase?: SupabaseLikeClient | null;
  /**
   * Tenant ID for canonical commits. In the per-tenant Supabase model the
   * shell reads this from env (VITE_TENANT_ID) and passes it down.
   */
  tenantId?: string;
  /**
   * The signed-in user to stamp as created_by on canonical commits — see
   * CommitOptions.createdBy. Required from EQ Shell: its tenant-data
   * `supabase` client never carries a real Supabase Auth session (identity
   * rides a bearer header instead), so commitBundleToCanonical's own
   * auth.getUser() fallback can never resolve a user there. The standalone
   * demo omits this — its mock client fakes auth.getUser() instead.
   */
  createdBy?: string;
  /**
   * Optional AI client for the freeform natural language input. When absent
   * the FreeformIntakeInput renders in preview-only mode with a notice.
   */
  ai?: AiClient | null;
  /**
   * Optional callback fired when the user picks a destination. Defaults to a
   * localStorage logger keyed `eq-intake:routes`.
   */
  onDestinationChange?: (
    value: string | undefined,
    source: "suggested" | "free_text",
  ) => void;
  /**
   * Whether the caller may flag a Sites duplicate pair for merge review (e.g.
   * from the Sites "Dupes" tab) — manager-only in eq-shell's role model. Only
   * affects the EntityDrillDown Sites view; the flag RPC is also gated
   * server-side, so this only controls whether the button renders.
   */
  canMergeSites?: boolean;
  /**
   * Whether the caller may start an import at all — controls visibility of
   * the "Bring Data In" tab and its Overview entry point. UI-layer only —
   * the actual write is still gated server-side by intake.commit on
   * /intake-stage and /intake-commit, so a caller who forced this open
   * couldn't commit anything anyway.
   */
  canImport?: boolean;
  /**
   * Whether the caller may edit a record that came in through an import,
   * archive or dismiss a duplicate, or work the review queue — eq-shell's
   * intake.edit_canonical (manager/supervisor). Threaded into
   * EntityDrillDown and RemediationQueue, and hides this module's own
   * field-importance/trades settings entry points (⚙/🔧) below — those are
   * edit surfaces, not read views.
   */
  canEditCanonical?: boolean;
  /**
   * When supplied, the "Into EQ" commit routes flagged/conflicting rows
   * through the host's staging/review-queue gate instead of writing them
   * straight to the canonical table — see StageCommitFn. The EQ Shell host
   * wires this to its /intake-stage function so this module's commit path
   * gets the same pre-commit check the per-domain importer already has. The
   * standalone Vite demo has no backend to stage against, so it omits this
   * and keeps the direct-RPC behaviour.
   */
  stageCommit?: StageCommitFn;
  /**
   * Whether the caller may use the go/no-go tender screening tab (plan
   * §C.1) — same server-gated boolean-prop pattern as canImport. UI-layer
   * only; the actual write is still gated by eq_intake_commit_qualification's
   * own tenant check regardless of this flag.
   */
  canQualifyTenders?: boolean;
  /**
   * Vision provider for the go/no-go tab's document extraction — a full
   * @eq/ai AIProvider, deliberately a separate prop from `ai` above (that
   * one is FreeformIntakeInput's own simpler AiClient shape, a different
   * interface). Omit to run the qualify tab manual-answers-only (see
   * QualifyModule's own hint when absent).
   */
  qualifyAi?: import("@eq/ai").AIProvider | null;
}

const ROUTE_LOG_KEY = "eq-intake:routes";

function defaultRouteLogger(
  value: string | undefined,
  source: "suggested" | "free_text",
): void {
  if (!value) return;
  try {
    const existing = localStorage.getItem(ROUTE_LOG_KEY);
    const log: Array<{ at: string; destination: string; source: string }> = existing
      ? JSON.parse(existing)
      : [];
    log.push({ at: new Date().toISOString(), destination: value, source });
    localStorage.setItem(ROUTE_LOG_KEY, JSON.stringify(log.slice(-200)));
  } catch {
    // localStorage full / disabled — silently skip
  }
}

type IntakeMode = "health" | "queue" | "import" | "ask" | "qualify";

function TabBadge({ count }: { count: number | null }): JSX.Element | null {
  if (!count) return null;
  return <span className="eq-intake-tab__badge">{count}</span>;
}

export function IntakeModule(props: IntakeModuleProps): JSX.Element {
  const onDestinationChange = useMemo(
    () => props.onDestinationChange ?? defaultRouteLogger,
    [props.onDestinationChange],
  );

  const bundle = useIntakeBundle();
  const [destId, setDestId] = useState<string>(INTO_EQ_ID);
  const [mode, setMode] = useState<IntakeMode>("health");
  const [drillEntity, setDrillEntity] = useState<string | null>(null);
  const [drillFilters, setDrillFilters] = useState<{ filters: AskFilter[]; label: string } | null>(null);
  /** Set when a Health Overview "Fix these" card is clicked for a specific
   * gap field (e.g. "phone") — tells EntityDrillDown to open straight into
   * the bulk-fill grid for that field instead of the full mixed gap list. */
  const [drillGapField, setDrillGapField] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTradesSettings, setShowTradesSettings] = useState(false);
  // Single fetch of the tenant's saved field-importance corrections — shared
  // by Overview's score, the Gaps filter, and the settings screen itself, so
  // changing a tier here is reflected everywhere without a page reload.
  const fieldImportance = useFieldImportanceOverrides(props.supabase);
  // Same one-fetch pattern for the tenant's added trades — shared by the
  // Trades settings screen and the Review Queue's trade dropdown.
  const tenantTrades = useTenantTrades(props.supabase);
  // Bring Data In's per-slot "Check for conflicts" panel — which slot (by
  // reference, see the render guard below) currently has ReconcileModule
  // open inline, or null when closed.
  const [reconcileSlot, setReconcileSlot] = useState<FileSlot | null>(null);
  // Bumped by any data-changing action taken in To Do (approve/archive a
  // queue item, merge a flagged duplicate) so Overview's health scores and
  // the To Do badge count don't go stale until someone happens to hit
  // Overview's own manual Refresh button.
  const [dataVersion, setDataVersion] = useState(0);
  const bumpDataVersion = useCallback(() => setDataVersion((v) => v + 1), []);

  // Reset drill-down / settings when switching away from health tab —
  // adjusted during render (not an effect) since this only needs to react to
  // `mode` changing, not run any I/O.
  const [prevMode, setPrevMode] = useState(mode);
  if (mode !== prevMode) {
    setPrevMode(mode);
    if (mode !== "health") {
      setDrillEntity(null);
      setDrillFilters(null);
      setDrillGapField(null);
      setShowSettings(false);
      setShowTradesSettings(false);
    }
  }

  // Lightweight To Do badge — how much is waiting across the three things
  // that now live in that one tab: site-advisory merges, contact-advisory
  // merges (both duplicates caught at the write, pending a human), and
  // steward remediation queue items. Fetched once independent of the tab's
  // own richer load, so the tab bar itself signals where attention is
  // needed before you click in.
  const [advisoryPending, setAdvisoryPending] = useState<number | null>(null);
  const [contactAdvisoryPending, setContactAdvisoryPending] = useState<number | null>(null);
  const [queuePending, setQueuePending] = useState<number | null>(null);
  const todoPending = advisoryPending === null && contactAdvisoryPending === null && queuePending === null
    ? null
    : (advisoryPending ?? 0) + (contactAdvisoryPending ?? 0) + (queuePending ?? 0);

  useEffect(() => {
    if (!props.supabase) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = props.supabase as any;

    readSiteAdvisory(sb)
      .then((s) => { if (!cancelled) setAdvisoryPending(s.pending); })
      .catch(() => { /* non-critical — badge just stays hidden */ });

    readContactAdvisory(sb)
      .then((s) => { if (!cancelled) setContactAdvisoryPending(s.pending); })
      .catch(() => { /* non-critical — badge just stays hidden */ });

    sb.rpc("eq_queue_list")
      .then(({ data }: { data: unknown }) => {
        if (!cancelled) setQueuePending(Array.isArray(data) ? data.length : null);
      })
      .catch(() => { /* non-critical — badge just stays hidden */ });

    return () => { cancelled = true; };
  }, [props.supabase, dataVersion]);

  const exportDest = useMemo(() => findQuickDestination(destId), [destId]);
  const isCanonical = destId === INTO_EQ_ID;

  return (
    <section className="eq-intake-module">
      {/* Mode toggle — Overview (default, was Health) / To Do (was Queue) /
          Bring Data In (was Import) / Ask. Reconcile already lives inline
          under Bring Data In (per-file-slot "Check for conflicts", below) —
          it was never a fifth top-level tab here. */}
      <div className="eq-intake-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "health"}
          className={"eq-intake-tab" + (mode === "health" ? " eq-intake-tab--active" : "")}
          onClick={() => setMode("health")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "queue"}
          className={"eq-intake-tab" + (mode === "queue" ? " eq-intake-tab--active" : "")}
          onClick={() => { setDrillEntity(null); setMode("queue"); }}
        >
          To Do
          <TabBadge count={todoPending} />
        </button>
        {props.canImport && (
          <button
            type="button"
            role="tab"
            aria-selected={mode === "import"}
            className={"eq-intake-tab" + (mode === "import" ? " eq-intake-tab--active" : "")}
            onClick={() => { setDrillEntity(null); setMode("import"); }}
          >
            Bring Data In
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={mode === "ask"}
          className={"eq-intake-tab" + (mode === "ask" ? " eq-intake-tab--active" : "")}
          onClick={() => { setDrillEntity(null); setMode("ask"); }}
        >
          Ask
        </button>
        {props.canQualifyTenders && (
          <button
            type="button"
            role="tab"
            aria-selected={mode === "qualify"}
            className={"eq-intake-tab" + (mode === "qualify" ? " eq-intake-tab--active" : "")}
            onClick={() => { setDrillEntity(null); setMode("qualify"); }}
          >
            Go/No-Go
          </button>
        )}

        {props.canEditCanonical && (
          <button
            type="button"
            className="eq-intake-tab__settings"
            title="Field importance settings"
            aria-label="Field importance settings"
            onClick={() => { setMode("health"); setDrillEntity(null); setShowTradesSettings(false); setShowSettings(true); }}
          >
            ⚙
          </button>
        )}
        {props.canEditCanonical && (
          <button
            type="button"
            className="eq-intake-tab__settings"
            title="Trades settings"
            aria-label="Trades settings"
            onClick={() => { setMode("health"); setDrillEntity(null); setShowSettings(false); setShowTradesSettings(true); }}
          >
            🔧
          </button>
        )}
      </div>

      {mode === "health" ? (
        showSettings ? (
          <FieldImportanceSettings
            overridesState={fieldImportance}
            onBack={() => setShowSettings(false)}
          />
        ) : showTradesSettings ? (
          <TradesSettings
            tradesState={tenantTrades}
            onBack={() => setShowTradesSettings(false)}
          />
        ) : drillEntity !== null ? (
          <EntityDrillDown
            entity={drillEntity}
            supabase={props.supabase}
            tenantId={props.tenantId}
            initialMode="tidy"
            initialFilters={drillFilters?.filters}
            initialFilterLabel={drillFilters?.label}
            initialGapField={drillGapField}
            onBack={() => { setDrillEntity(null); setDrillFilters(null); setDrillGapField(null); }}
            canMergeSites={props.canMergeSites}
            canEditCanonical={props.canEditCanonical}
            fieldImportanceOverrides={fieldImportance.overrides}
          />
        ) : (
          <IntakeHealthHome
            supabase={props.supabase}
            tenantId={props.tenantId}
            onEntityClick={(e, field) => { setDrillEntity(e); setDrillFilters(null); setDrillGapField(field ?? null); }}
            fieldImportanceOverrides={fieldImportance.overrides}
            onBringDataIn={props.canImport ? () => setMode("import") : undefined}
            refreshSignal={dataVersion}
          />
        )
      ) : mode === "queue" ? (
        <RemediationQueue
          supabase={props.supabase}
          canMergeSites={props.canMergeSites}
          canEditCanonical={props.canEditCanonical}
          tenantTrades={tenantTrades.trades}
          onDataChanged={bumpDataVersion}
        />
      ) : mode === "ask" ? (
        <AskCanonical
          supabase={props.supabase}
          onEntityClick={(e, filters, label) => {
            setDrillEntity(e);
            setDrillFilters(filters && filters.length > 0 ? { filters, label: label ?? "" } : null);
            setMode("health");
          }}
        />
      ) : mode === "qualify" ? (
        <QualifyModule supabase={props.supabase} tenantId={props.tenantId} ai={props.qualifyAi} />
      ) : (
        <>
          <h2>Bring something in</h2>
          <p>Drop a file — we'll work out what it is and bring it into EQ.</p>

          <IntakeDropZone
            bundle={bundle}
            onCheckConflicts={(slot) => setReconcileSlot(slot)}
          />

          {/* Tracked by object reference, not index — removing an earlier
              slot shifts indices, and a stale index could silently point at
              the wrong file. bundle.slots.includes() drops the panel if the
              slot it was opened for gets removed while open. */}
          {reconcileSlot && bundle.slots.includes(reconcileSlot) && reconcileSlot.sheet && (
            <div className="eq-intake-reconcile-panel">
              <ReconcileModule
                supabase={props.supabase}
                tenantId={props.tenantId}
                createdBy={props.createdBy}
                initialSlot={{ sheet: reconcileSlot.sheet, entity: reconcileSlot.role }}
                onClose={() => setReconcileSlot(null)}
              />
            </div>
          )}

          <FreeformIntakeInput ai={props.ai} />

          {bundle.slots.length > 0 && (
            <>
              <DestinationPicker
                destId={destId}
                bundle={bundle}
                onChange={(id) => {
                  setDestId(id);
                  onDestinationChange(id, "suggested");
                }}
              />

              {isCanonical ? (
                props.tenantId ? (
                  <CommitView
                    bundle={bundle}
                    supabase={props.supabase}
                    tenantId={props.tenantId}
                    createdBy={props.createdBy}
                    stageCommit={props.stageCommit}
                    onViewEntity={(entity) => {
                      setDrillEntity(entity);
                      setDrillFilters(null);
                      setMode("health");
                    }}
                    onViewQueue={() => { setDrillEntity(null); setMode("queue"); }}
                    onReset={() => { bundle.reset(); setReconcileSlot(null); }}
                  />
                ) : (
                  <div className="eq-intake-info-strip">
                    Missing tenant — can't commit here until this is fixed.
                  </div>
                )
              ) : (
                exportDest && (
                  <DownloadResultView
                    spec={quickExportSpec(exportDest, bundle)}
                    onReset={() => { bundle.reset(); setReconcileSlot(null); }}
                  />
                )
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}


// ============================================================================
// COMMIT VIEW — Into EQ (canonical commit). Save straight through, then
// ResultPanel + flagged/rejected per-row drill-downs — matches the build
// spec's decision #2 ("save, then show the result"); rollback is one click
// if something's wrong. The one exception: a shaky classification or a
// likely multi-value cell (see shared/precommit-warnings.ts) requires an
// explicit checkbox acknowledgment before Save enables, same bar
// @eq/confirm-ui's MappingTable already holds its own users to.
// ============================================================================

type CommitBundle = {
  customer?: ParsedSheet;
  site?: ParsedSheet;
  contact?: ParsedSheet;
  staff?: ParsedSheet;
  licence?: ParsedSheet;
};

function CommitView({
  bundle,
  supabase,
  tenantId,
  createdBy,
  stageCommit,
  onViewEntity,
  onViewQueue,
  onReset,
}: {
  bundle: IntakeBundle;
  supabase?: SupabaseLikeClient | null;
  tenantId: string;
  createdBy?: string;
  stageCommit?: StageCommitFn;
  onViewEntity: (entity: string) => void;
  onViewQueue: () => void;
  onReset: () => void;
}): JSX.Element {
  const enabled = !!supabase;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [sourceFilename, setSourceFilename] = useState("");

  // Per-role, per-header manual mapping overrides — how a human answers
  // "which column is X?" when previewUnmappedRequiredFields flags a required
  // field nothing mapped to. Keyed by header (matching inferMapping()'s own
  // shape) so it merges directly into commitBundleToCanonical's manualMapping
  // option; at most one header may point at a given field within one role,
  // enforced by setManualPick below, not by this state's type.
  const [manualMappings, setManualMappings] = useState<Partial<Record<RoleName, Record<string, string | null>>>>({});

  // Running trail of answered questions, oldest first — purely presentational
  // (PrecommitQuestionQueue's "✓ ..." list), never read back for logic. Each
  // resolver below appends one entry when it fires.
  const [resolvedLog, setResolvedLog] = useState<ResolvedLogEntry[]>([]);
  const logResolved = useCallback((key: string, summary: string) => {
    setResolvedLog((prev) => [...prev, { key, summary }]);
  }, []);

  const setManualPick = useCallback((role: RoleName, field: string, header: string | null) => {
    setManualMappings((prev) => {
      const roleMap = { ...(prev[role] ?? {}) };
      for (const h of Object.keys(roleMap)) {
        if (roleMap[h] === field) delete roleMap[h];
      }
      if (header) roleMap[header] = field;
      return { ...prev, [role]: roleMap };
    });
    if (header) {
      logResolved(`map:${role}:${field}`, `Mapped "${header}" → ${field.replace(/_/g, " ")}`);
    }
  }, [logResolved]);

  // Per-role, per-row resolution of a duplicate_existing warning — "skip"
  // (already in EQ — exclude this row from the commit) or "keep" (different
  // record — dismiss the warning). Keyed by liveDuplicateKey(role, rowIndex).
  const [duplicateResolutions, setDuplicateResolutions] = useState<Record<string, "skip" | "keep">>({});
  const resolveDuplicate = useCallback((role: RoleName, rowIndex: number, action: "skip" | "keep") => {
    setDuplicateResolutions((prev) => ({ ...prev, [liveDuplicateKey(role, rowIndex)]: action }));
    logResolved(
      liveDuplicateKey(role, rowIndex),
      action === "skip"
        ? `Skipped row ${rowIndex + 1} — already in EQ`
        : `Kept row ${rowIndex + 1} — different record`,
    );
  }, [logResolved]);

  // Per-role, per-row-pair resolution of a duplicate_rows (within-file)
  // question — "merge" drops the LATER row (rowIndices[1]) from the commit,
  // "keep_both" just dismisses the question. Keyed duplicateRowsKey(role, pair).
  const [duplicateRowsResolutions, setDuplicateRowsResolutions] = useState<Record<string, DuplicateRowsResolution>>({});
  const resolveDuplicateRows = useCallback(
    (role: RoleName, rowIndices: [number, number], action: DuplicateRowsResolution) => {
      const key = duplicateRowsKey(role, rowIndices);
      setDuplicateRowsResolutions((prev) => ({ ...prev, [key]: action }));
      logResolved(
        key,
        action === "merge"
          ? `Merged rows ${rowIndices[0] + 1} and ${rowIndices[1] + 1}`
          : `Kept rows ${rowIndices[0] + 1} and ${rowIndices[1] + 1} — different records`,
      );
    },
    [logResolved],
  );

  // Per-slot, per-field resolution of a multi_value question — "split" fans
  // every affected row in that column into one row per comma-separated value
  // at commit time (commitBundleToCanonical's splitFields), "keep_combined"
  // just dismisses the question (today's existing default behaviour).
  // Keyed multiValueKey(slotLabel, field) — multi_value carries no role.
  const [splitResolutions, setSplitResolutions] = useState<Record<string, MultiValueResolution>>({});
  const resolveMultiValue = useCallback((slotLabel: string, field: string, action: MultiValueResolution) => {
    const key = multiValueKey(slotLabel, field);
    setSplitResolutions((prev) => ({ ...prev, [key]: action }));
    logResolved(
      key,
      action === "split"
        ? `Split "${field.replace(/_/g, " ")}" into separate rows`
        : `Kept "${field.replace(/_/g, " ")}" as one combined value`,
    );
  }, [logResolved]);

  // Rows that look like a record already saved in EQ — separate from the
  // four in-file-only warnings below since it needs a live read (see
  // shared/use-live-duplicate-warnings.ts); non-critical on failure, so it
  // never blocks the rest of the gate.
  const liveDuplicateWarnings = useLiveDuplicateWarnings(
    supabase,
    bundle.slots,
    manualMappings,
    duplicateResolutions,
  );

  // Pre-commit review gate — shaky classifications, likely multi-value
  // cells, required fields no column filled, in-file near-duplicates, and
  // rows that look like an existing EQ record, aggregated across every slot
  // and filtered down to whatever's still unresolved. Mirrors @eq/confirm-ui's
  // MappingTable checkbox-acknowledgment pattern, since eq-shell's real
  // intake pipeline never renders MappingTable itself. Re-derived every
  // render, so adding/removing/reclassifying a file, or answering a
  // question, always reflects the current set, not a stale snapshot.
  const allWarnings = useMemo(
    () =>
      filterResolvedWarnings(
        [...collectPreCommitWarnings(bundle.slots, manualMappings), ...liveDuplicateWarnings],
        duplicateRowsResolutions,
        splitResolutions,
      ),
    [bundle.slots, manualMappings, liveDuplicateWarnings, duplicateRowsResolutions, splitResolutions],
  );
  // low_confidence is deliberately excluded from the sequential queue — it
  // already resolves inline via DetectionLine where the file was dropped,
  // and showing it again here with no button of its own would just be an
  // unanswerable second copy of the same question. It still counts toward
  // the gate below (allWarnings), so Save stays blocked until it resolves
  // too, same as today.
  const queueWarnings = useMemo(
    () => allWarnings.filter((w) => w.kind !== "low_confidence"),
    [allWarnings],
  );
  const warningsKey = useMemo(() => warningsFingerprint(allWarnings), [allWarnings]);
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const warningsAcknowledged = allWarnings.length === 0 || acknowledgedKey === warningsKey;
  const saveBlocked = allWarnings.length > 0 && !warningsAcknowledged;

  const commit = async () => {
    if (!supabase) return;
    setError(null);
    setResult(null);

    const commitBundle: CommitBundle = {};
    for (const slot of bundle.slots) {
      if (slot.role === "unknown" || !slot.sheet) continue;
      const key = slot.role as keyof CommitBundle;
      if (commitBundle[key]) {
        setError(`Two files look like ${slot.role}s. Remove one before saving.`);
        return;
      }
      // Rows resolved "skip" on a duplicate_existing question (already in EQ
      // under a different spelling), plus the later row of any duplicate_rows
      // pair resolved "merge", never reach the commit RPC at all.
      const skip = skippedRowIndices(slot.role, duplicateResolutions);
      for (const [pairKey, action] of Object.entries(duplicateRowsResolutions)) {
        if (action !== "merge") continue;
        const [pairRole, , laterStr] = pairKey.split(":");
        if (pairRole === slot.role) skip.add(Number(laterStr));
      }
      commitBundle[key] = skip.size === 0
        ? slot.sheet
        : { ...slot.sheet, rows: slot.sheet.rows.filter((_, i) => !skip.has(i)) };
    }
    if (
      !commitBundle.customer &&
      !commitBundle.site &&
      !commitBundle.contact &&
      !commitBundle.staff &&
      !commitBundle.licence
    ) {
      setError("Drop at least one file we recognise — a customer, site, contact, staff, or licence list.");
      return;
    }

    const filename = bundle.slots
      .filter((s) => s.role !== "unknown")
      .map((s) => s.file.name)
      .join("+");

    // Fields resolved "split", grouped by role — multi_value questions are
    // keyed by slotLabel (they carry no role of their own), so resolve each
    // back to its slot's role via bundle.slots before handing it to
    // commitBundleToCanonical, which needs it keyed by CanonicalEntity.
    const splitFields: Partial<Record<RoleName, string[]>> = {};
    for (const [key, action] of Object.entries(splitResolutions)) {
      if (action !== "split") continue;
      const separatorIdx = key.lastIndexOf(":");
      const slotLabel = key.slice(0, separatorIdx);
      const field = key.slice(separatorIdx + 1);
      const owningSlot = bundle.slots.find((s) => s.file.name === slotLabel && s.role !== "unknown");
      if (!owningSlot) continue;
      const role = owningSlot.role as RoleName;
      (splitFields[role] ??= []).push(field);
    }

    setBusy(true);
    setProgressMsg(null);
    try {
      const commitResult = await commitBundleToCanonical({
        supabase,
        bundle: commitBundle,
        tenantId,
        createdBy,
        manualMapping: manualMappings,
        splitFields,
        sourceFilename: filename,
        onProgress: (msg) => setProgressMsg(msg),
        stageCommit,
      });
      setSourceFilename(filename);
      setResult(commitResult);
      setProgressMsg(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!enabled && (
        <div className="eq-intake-info-strip">
          EQ isn't connected yet — ask whoever set this up to fill in the
          connection details. Saving stays inactive until then.
        </div>
      )}

      {progressMsg && (
        <div className="eq-intake-progress">
          <span className="eq-spinner__dot" style={{ width: 10, height: 10, flexShrink: 0 }} />
          {progressMsg}
        </div>
      )}

      {error && (
        <div role="alert" className="eq-intake-alert">
          {error}
        </div>
      )}

      {!result && (
        <PrecommitQuestionQueue
          warnings={queueWarnings}
          resolvedLog={resolvedLog}
          manualMappings={manualMappings}
          onPickColumn={setManualPick}
          onResolveDuplicateExisting={resolveDuplicate}
          onResolveDuplicateRows={resolveDuplicateRows}
          onResolveMultiValue={resolveMultiValue}
        />
      )}

      {/* Power-user escape hatch — same underlying gate as before (one
          acknowledgment unblocks Save regardless of what's still open), just
          de-emphasised now that answering each question is the guided,
          primary path instead of the only one. Nothing lost, only reordered:
          a messy file with many flags no longer requires clicking through
          every single one just to get past the gate. */}
      {!result && allWarnings.length > 0 && !warningsAcknowledged && (
        <button
          type="button"
          className="eq-qa-queue__save-anyway"
          onClick={() => setAcknowledgedKey(warningsKey)}
        >
          Skip the questions — save anyway
        </button>
      )}

      {!result && (
        <button
          type="button"
          onClick={commit}
          disabled={!enabled || busy || saveBlocked}
          title={saveBlocked ? "Check the warnings above before saving." : undefined}
          className="eq-intake-btn-primary"
        >
          {busy ? (
            <span className="eq-intake-btn-spinner">
              <span className="eq-spinner__dot" style={{ width: 10, height: 10 }} />
              Saving…
            </span>
          ) : (
            "Save into EQ"
          )}
        </button>
      )}

      {result && (
        <ResultPanel
          result={result}
          sourceFilename={sourceFilename}
          onViewEntity={onViewEntity}
          onViewQueue={onViewQueue}
          onReset={onReset}
        />
      )}

      {/* Per-row drill-downs for anything that needs eyes. When staging is
          active we can't tell, per row, whether a flagged row actually
          committed or got parked in the review queue instead — the stage
          response only gives per-batch totals — so the hint stays accurate
          either way rather than asserting "these are in EQ". */}
      {result?.perEntity.some((r) => r.flaggedRows.length > 0) && (
        <RowsDisclosure
          label="Show rows that need checking"
          hint={
            result.perEntity.some((r) => r.stagedCount > 0)
              ? "Something caught our eye on these rows. Some may have saved, others may be waiting in the review queue — check there if you don't see one here yet."
              : "These rows are in EQ, but something caught our eye. Review each one before relying on it."
          }
          accentColor="var(--eq-warn)"
          hintColor="var(--eq-ink)"
          perEntity={result.perEntity.map((r) => ({
            entity: r.entity,
            rows: r.flaggedRows,
          }))}
          onFixRow={onViewEntity}
        />
      )}

      {result?.perEntity.some((r) => r.rejectedRows.length > 0) && (
        <RowsDisclosure
          label="Show rows that couldn't save — and why"
          accentColor="var(--eq-ink)"
          showDownload
          downloadFilename="eq-rejected-rows.csv"
          perEntity={result.perEntity.map((r) => ({
            entity: r.entity,
            rows: r.rejectedRows,
          }))}
        />
      )}
    </div>
  );
}

// UnmappedFieldPicker and ExistingDuplicateResolver now live in
// ../shared/PrecommitQuestionQueue.tsx, alongside the sequential queue that
// renders them — see that file.
