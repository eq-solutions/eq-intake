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

/** Sites only: a row is retired when `active` is exactly false. Rows without the field stay. */
export function splitRetired<T extends Record<string, unknown>>(entity: string, rows: readonly T[]): RetiredSplit<T> {
  if (entity !== "sites") return { live: [...rows], retired: 0 };
  const live = rows.filter((r) => r["active"] !== false);
  return { live, retired: rows.length - live.length };
}
