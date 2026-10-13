/**
 * fetch-canonical — load existing rows from the canonical Supabase database.
 *
 * Used by the reconciliation flow: before we diff a dropped file we need the
 * current state from the database so the user can see what's new, what
 * conflicts, and what's already in sync.
 *
 * Reads go through eq_tidy_read_entity_columns (see read-entity-columns.ts),
 * never a direct table select: authenticated has no SELECT on app_data.contacts
 * (eq-shell 0376) and full-row reads are role-gated (0397). The RPC withholds
 * PII columns from callers without entity.view_pii, so those keys are absent
 * from the returned rows rather than null.
 */

import { readEntityColumns } from "./read-entity-columns.js";
import { ENTITY_COLUMNS, isEntityTable } from "./entity-columns.js";
import type { SupabaseLikeClient } from "./canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export type CanonicalFetchClient = SupabaseLikeClient;

// ---------------------------------------------------------------------------
// Entity → table name mapping
// ---------------------------------------------------------------------------

/** Canonical entity names the reconciler knows about. */
export type CanonicalEntity = "staff" | "sites" | "assets" | "customers" | "contacts";

const ENTITY_TABLE: Record<CanonicalEntity, string> = {
  staff: "staff",
  sites: "sites",
  assets: "assets",
  customers: "customers",
  contacts: "contacts",
};

/**
 * Map a classify() entity string to the canonical table name.
 * Returns null if the entity is not one we can fetch from canonical.
 */
export function entityToTable(entity: string): string | null {
  if (entity in ENTITY_TABLE) return ENTITY_TABLE[entity as CanonicalEntity];

  // Common aliases / plurals / SimPRO names
  const aliasMap: Record<string, string> = {
    customer: "customers",
    site: "sites",
    contact: "contacts",
    asset: "assets",
    worker: "staff",
    employee: "staff",
    licence: "staff", // licences live with staff in many layouts
  };

  return aliasMap[entity.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Main fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch all rows for a given canonical entity. Returns an empty array (not
 * an error) when the table is empty or the entity is unrecognised — the
 * reconciler treats zero canonical rows as "everything is new".
 */
export async function fetchCanonicalRows(
  supabaseClient: CanonicalFetchClient,
  entity: string,
): Promise<Record<string, unknown>[]> {
  const table = entityToTable(entity);
  if (!table) {
    // Entity not in canonical — return empty so the diff shows everything as new.
    return [];
  }

  if (!isEntityTable(table)) return [];

  const { data, error } = await readEntityColumns(supabaseClient, table, [...ENTITY_COLUMNS[table]]);

  if (error) {
    throw new Error(`fetchCanonicalRows(${table}): ${error.message}`);
  }

  return (data as Record<string, unknown>[] | null) ?? [];
}
