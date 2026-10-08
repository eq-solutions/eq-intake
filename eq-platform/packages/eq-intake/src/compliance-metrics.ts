/**
 * @eq/intake — compliance metrics
 *
 * computeComplianceMetrics() reads active staff and all licence records and
 * returns the counts needed to drive the Compliance and Serviceability
 * dimensions of the data health score.
 *
 * Kept separate from computeHealthScores() so the caller can fire all four
 * health-home queries in parallel.
 *
 * The four staff fields checked here (email, phone, trade,
 * emergency_contact_name) are exactly field-importance.ts's staff entries —
 * keep them in sync if that rulebook changes.
 *
 * email, phone and emergency_contact_name are PII: eq_tidy_read_entity_columns
 * withholds them from a caller without entity.view_pii. Their counts come back
 * null in that case ("can't see"), never 0 ("nobody has one").
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';
import { readEntityColumns } from './read-entity-columns.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceMetrics {
  staff: {
    total:                 number;
    /** null = this viewer can't see staff email (no entity.view_pii). */
    has_email:             number | null;
    /** null = this viewer can't see staff phone (no entity.view_pii). */
    has_phone:             number | null;
    has_trade:             number;
    /** null = this viewer can't see emergency contacts (no entity.view_pii). */
    has_emergency_contact: number | null;
  };
  licences: {
    total: number; // total licence records (not just expiring)
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notBlank(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public: computeComplianceMetrics
// ---------------------------------------------------------------------------

export async function computeComplianceMetrics(
  supabase: SupabaseLikeClient,
): Promise<ComplianceMetrics> {
  const [staffResult, licenceResult] = await Promise.all([
    readEntityColumns(supabase, 'staff', [
      'staff_id', 'active', 'email', 'phone', 'trade', 'emergency_contact_name',
    ]),
    readEntityColumns(supabase, 'licences', ['licence_id']),
  ]);

  if (staffResult.error) throw new Error(`Reading staff failed: ${staffResult.error.message}`);
  if (licenceResult.error) throw new Error(`Reading licences failed: ${licenceResult.error.message}`);

  // Filter to active staff only (mirrors the live query)
  const staffRows = (
    (staffResult.data as Record<string, unknown>[] | null) ?? []
  ).filter((r) => r['active'] !== false);

  const licenceRows = (licenceResult.data as Record<string, unknown>[] | null) ?? [];

  // A withheld column is absent from every row. With no rows there's nothing
  // to count either way, so 0 is still true.
  const countFilled = (field: string): number | null =>
    staffRows.length > 0 && !(field in staffRows[0]!)
      ? null
      : staffRows.filter((r) => notBlank(r[field])).length;

  return {
    staff: {
      total:                 staffRows.length,
      has_email:             countFilled('email'),
      has_phone:             countFilled('phone'),
      has_trade:             staffRows.filter((r) => notBlank(r['trade'])).length,
      has_emergency_contact: countFilled('emergency_contact_name'),
    },
    licences: {
      total: licenceRows.length,
    },
  };
}
