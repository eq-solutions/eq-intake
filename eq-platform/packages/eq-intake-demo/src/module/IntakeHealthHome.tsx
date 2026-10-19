import { useState, useEffect, type JSX, type ReactNode } from "react";
import {
  computeHealthScores,
  runLicenceExpiryCheck,
  runOrphanCheck,
  computeComplianceMetrics,
  detectAllDuplicates,
  decayCheck,
  buildOverviewWork,
} from "@eq/intake";
import type {
  HealthScore,
  LicenceExpiryAlertSummary,
  ComplianceMetrics,
  DuplicateReport,
  DecaySummary,
  FieldImportanceOverride,
  RecordSummary,
  WorkItem,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { entityLabel, fieldLabel } from "../shared/entity-label.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface IntakeHealthHomeProps {
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  /** field is set when the click originated from a specific gap ("N missing
   * Phone") card, so the drill-down can open straight into a bulk-fill grid
   * for that one field instead of the full mixed gap list. */
  onEntityClick?: (entity: string, field?: string) => void;
  /** Tenant's saved field-importance corrections — see IntakeModule's fetch. */
  fieldImportanceOverrides?: FieldImportanceOverride[];
  /**
   * Called when the user taps the empty-state CTA ("Bring your first file
   * in") on a brand-new tenant with zero records anywhere. Typically wired
   * to switch the host's tab to Bring Data In. Omit to hide the button.
   */
  onBringDataIn?: () => void;
  /**
   * Bumped by the host on any data-changing action taken elsewhere (To Do
   * approvals/archives, site/contact merges) so this screen's numbers don't
   * go stale until someone remembers to hit the manual Refresh button.
   */
  refreshSignal?: number;
  /** Shown between the headline and the lists, e.g. the guided tidy invitation. */
  topSlot?: ReactNode;
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface OrphanSummary {
  assets_no_site_count:     number;
  contacts_no_parent_count: number;
  licences_no_staff_count:  number;
  sites_no_customer_count:  number;
  total:                    number;
}

/** Shared status vocabulary for every row in the unified checks list — one
 * colour language instead of the four slightly-different badge/fill/dot
 * palettes the previous layout accumulated across its five section types. */
type RowStatus = "ok" | "warn" | "err" | "info" | "neutral";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * One row in the unified checks list. Every entity-completeness row and
 * every data-quality check (licences, broken links, duplicates, record age)
 * renders through this single component instead of five differently-shaped
 * card/strip/grid layouts — same status-dot + label + result language
 * throughout, so reading one row teaches you how to read all of them.
 */
function CheckRow({
  status, label, meta, summary, progress, detail, onClick, action, ariaLabel,
}: {
  status:     RowStatus;
  label:      string;
  meta?:      string;
  summary?:   ReactNode;
  /** 0–1 — renders a thin progress bar under the row when set. */
  progress?:  number;
  detail?:    ReactNode;
  /** Present only for rows that drill into a single entity (records rows). */
  onClick?:   () => void;
  /** Trailing control, e.g. an on-demand "Scan" button. */
  action?:    ReactNode;
  ariaLabel?: string;
}): JSX.Element {
  const barClass = `eq-health-row-bar--${status}`;

  const body = (
    <>
      <span className={`eq-health-row-dot eq-health-row-dot--${status}`} aria-hidden="true" />
      <div className="eq-health-row-main">
        <div className="eq-health-row-top">
          <span className="eq-health-row-label">{label}</span>
          {meta && <span className="eq-health-row-meta">{meta}</span>}
          {summary && <span className="eq-health-row-summary">{summary}</span>}
        </div>
        {progress !== undefined && (
          <div className="eq-health-row-bar-wrap">
            <div className={`eq-health-row-bar ${barClass}`} style={{ width: pct(progress) }} />
          </div>
        )}
        {detail && <div className="eq-health-row-detail">{detail}</div>}
      </div>
      {action && <div className="eq-health-row-action">{action}</div>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="eq-health-row eq-health-row--clickable" onClick={onClick} aria-label={ariaLabel}>
        {body}
      </button>
    );
  }
  return <div className="eq-health-row" aria-label={ariaLabel}>{body}</div>;
}

/**
 * An on-demand check that starts unscanned (a Scan/Check button, gated by a
 * busy flag), then resolves to either an all-clear row or a row with a
 * severity + detail. Shared by Duplicates and Record age — the two checks
 * that run on demand rather than automatically.
 */
function ScanCheckRow({
  label, notYetRun, busy, onScan, verb, verbing, notYetLabel, empty, emptyLabel, severity, summary, detail,
}: {
  label:       string;
  notYetRun:   boolean;
  busy:        boolean;
  onScan:      () => void;
  verb:        string;
  verbing:     string;
  notYetLabel: string;
  empty:       boolean;
  emptyLabel:  string;
  severity:    RowStatus;
  summary:     ReactNode;
  detail:      ReactNode;
}): JSX.Element {
  if (notYetRun) {
    return (
      <CheckRow
        status="neutral"
        label={label}
        summary={notYetLabel}
        detail="Checks every record — takes a moment on a large dataset"
        action={
          <button type="button" className="eq-intake-btn-ghost" onClick={onScan} disabled={busy}>
            {busy ? verbing : verb}
          </button>
        }
      />
    );
  }
  if (empty) {
    return <CheckRow status="ok" label={label} summary={emptyLabel} />;
  }
  return <CheckRow status={severity} label={label} summary={summary} detail={detail} />;
}

/**
 * One clickable-if-handler-present badge — the shared shape every detail
 * builder below needs (orphans/duplicates/decay each surface a per-entity
 * badge that drills down when a handler is given, and is inert text when
 * it isn't).
 */
function EntityBadge({
  text, cls, title, entity, onEntityClick,
}: { text: string; cls: string; title: string; entity: string; onEntityClick?: (entity: string) => void }): JSX.Element {
  return onEntityClick ? (
    <button
      type="button"
      className={`eq-health-badge ${cls} eq-health-orphan__btn`}
      onClick={() => onEntityClick(entity)}
      title={title}
    >
      {text}
    </button>
  ) : (
    <span className={`eq-health-badge ${cls}`} title={title}>{text}</span>
  );
}

function duplicateDetail(
  report: DuplicateReport[], onEntityClick?: (entity: string) => void,
): ReactNode {
  return (
    <>
      {report
        .filter((r) => r.clusters.length > 0)
        .map((r) => {
          // "Needs reconcile" is the actionable subset — a duplicate whose live
          // state disagrees with the survivor pick (the SY9 shape: the correct
          // row retired, or data split across active copies). Lead with that
          // count and colour it danger; fall back to the raw dupe count.
          const needs = r.needs_reconcile ?? 0;
          const danger = needs > 0;
          const text = danger
            ? `${needs} to reconcile in ${r.entity}`
            : `${r.clusters.length} possible duplicate${r.clusters.length !== 1 ? "s" : ""} in ${r.entity}`;
          const cls = danger ? "eq-health-badge--critical" : "eq-health-badge--warning";
          const tip = danger
            ? `${r.clusters.length} duplicate group${r.clusters.length !== 1 ? "s" : ""} · ${needs} need a survivor chosen — open ${r.entity}`
            : `Open ${r.entity} drill-down`;
          return (
            <EntityBadge
              key={r.entity}
              text={text}
              cls={cls}
              title={tip}
              entity={r.entity}
              onEntityClick={onEntityClick}
            />
          );
        })}
    </>
  );
}

function decayDetail(
  report: DecaySummary[], onEntityClick?: (entity: string) => void,
): ReactNode {
  return (
    <>
      {report
        .filter((r) => r.aging + r.stale + r.very_stale > 0)
        .map((r) => {
          const label    = entityLabel(r.entity);
          const severity = r.very_stale > 0 ? "err" : r.stale > 0 ? "warning" : "info";
          const worst    = r.very_stale > 0
            ? `${r.very_stale} very stale`
            : r.stale > 0
            ? `${r.stale} stale`
            : `${r.aging} aging`;
          const tip = r.stalest[0]
            ? `Oldest: ${r.stalest[0].label} (${r.stalest[0].days_since}d)`
            : `${r.oldest_days}d since last update`;
          const text = `${label}: ${worst}, oldest ${r.oldest_days}d`;

          return (
            <EntityBadge
              key={r.entity}
              text={text}
              cls={`eq-health-badge--${severity}`}
              title={tip}
              entity={r.entity}
              onEntityClick={onEntityClick}
            />
          );
        })}
    </>
  );
}

function recordRow(
  r: RecordSummary, onEntityClick: ((entity: string, field?: string) => void) | undefined,
): ReactNode {
  const label = entityLabel(r.entity);

  if (!r.started) {
    return (
      <CheckRow
        key={r.entity}
        status="neutral"
        label={label}
        meta="0 records"
        summary="Not started"
        onClick={onEntityClick ? () => onEntityClick(r.entity) : undefined}
        ariaLabel={`${label} — no records yet`}
      />
    );
  }

  // Never "complete" while anything is missing: the status and words come from
  // what is actually left to fix, not from a percentage.
  const status: RowStatus =
    r.toFix > 0 ? (r.gaps.some((g) => g.tier === "critical") ? "err" : "warn")
    : r.partlyChecked ? "neutral" : "ok";
  const summary = r.partlyChecked ? "Partly checked" : r.toFix === 0 ? "Nothing to fix" : `${r.toFix} to fix`;

  const detail = (r.gaps.length > 0 || r.partlyChecked) && (
    <>
      {r.gaps.length > 0 && (
        <div className="eq-health-card__gaps">
          <span className="eq-health-card__gaps-label">Missing:</span>
          {r.gaps.map((g) => (
            <span
              key={g.field}
              className={`eq-health-badge ${g.tier === "critical" ? "eq-health-badge--critical" : "eq-health-badge--warning"}`}
            >
              {fieldLabel(g.field)} · {g.count}
            </span>
          ))}
        </div>
      )}
      {r.partlyChecked && (
        <p className="eq-health-card__low-sample">Some checks are skipped for your role.</p>
      )}
    </>
  );

  return (
    <CheckRow
      key={r.entity}
      status={status}
      label={label}
      meta={`${r.total.toLocaleString()} record${r.total === 1 ? "" : "s"}`}
      summary={summary}
      detail={detail || undefined}
      onClick={onEntityClick ? () => onEntityClick(r.entity) : undefined}
      ariaLabel={`${label} — ${summary}`}
    />
  );
}

function WorkRow({
  item, onEntityClick,
}: { item: WorkItem; onEntityClick?: (entity: string, field?: string) => void }): JSX.Element {
  return (
    <div className="eq-work-row">
      <div className="eq-work-row__main">
        <p className="eq-work-row__title">
          {item.title}
          {item.tag && (
            <span className={`eq-work-tag eq-work-tag--${item.tag.tone}`}>{item.tag.text}</span>
          )}
        </p>
        <p className="eq-work-row__detail">{item.detail}</p>
      </div>
      <button
        type="button"
        className="eq-intake-btn-ghost eq-work-row__btn"
        onClick={onEntityClick ? () => onEntityClick(item.entity, item.field) : undefined}
        disabled={!onEntityClick}
      >
        {item.actionLabel}
      </button>
    </div>
  );
}

const WORK_VISIBLE = 3;

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function IntakeHealthHome({
  supabase,
  tenantId,
  onEntityClick,
  fieldImportanceOverrides,
  onBringDataIn,
  refreshSignal,
  topSlot,
}: IntakeHealthHomeProps): JSX.Element {
  const [scores,     setScores]     = useState<HealthScore[] | null>(null);
  const [licences,   setLicences]   = useState<LicenceExpiryAlertSummary | null>(null);
  const [orphans,    setOrphans]    = useState<OrphanSummary | null>(null);
  const [compliance, setCompliance] = useState<ComplianceMetrics | null>(null);
  const [dupes,      setDupes]      = useState<DuplicateReport[] | null>(null);
  const [dupesBusy,  setDupesBusy]  = useState(false);
  const [decay,      setDecay]      = useState<DecaySummary[] | null>(null);
  const [decayBusy,  setDecayBusy]  = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // Bumped by the Refresh button to re-run the load effect on demand — the
  // numbers here go stale after adjudicating/merging/approving elsewhere,
  // and previously the only way to see updated ones was leaving the tab and
  // coming back (which remounts the component).
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!supabase || !tenantId) return;

    let cancelled = false;

    // Deferred a tick so setLoading/setError below don't run synchronously
    // inside this effect's body — satisfies react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      setLoading(true);
      setError(null);

      // The demo's SupabaseLikeClient is narrower than @eq/intake's (no select).
      // At runtime the actual client has select — this cast is safe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;

      Promise.allSettled([
        computeHealthScores(sb, fieldImportanceOverrides),
        runLicenceExpiryCheck(sb, tenantId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runOrphanCheck({ supabase: supabase as any, tenantId }),
        computeComplianceMetrics(sb),
      ]).then(([healthResult, licenceResult, orphanResult, complianceResult]) => {
        if (cancelled) return;

        if (healthResult.status === "fulfilled") {
          setScores(healthResult.value);
        } else {
          setError(
            healthResult.reason instanceof Error
              ? healthResult.reason.message
              : String(healthResult.reason),
          );
        }

        if (licenceResult.status === "fulfilled") {
          setLicences(licenceResult.value);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            "[IntakeHealthHome] Licence expiry check failed:",
            licenceResult.reason instanceof Error
              ? licenceResult.reason.message
              : licenceResult.reason,
          );
        }

        if (orphanResult.status === "fulfilled") {
          setOrphans(orphanResult.value.summary);
        }

        if (complianceResult.status === "fulfilled") {
          setCompliance(complianceResult.value);
        }
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });

    return () => { cancelled = true; };
  }, [supabase, tenantId, refreshTick, refreshSignal, fieldImportanceOverrides]);

  if (!supabase) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice">Connect EQ to see your data health</div>
      </section>
    );
  }

  if (!tenantId) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice">Missing tenant — can't show health data here.</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice eq-health-notice--err" role="alert">{error}</div>
      </section>
    );
  }

  // A brand-new tenant with nothing imported anywhere yet — every entity
  // shows `started: false`. Showing six 0%-filled dimension bars here reads
  // as "your data is bad" when the truth is "you haven't brought anything
  // in yet" — a completely different message that needs a completely
  // different screen: a way in, not a score to fix.
  const allEmpty = scores !== null && scores.every((s) => !s.started);

  if (allEmpty) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-empty">
          <p className="eq-health-empty__title">Nothing in EQ yet</p>
          <p className="eq-health-empty__body">
            Bring in your first file — customers, sites, contacts, staff, or
            licences — and this page will start tracking your data quality
            automatically.
          </p>
          {onBringDataIn && (
            <button type="button" className="eq-intake-btn-primary" onClick={onBringDataIn}>
              Bring your first file in →
            </button>
          )}
        </div>
      </section>
    );
  }

  const work = buildOverviewWork({
    scores, licences, compliance, orphans, dupes,
    overrides: fieldImportanceOverrides,
    labels: { entity: entityLabel, field: fieldLabel },
  });

  const scanDuplicates = async () => {
    if (!supabase || dupesBusy) return;
    setDupesBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await detectAllDuplicates(supabase as any);
      setDupes(report);
    } catch {
      // non-critical — silently skip
    } finally {
      setDupesBusy(false);
    }
  };

  const scanDecay = async () => {
    if (!supabase || decayBusy) return;
    setDecayBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await decayCheck(supabase as any);
      setDecay(report);
    } catch {
      // non-critical — silently skip
    } finally {
      setDecayBusy(false);
    }
  };

  // ---- duplicates row -------------------------------------------------------
  const dupeTotal = dupes?.reduce((n, r) => n + r.clusters.length, 0) ?? 0;
  const dupeNeedsReconcile = dupes?.some((r) => (r.needs_reconcile ?? 0) > 0) ?? false;
  const duplicatesRow = (
    <ScanCheckRow
      label="Duplicates (full scan)"
      notYetRun={dupes === null}
      busy={dupesBusy}
      onScan={scanDuplicates}
      verb="Scan"
      verbing="Scanning…"
      notYetLabel="Not scanned yet — separate from the live duplicate queue in To Do"
      empty={dupeTotal === 0}
      emptyLabel="None found"
      severity={dupeNeedsReconcile ? "err" : "warn"}
      summary={`${dupeTotal} possible`}
      detail={dupes ? duplicateDetail(dupes, onEntityClick) : null}
    />
  );

  // ---- record age (decay) row ----------------------------------------------
  // Same 3-way severity decayDetail already uses per entity (very_stale beats
  // stale beats aging-only) — so the row's own dot never disagrees with the
  // badges inside its own detail.
  const anyStale     = decay?.some((r) => r.aging + r.stale + r.very_stale > 0) ?? false;
  const anyVeryStale = decay?.some((r) => r.very_stale > 0) ?? false;
  const anyMerelyStale = decay?.some((r) => r.stale > 0) ?? false;
  const recordAgeRow = (
    <ScanCheckRow
      label="Record age"
      notYetRun={decay === null}
      busy={decayBusy}
      onScan={scanDecay}
      verb="Check"
      verbing="Checking…"
      notYetLabel="Not checked yet"
      empty={!anyStale}
      emptyLabel="All current"
      severity={anyVeryStale ? "err" : anyMerelyStale ? "warn" : "info"}
      summary="Some records aging"
      detail={decay ? decayDetail(decay, onEntityClick) : null}
    />
  );

  const shown = work.items.slice(0, WORK_VISIBLE);
  const more  = work.items.slice(WORK_VISIBLE);
  const split = [
    work.byKind.quick_edit > 0 && `${work.byKind.quick_edit} quick ${work.byKind.quick_edit === 1 ? "edit" : "edits"}`,
    work.byKind.person > 0     && `${work.byKind.person} need a person`,
    work.byKind.decide > 0     && `${work.byKind.decide} to decide`,
  ].filter(Boolean).join(" · ");
  const notChecked = dupes === null || decay === null;

  return (
    <section className="eq-health-home">

      {/* Re-runs the load effect on demand: the counts below go stale after
          adjudicating, merging, or approving a queue item elsewhere. */}
      <div className="eq-health-refresh-row">
        <button
          type="button"
          className="eq-intake-btn-ghost"
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {loading && <p className="eq-health-loading-hint">Still checking a few things…</p>}

      {work.skipped.length > 0 && (
        <div className="eq-work-banner" role="status">
          <strong>Some checks are skipped.</strong> Your role can't see {work.skipped.join(", ")}, so
          those checks are left out of every count. Ask an admin if you need access.
        </div>
      )}

      {scores === null ? (
        <div className="eq-health-loading">Checking your data…</div>
      ) : (
        <div className="eq-work-top">
          <div className="eq-work-headline">
            <span className="eq-work-headline__num">{work.total.toLocaleString()}</span>
            <span className="eq-work-headline__label">
              {work.total === 1 ? "thing left to fix" : "things left to fix"}
            </span>
          </div>
          <p className="eq-work-sub">
            {work.total === 0
              ? (notChecked
                  ? "Nothing left from the checks that ran. Duplicates and record age aren't checked yet."
                  : "Nothing left to fix.")
              : split}
          </p>
          <p className="eq-work-note">
            Counts missing details and licences due. Possible duplicates are added after a scan.
          </p>
        </div>
      )}

      {topSlot}

      <div className="eq-work-layout">
        <div className="eq-work-main">
          {work.items.length > 0 && (
            <div className="eq-health-list-section">
              <span className="eq-health-section-label">Needs you · ranked by risk</span>
              <div className="eq-work-list">
                {shown.map((it) => <WorkRow key={it.id} item={it} onEntityClick={onEntityClick} />)}
                {more.length > 0 && (
                  <details className="eq-work-more">
                    <summary>Show {more.length} more</summary>
                    {more.map((it) => <WorkRow key={it.id} item={it} onEntityClick={onEntityClick} />)}
                  </details>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="eq-work-side">
          {scores !== null && (
            <div className="eq-health-list-section">
              <span className="eq-health-section-label">Your records</span>
              <div className="eq-health-list">
                {work.records.map((r) => recordRow(r, onEntityClick))}
              </div>
            </div>
          )}

          <div className="eq-health-list-section">
            <span className="eq-health-section-label">Not checked yet</span>
            <div className="eq-health-list">
              {duplicatesRow}
              {recordAgeRow}
            </div>
          </div>
        </div>
      </div>

    </section>
  );
}
