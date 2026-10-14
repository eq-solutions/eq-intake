/**
 * queue-stale — find remediation-queue items the live record has already
 * outgrown, so the review screen doesn't show work nobody needs to do.
 *
 * The steward fills the queue once; people then fix the gaps by hand, staff
 * leave and duplicates get merged, and nothing told the queue (2026-10-14:
 * 86 of 110 pending staff items were stale after 103 days). Pure function —
 * the caller reads staff via readEntityColumns and resolves what this returns.
 *
 * PII keys (email, emergency_contact_name) are absent from the rows of a
 * viewer without entity.view_pii. Absent means "can't see", never "blank" —
 * those items are left alone rather than judged.
 */

export interface StaleCheckItem {
  queue_id: string;
  entity: string;
  record_id: string;
  category: string;
}

export interface StaleVerdict {
  queue_id: string;
  note: string;
}

const FIELD_BY_CATEGORY: Record<string, string> = {
  trade: 'trade',
  emergency_contact: 'emergency_contact_name',
  email: 'email',
};

export const STALE_STAFF_COLUMNS = [
  'staff_id', 'active', 'trade', 'emergency_contact_name', 'email',
] as const;

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

export function findStaleQueueItems(
  items: readonly StaleCheckItem[],
  staffRows: readonly Record<string, unknown>[],
): StaleVerdict[] {
  const byId = new Map(staffRows.map((r) => [String(r['staff_id']), r]));
  const out: StaleVerdict[] = [];

  for (const item of items) {
    if (item.entity !== 'staff') continue;
    const staff = byId.get(item.record_id);

    if (!staff) {
      out.push({ queue_id: item.queue_id, note: 'Auto-dismissed: record no longer exists.' });
      continue;
    }
    if (staff['active'] === false) {
      out.push({ queue_id: item.queue_id, note: 'Auto-dismissed: staff member is now inactive.' });
      continue;
    }
    const field = FIELD_BY_CATEGORY[item.category];
    if (field && filled(staff[field])) {
      out.push({ queue_id: item.queue_id, note: 'Auto-dismissed: field already filled on the live record.' });
    }
  }
  return out;
}
