/**
 * Retired sites are merged duplicates (eq-shell 0185 soft-retires the loser with
 * active = false and keeps the row). The drill-down used to list them with every
 * other record, so Sites showed "264 records, 56 possible dupes" when 210 were
 * live and one pair was a real duplicate: the rest were copies already merged.
 * They stay in the database; this only keeps them out of the working list, the
 * counts and the duplicate check.
 */

export interface RetiredSplit<T> {
  live: T[];
  retired: number;
}

/**
 * Entities where `active = false` means "no longer part of the working set": a merged site, a
 * person who has left, a customer or contact archived, an asset taken off the books. Their gaps
 * are not work to do (SKS: 44 of 119 staff records are leavers, so "56 missing an emergency
 * contact" was really 24). Licences have no such flag.
 */
const HAS_ACTIVE_FLAG = new Set(["sites", "staff", "customers", "contacts", "assets"]);

/** A row is retired when `active` is exactly false. Rows without the field stay. */
export function splitRetired<T extends Record<string, unknown>>(entity: string, rows: readonly T[]): RetiredSplit<T> {
  if (!HAS_ACTIVE_FLAG.has(entity)) return { live: [...rows], retired: 0 };
  const live = rows.filter((r) => r["active"] !== false);
  return { live, retired: rows.length - live.length };
}
