/**
 * overview-work — turns the Overview's raw checks into one ranked list of
 * "things left to fix", so the screen can say what to do next instead of
 * reporting a score.
 *
 * Pure: the caller loads health scores, licences, compliance metrics, orphans
 * and (optionally) a duplicate scan, and passes plain-English labels in.
 *
 * Three kinds of work, by who has to do it:
 *   person     — only the person (or licence holder) can supply it; EQ never guesses
 *   quick_edit — a typed value or bulk fill, opened in the existing drill-down
 *   decide     — a human call, e.g. merge or keep a possible duplicate
 *
 * A check the viewer can't see (no entity.view_pii: staff phone/email/emergency
 * contact) is reported in `skipped`, never counted as zero.
 */

import { getFieldTier, FIELD_IMPORTANCE } from './field-importance.js';
import type { FieldImportanceOverride } from './field-importance.js';
import type { HealthScore } from './health-score.js';
import type { ComplianceMetrics } from './compliance-metrics.js';
import type { LicenceExpiryAlertSummary } from './licence-expiry-check.js';
import type { DuplicateReport } from './duplicate-detect.js';

export type WorkKind = 'person' | 'quick_edit' | 'decide';

export interface WorkItem {
  id:          string;
  kind:        WorkKind;
  /** Lower sorts first: 0 expired licences, 1 safety/critical fields, 2 decisions, 3 the rest. */
  rank:        number;
  count:       number;
  entity:      string;
  /** Set for field gaps — opens the bulk-fill grid for that one field. */
  field?:      string;
  title:       string;
  detail:      string;
  tag?:        { text: string; tone: 'expired' | 'safety' };
  actionLabel: string;
}

export interface OrphanCounts {
  assets_no_site_count:     number;
  contacts_no_parent_count: number;
  licences_no_staff_count:  number;
  sites_no_customer_count:  number;
  total:                    number;
}

export interface OverviewWorkInput {
  scores:     HealthScore[] | null;
  licences:   LicenceExpiryAlertSummary | null;
  compliance: ComplianceMetrics | null;
  orphans:    OrphanCounts | null;
  /** null until the on-demand duplicate scan has run. */
  dupes:      DuplicateReport[] | null;
  overrides?: FieldImportanceOverride[];
  labels: {
    entity: (entity: string) => string;
    field:  (field: string) => string;
  };
}

export interface RecordSummary {
  entity:   string;
  total:    number;
  started:  boolean;
  /** Missing-field count across critical + important fields. 0 means nothing to fix. */
  toFix:    number;
  gaps:     Array<{ field: string; count: number; tier: 'critical' | 'important' }>;
  /** True when some of this entity's checks were skipped for this viewer. */
  partlyChecked: boolean;
}

export interface OverviewWork {
  total:    number;
  items:    WorkItem[];
  byKind:   Record<WorkKind, number>;
  records:  RecordSummary[];
  /** Plain-English names of checks skipped for this viewer; empty when nothing is hidden. */
  skipped:  string[];
}

/** Fields that are really one job: filled in together, counted once. */
const FIELD_GROUPS: Record<string, Array<{ label: string; fields: string[] }>> = {
  sites: [{ label: 'address', fields: ['address_line_1', 'suburb', 'state', 'postcode'] }],
};

const PERSON_FIELDS = new Set(['emergency_contact_name', 'emergency_contact_mobile', 'emergency_contact_relationship']);

export function skippedChecks(cm: ComplianceMetrics | null): string[] {
  if (!cm) return [];
  const out: string[] = [];
  if (cm.staff.has_phone === null)             out.push('phone');
  if (cm.staff.has_email === null)             out.push('email');
  if (cm.staff.has_emergency_contact === null) out.push('emergency contact');
  return out;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function buildOverviewWork(input: OverviewWorkInput): OverviewWork {
  const { scores, licences, compliance, orphans, dupes, overrides, labels } = input;
  const items: WorkItem[] = [];
  const skipped = skippedChecks(compliance);
  const staffTotal = compliance?.staff.total ?? 0;

  // ── Licences ─────────────────────────────────────────────────────────────
  if (staffTotal > 0 && licences && licences.records_total === 0) {
    items.push({
      id: 'licences.none', kind: 'quick_edit', rank: 1, count: staffTotal, entity: 'licences',
      title: `Add licences for ${staffTotal} staff`,
      detail: "No licence records on file, so expiries can't be tracked.",
      actionLabel: 'Open licences',
    });
  } else if (licences && licences.total > 0) {
    const n = licences.total;
    items.push({
      id: 'licences.expiring', kind: 'person', rank: licences.critical > 0 ? 0 : 1, count: n, entity: 'licences',
      title: `Renew ${n} ${plural(n, 'licence', 'licences')}`,
      detail: `${licences.critical > 0 ? `${licences.critical} expired or critical. ` : ''}Needs the licence holder.`,
      ...(licences.critical > 0 ? { tag: { text: 'Expired', tone: 'expired' as const } } : {}),
      actionLabel: 'See who',
    });
  }

  // ── Missing fields (critical + important only) and per-entity summaries ──
  const records: RecordSummary[] = [];
  for (const hs of scores ?? []) {
    const gaps: RecordSummary['gaps'] = [];
    // What actually has to be fixed. A site missing its whole address is one
    // thing to fix, not four, so grouped fields collapse to one unit whose
    // count is the largest of the group (a lower bound on records affected).
    const units: Array<{ field: string; count: number; tier: 'critical' | 'important'; groupLabel?: string }> = [];
    const grouped = new Map<string, { field: string; count: number; tier: 'critical' | 'important'; groupLabel: string }>();
    if (hs.started) {
      for (const field of hs.gaps) {
        const count = hs.gapCounts[field] ?? 0;
        if (count === 0) continue;
        const tier = getFieldTier(hs.entity, field, overrides);
        if (tier !== 'critical' && tier !== 'important') continue;
        gaps.push({ field, count, tier });

        const group = FIELD_GROUPS[hs.entity]?.find((g) => g.fields.includes(field));
        if (!group) { units.push({ field, count, tier }); continue; }
        const seen = grouped.get(group.label);
        if (!seen) {
          grouped.set(group.label, { field, count, tier, groupLabel: group.label });
        } else {
          seen.count = Math.max(seen.count, count);
          if (tier === 'critical') seen.tier = 'critical';
        }
      }
      units.push(...grouped.values());

      for (const u of units) {
        const person = PERSON_FIELDS.has(u.field);
        const entityName = labels.entity(hs.entity).toLowerCase();
        const fieldName = u.groupLabel ?? labels.field(u.field).toLowerCase();
        const why = FIELD_IMPORTANCE[hs.entity]?.find((e) => e.field === u.field)?.why ?? '';
        items.push({
          id: `${hs.entity}.${u.groupLabel ?? u.field}`,
          kind: person ? 'person' : 'quick_edit',
          rank: u.tier === 'critical' ? 1 : 3,
          count: u.count, entity: hs.entity, field: u.field,
          title: person
            ? `Get ${fieldName} for ${u.count} ${entityName}`
            : `Fill ${fieldName} on ${u.count} ${entityName}`,
          detail: why || `${u.count} of ${hs.total} ${entityName}.`,
          ...(person ? { tag: { text: 'Safety', tone: 'safety' as const } } : {}),
          actionLabel: person ? 'See who' : 'Fill in',
        });
      }
    }
    const partlyChecked = skipped.length > 0 && (hs.entity === 'staff' || hs.entity === 'contacts');
    records.push({
      entity: hs.entity, total: hs.total, started: hs.started,
      toFix: units.reduce((n, u) => n + u.count, 0), gaps, partlyChecked,
    });
  }

  // ── Broken links ─────────────────────────────────────────────────────────
  if (orphans && orphans.total > 0) {
    const biggest = ([
      ['assets', orphans.assets_no_site_count],
      ['contacts', orphans.contacts_no_parent_count],
      ['licences', orphans.licences_no_staff_count],
      ['sites', orphans.sites_no_customer_count],
    ] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
    items.push({
      id: 'links', kind: 'quick_edit', rank: 3, count: orphans.total, entity: biggest[0],
      title: `Fix ${orphans.total} broken ${plural(orphans.total, 'link', 'links')}`,
      detail: "Records that point at something that isn't there.",
      actionLabel: 'Fix links',
    });
  }

  // ── Duplicates (only once scanned) ───────────────────────────────────────
  for (const r of dupes ?? []) {
    if (r.clusters.length === 0) continue;
    const n = r.needs_reconcile > 0 ? r.needs_reconcile : r.clusters.length;
    items.push({
      id: `dupes.${r.entity}`, kind: 'decide', rank: 2, count: n, entity: r.entity,
      title: `Decide on ${n} possible ${labels.entity(r.entity).toLowerCase()} ${plural(n, 'duplicate', 'duplicates')}`,
      detail: r.needs_reconcile > 0 ? 'The kept record needs choosing.' : 'Merge, archive or keep both.',
      actionLabel: `Review ${n}`,
    });
  }

  items.sort((a, b) => a.rank - b.rank || b.count - a.count);

  const byKind: Record<WorkKind, number> = { person: 0, quick_edit: 0, decide: 0 };
  for (const it of items) byKind[it.kind] += it.count;

  return { total: items.reduce((n, i) => n + i.count, 0), items, byKind, records, skipped };
}
