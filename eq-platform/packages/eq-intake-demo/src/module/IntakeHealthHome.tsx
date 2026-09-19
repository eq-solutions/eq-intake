import { useState, useEffect, type JSX, type ReactNode } from "react";
import {
  computeHealthScores,
  runLicenceExpiryCheck,
  runOrphanCheck,
  computeComplianceMetrics,
  detectAllDuplicates,
  decayCheck,
  getFieldTier,
  FIELD_IMPORTANCE,
} from "@eq/intake";
import type {
  HealthScore,
  LicenceExpiryAlertSummary,
  ComplianceMetrics,
  DuplicateReport,
  DecaySummary,
  FieldImportanceOverride,
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

interface DimensionResult {
  completeness:   number; // 0–1 — can we reach people (staff email + contacts on file)
  compliance:     number; // 0–1 — SKS-specific: licence coverage + emergency contacts
  serviceability: number; // 0–1 — SKS-specific: trade classification + sites on file
  validity:       number; // 0–1 — DAMA "Validity": do populated fields pass format checks (ABN, phone, state, postcode)
  consistency:    number; // 0–1 — DAMA "Consistency": referential integrity (no broken FK links)
  timeliness:     number; // 0–1 — DAMA "Timeliness": records touched within the last year
  composite:      number; // 0–100
}

interface ActionItem {
  id:          string;
  /** Entity this action's onClick should drill into. */
  entity:      string;
  /** Set only for field-gap actions (e.g. "phone") — lets the click open
   * straight into a bulk-fill grid for that field. Unset for the two
   * whole-record special cases (no licences / licences expiring). */
  field?:      string;
  title:       string;
  description: string;
  pts:         number;
  severity:    "danger" | "warning" | "info";
}

/** Shared status vocabulary for every row in the unified checks list — one
 * colour language instead of the four slightly-different badge/fill/dot
 * palettes the previous layout accumulated across its five section types. */
type RowStatus = "ok" | "warn" | "err" | "info" | "neutral";

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

// Below this many rows, a 100% (or 0%) score is a coin flip, not a trend —
// flag it so a nearly-empty entity doesn't read as confidently as a big one.
const LOW_SAMPLE_THRESHOLD = 5;

// Averages only the components that have data behind them. An entity with
// zero rows is "not started", not "fully complete" — it must not silently
// inflate a dimension to 100% before anyone has entered a single record.
function averageStarted(...components: Array<{ value: number; started: boolean } | null>): number {
  const live = components.filter((c): c is { value: number; started: boolean } => c !== null && c.started);
  if (live.length === 0) return 0;
  return live.reduce((sum, c) => sum + c.value, 0) / live.length;
}

// Weights reflect SKS's consumption context (Soda's phrase for it): licence
// coverage and dispatch-readiness carry real compliance/safety consequences,
// so they outweigh general data hygiene. Validity and Timeliness were
// computed by the underlying modules all along but never fed the composite
// — see health-score.ts's module comment for the DAMA-UK framing.
const WEIGHTS = {
  compliance:     30,
  serviceability: 25,
  completeness:   15,
  validity:       12,
  consistency:    10,
  timeliness:      8,
} as const;

function computeDimensions(
  scores:    HealthScore[] | null,
  licences:  LicenceExpiryAlertSummary | null,
  orphans:   OrphanSummary | null,
  cm:        ComplianceMetrics | null,
): DimensionResult {
  const st = cm?.staff.total ?? 0;
  const contactsHs = scores?.find((s) => s.entity === "contacts") ?? null;
  const sitesHs    = scores?.find((s) => s.entity === "sites") ?? null;

  // Completeness: staff email + contacts completeness (can we reach people)
  const staffEmailRate = st > 0 ? (cm!.staff.has_email / st) : 0;
  const completeness    = averageStarted(
    { value: staffEmailRate, started: st > 0 },
    contactsHs ? { value: contactsHs.score, started: contactsHs.started } : null,
  );

  // Compliance: licence coverage (≥1 record per staff) + emergency contacts
  const licenceRecords  = licences?.records_total ?? 0;
  const licenceCoverage = st > 0 ? Math.min(1, licenceRecords / st) : 0;
  const emergencyRate   = st > 0 ? (cm!.staff.has_emergency_contact / st) : 0;
  const compliance      = averageStarted(
    { value: licenceCoverage, started: st > 0 },
    { value: emergencyRate, started: st > 0 },
  );

  // Serviceability: trade classification + sites completeness
  const tradeRate      = st > 0 ? (cm!.staff.has_trade / st) : 0;
  const serviceability = averageStarted(
    { value: tradeRate, started: st > 0 },
    sitesHs ? { value: sitesHs.score, started: sitesHs.started } : null,
  );

  // Validity: average format-correctness across every entity that has data
  const validity = averageStarted(
    ...(scores ?? []).map((s) => ({ value: s.validity, started: s.started })),
  );

  // Timeliness: average freshness across every entity that has data
  const timeliness = averageStarted(
    ...(scores ?? []).map((s) => ({ value: s.freshness, started: s.started })),
  );

  // Consistency: orphan-free (referential integrity)
  const orphanTotal = orphans?.total ?? 0;
  const consistency  = orphanTotal === 0 ? 1 : Math.max(0, 1 - orphanTotal / 100);

  const composite = Math.round(
    compliance * WEIGHTS.compliance +
    serviceability * WEIGHTS.serviceability +
    completeness * WEIGHTS.completeness +
    validity * WEIGHTS.validity +
    consistency * WEIGHTS.consistency +
    timeliness * WEIGHTS.timeliness,
  );

  return { completeness, compliance, serviceability, validity, consistency, timeliness, composite };
}

// Points-per-tier for sorting/display only — unrelated to the composite
// score's WEIGHTS above (those are per-dimension; this just orders which
// gaps surface first in the action list, critical always before important).
const ACTION_PTS: Record<"critical" | "important", number> = { critical: 15, important: 5 };

function deriveActions(
  scores:    HealthScore[] | null,
  licences:  LicenceExpiryAlertSummary | null,
  cm:        ComplianceMetrics | null,
  overrides?: FieldImportanceOverride[],
): ActionItem[] {
  const actions: ActionItem[] = [];
  const st = cm?.staff.total ?? 0;

  // Two special cases the rulebook doesn't model — not "is this field blank
  // on an existing row" but "does the whole record exist at all" and "is
  // this a time-sensitive expiry," respectively.
  if (st > 0 && (licences?.records_total ?? 0) === 0) {
    actions.push({
      id:          "no_licences",
      entity:      "licences",
      title:       `${st} active staff — no licence records on file`,
      description: "White cards, yellow cards, electrical licences are all untracked.",
      pts:         25,
      severity:    "danger",
    });
  }

  if ((licences?.total ?? 0) > 0) {
    actions.push({
      id:          "expiring",
      entity:      "licences",
      title:       `${licences!.total} licence${licences!.total === 1 ? "" : "s"} expiring within 60 days`,
      description: `${licences!.critical > 0 ? `${licences!.critical} expired or critical. ` : ""}Renewal required before deployment.`,
      pts:         20,
      severity:    licences!.critical > 0 ? "danger" : "warning",
    });
  }

  // Everything else comes straight from the rulebook — a field's tier and
  // "why" only ever need to change in field-importance.ts to change what
  // shows up here, across every entity, not just staff.
  for (const hs of scores ?? []) {
    if (!hs.started) continue;
    for (const field of hs.gaps) {
      const count = hs.gapCounts[field] ?? 0;
      if (count === 0) continue;
      const tier = getFieldTier(hs.entity, field, overrides);
      if (tier !== "critical" && tier !== "important") continue;
      const why = FIELD_IMPORTANCE[hs.entity]?.find((e) => e.field === field)?.why ?? "";
      actions.push({
        id:          `${hs.entity}.${field}`,
        entity:      hs.entity,
        field,
        title:       `${count} of ${hs.total} ${entityLabel(hs.entity).toLowerCase()} missing ${fieldLabel(field)}`,
        description: why,
        pts:         ACTION_PTS[tier],
        severity:    tier === "critical" ? "danger" : "warning",
      });
    }
  }

  return actions.sort((a, b) => b.pts - a.pts).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function statusLabel(composite: number): string {
  if (composite >= 85) return "Good";
  if (composite >= 60) return "Fair";
  if (composite >= 40) return "Needs attention";
  return "Gaps present";
}

function ringColour(composite: number): string {
  if (composite >= 85) return "var(--eq-ok)";
  if (composite >= 60) return "var(--eq-sky)";
  if (composite >= 40) return "var(--eq-warn)";
  return "var(--eq-err)";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScoreRing({ composite }: { composite: number }): JSX.Element {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - composite / 100);
  const colour = ringColour(composite);
  const label  = statusLabel(composite);

  return (
    <div className="eq-health-ring-wrap">
      <div className="eq-health-ring-svg">
        <svg width="96" height="96" viewBox="0 0 96 96" fill="none">
          <circle cx="48" cy="48" r={r} stroke="var(--eq-line)" strokeWidth="7" />
          <circle
            cx="48" cy="48" r={r}
            stroke={colour}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            transform="rotate(-90 48 48)"
          />
        </svg>
        <div className="eq-health-ring-inner">
          <span className="eq-health-ring-num">{composite}</span>
          <span className="eq-health-ring-sub">/100</span>
        </div>
      </div>
      <span className="eq-health-ring-status" style={{ color: colour }}>{label}</span>
    </div>
  );
}

function DimensionBar({
  label, score, weight, title,
}: { label: string; score: number; weight: string; title?: string }): JSX.Element {
  const fillClass = score >= 0.8 ? "eq-health-dim-fill--ok" : score >= 0.5 ? "eq-health-dim-fill--warn" : "eq-health-dim-fill--err";
  return (
    <div className="eq-health-dim">
      <span className="eq-health-dim-name" title={title}>
        {label}
        <span className="eq-health-dim-weight">{weight}</span>
      </span>
      <div className="eq-health-dim-track">
        <div
          className={`eq-health-dim-fill ${fillClass}`}
          style={{ width: pct(score) } as React.CSSProperties}
        />
      </div>
      <span className="eq-health-dim-pct">{pct(score)}</span>
    </div>
  );
}

function ActionCard({
  action, onEntityClick,
}: { action: ActionItem; onEntityClick?: (entity: string, field?: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`eq-health-action eq-health-action--${action.severity}`}
      onClick={onEntityClick ? () => onEntityClick(action.entity, action.field) : undefined}
    >
      <div className={`eq-health-action-icon eq-health-action-icon--${action.severity}`} aria-hidden="true">
        {action.severity === "danger" ? "!" : "→"}
      </div>
      <div className="eq-health-action-body">
        <p className="eq-health-action-title">{action.title}</p>
        <p className="eq-health-action-sub">{action.description}</p>
      </div>
      <span className={`eq-health-action-badge eq-health-action-badge--${action.severity}`}>
        +{action.pts} pts
      </span>
    </button>
  );
}

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

function orphanDetail(
  summary: OrphanSummary, onEntityClick?: (entity: string) => void,
): ReactNode {
  const items: Array<{ count: number; entity: string; label: string }> = [
    { count: summary.assets_no_site_count,     entity: "assets",   label: `asset${summary.assets_no_site_count !== 1 ? "s" : ""} missing site` },
    { count: summary.contacts_no_parent_count, entity: "contacts", label: `contact${summary.contacts_no_parent_count !== 1 ? "s" : ""} unlinked` },
    { count: summary.licences_no_staff_count,  entity: "licences", label: `licence${summary.licences_no_staff_count !== 1 ? "s" : ""} missing staff` },
    { count: summary.sites_no_customer_count,  entity: "sites",    label: `site${summary.sites_no_customer_count !== 1 ? "s" : ""} missing customer` },
  ].filter((i) => i.count > 0);

  return (
    <>
      {items.map((i) => (
        <EntityBadge
          key={i.entity}
          text={`${i.count} ${i.label}`}
          cls="eq-health-badge--warning"
          title={`Open ${i.entity} drill-down`}
          entity={i.entity}
          onEntityClick={onEntityClick}
        />
      ))}
    </>
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
  hs: HealthScore, overrides: FieldImportanceOverride[] | undefined, onEntityClick: ((entity: string, field?: string) => void) | undefined,
): ReactNode {
  const label = entityLabel(hs.entity);

  if (!hs.started) {
    return (
      <CheckRow
        key={hs.entity}
        status="neutral"
        label={label}
        meta="0 records"
        summary="Not started"
        detail="Not counted in the health score yet."
        onClick={onEntityClick ? () => onEntityClick(hs.entity) : undefined}
        ariaLabel={`${label} — no records yet`}
      />
    );
  }

  const lowSample  = hs.total < LOW_SAMPLE_THRESHOLD;
  const status: RowStatus = hs.score >= 0.9 ? "ok" : hs.score >= 0.7 ? "warn" : "err";
  const percentage = pct(hs.score);
  const detail = (hs.gaps.length > 0 || lowSample) && (
    <>
      {lowSample && (
        <p className="eq-health-card__low-sample">
          Based on only {hs.total} record{hs.total === 1 ? "" : "s"} — treat this score as unproven.
        </p>
      )}
      {hs.gaps.length > 0 && (
        <div className="eq-health-card__gaps">
          <span className="eq-health-card__gaps-label">Missing:</span>
          {hs.gaps.map((field) => {
            const tier = getFieldTier(hs.entity, field, overrides);
            const tierClass = tier === "critical" ? "eq-health-badge--critical" : "eq-health-badge--warning";
            return (
              <span key={field} className={`eq-health-badge ${tierClass}`}>
                {fieldLabel(field)}
              </span>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <CheckRow
      key={hs.entity}
      status={status}
      label={label}
      meta={`${hs.total.toLocaleString()} record${hs.total === 1 ? "" : "s"}`}
      summary={percentage}
      progress={hs.score}
      detail={detail || undefined}
      onClick={onEntityClick ? () => onEntityClick(hs.entity) : undefined}
      ariaLabel={`${label} — ${percentage} complete${lowSample ? `, based on only ${hs.total} record${hs.total === 1 ? "" : "s"}` : ""}`}
    />
  );
}

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
}: IntakeHealthHomeProps): JSX.Element {
  const resolvedTenantId = tenantId ?? DEFAULT_TENANT_ID;

  if (!tenantId) {
    // eslint-disable-next-line no-console
    console.warn("[IntakeHealthHome] tenantId prop not provided — health queries will use the fixture tenant.");
  }

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
    if (!supabase) return;

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
        runLicenceExpiryCheck(sb, resolvedTenantId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runOrphanCheck({ supabase: supabase as any, tenantId: resolvedTenantId }),
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
  }, [supabase, resolvedTenantId, refreshTick, refreshSignal, fieldImportanceOverrides]);

  if (!supabase) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice">Connect EQ to see your data health</div>
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

  const dims    = computeDimensions(scores, licences, orphans, compliance);
  const actions = deriveActions(scores, licences, compliance, fieldImportanceOverrides);

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

  // ---- licences row -------------------------------------------------------
  let licenceRow: ReactNode = null;
  if (licences) {
    if (licences.records_total === 0) {
      licenceRow = (
        <CheckRow status="err" label="Licences" summary="No licence data — 0 records" />
      );
    } else if (licences.total === 0) {
      licenceRow = (
        <CheckRow status="ok" label="Licences" summary={`All ${licences.records_total.toLocaleString()} current`} />
      );
    } else {
      const parts = [
        licences.critical > 0 ? `${licences.critical} expired/critical` : null,
        licences.warning  > 0 ? `${licences.warning} expiring soon`     : null,
        licences.info     > 0 ? `${licences.info} within 60 days`       : null,
      ].filter(Boolean).join(" · ");
      licenceRow = (
        <CheckRow
          status={licences.critical > 0 ? "err" : licences.warning > 0 ? "warn" : "info"}
          label="Licences"
          summary={parts}
        />
      );
    }
  }

  // ---- broken links (orphans) row -----------------------------------------
  let orphanRow: ReactNode = null;
  if (orphans) {
    orphanRow = orphans.total === 0 ? (
      <CheckRow status="ok" label="Broken links" summary="None found" />
    ) : (
      <CheckRow
        status="warn"
        label="Broken links"
        summary={`${orphans.total} to fix`}
        detail={orphanDetail(orphans, onEntityClick)}
      />
    );
  }

  // ---- duplicates row -------------------------------------------------------
  const dupeTotal = dupes?.reduce((n, r) => n + r.clusters.length, 0) ?? 0;
  const dupeNeedsReconcile = dupes?.some((r) => (r.needs_reconcile ?? 0) > 0) ?? false;
  const duplicatesRow = (
    <ScanCheckRow
      label="Duplicates"
      notYetRun={dupes === null}
      busy={dupesBusy}
      onScan={scanDuplicates}
      verb="Scan"
      verbing="Scanning…"
      notYetLabel="Not scanned yet"
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

  return (
    <section className="eq-health-home">

      {/* Re-runs the load effect on demand — the scores/counts below go stale
          after adjudicating, merging, or approving a queue item elsewhere,
          and the only other way to see updated ones is leaving this tab and
          coming back. */}
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

      {/* The checks run in parallel (Promise.allSettled) and already tolerate
          each other failing independently — so each section below reveals
          itself as its own data lands instead of waiting behind one big
          spinner for the slowest of them. */}
      {loading && <p className="eq-health-loading-hint">Still checking a few things…</p>}

      {/* Composite score + 6 dimensions — the one headline number, with the
          "why" tucked behind a disclosure instead of six bars up front. */}
      <div className="eq-health-top">
        {scores !== null ? (
          <>
            <ScoreRing composite={dims.composite} />
            <details className="eq-health-dims-disclosure">
              <summary>Show the breakdown</summary>
              <div className="eq-health-dims">
                <DimensionBar label="Compliance"        score={dims.compliance}     weight={`${WEIGHTS.compliance}%`} />
                <DimensionBar label="Ready to dispatch"  score={dims.serviceability} weight={`${WEIGHTS.serviceability}%`} title="Serviceability" />
                <DimensionBar label="Can we reach people" score={dims.completeness}  weight={`${WEIGHTS.completeness}%`} title="Completeness" />
                <DimensionBar label="Correctly formatted" score={dims.validity}      weight={`${WEIGHTS.validity}%`} title="Validity" />
                <DimensionBar label="Records linked up"   score={dims.consistency}   weight={`${WEIGHTS.consistency}%`} title="Consistency" />
                <DimensionBar label="Recently updated"    score={dims.timeliness}    weight={`${WEIGHTS.timeliness}%`} title="Timeliness" />
              </div>
            </details>
          </>
        ) : (
          <div className="eq-health-loading">Checking your data…</div>
        )}
      </div>

      {/* Action queue — the top 4 highest-impact gaps. Left exactly as-is:
          already the clearest part of the old layout. */}
      {actions.length > 0 && (
        <div className="eq-health-actions">
          <span className="eq-health-section-label">
            Fix these to improve your score
          </span>
          {actions.map((a) => (
            <ActionCard key={a.id} action={a} onEntityClick={onEntityClick} />
          ))}
        </div>
      )}

      {/* Your records — what used to be a 5-card grid is now 5 rows in the
          same list language the checks below use. */}
      {scores !== null && (
        <div className="eq-health-list-section">
          <span className="eq-health-section-label">Your records</span>
          <div className="eq-health-list">
            {scores.map((hs) => recordRow(hs, fieldImportanceOverrides, onEntityClick))}
          </div>
        </div>
      )}

      {/* Data quality checks — licences, broken links, duplicates, record age.
          Previously four separately-headed strips with their own visual
          rhythm; now four rows in the same list as the records above. */}
      <div className="eq-health-list-section">
        <span className="eq-health-section-label">Data quality checks</span>
        <div className="eq-health-list">
          {licenceRow}
          {orphanRow}
          {duplicatesRow}
          {recordAgeRow}
        </div>
      </div>

    </section>
  );
}
