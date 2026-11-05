/**
 * Mapping memory glue for the import flow — recall a remembered column
 * mapping for a dropped file's shape, and remember the one the user confirms.
 *
 * Memory is strictly best-effort: ANY error from the store (find, save or
 * touch — network, RLS, a manager-only save refused for a non-manager) is
 * swallowed here and treated as a miss / no-op, so an import is never blocked
 * on it. Only column names and canonical field names reach the store; the
 * sample rows are fingerprinted locally by computeSignatureHash and never sent.
 */

import {
  lookupMapping,
  rememberMapping,
  type ColumnMappingRecord,
  type MappingMemory,
  type ParsedSheet,
} from "@eq/intake";

export interface RecalledMapping {
  mapping: ColumnMappingRecord;
  savedAt: string;
}

/** Rows fed to the shape fingerprint — computeSignatureHash only reads the first 10. */
const SAMPLE_ROWS = 10;

function shapeOf(tenantId: string, entity: string, sheet: ParsedSheet) {
  return {
    tenantId,
    entity,
    columns: sheet.headerRow,
    sampleRows: sheet.rows.slice(0, SAMPLE_ROWS) as Record<string, unknown>[],
  };
}

/** A remembered mapping for this file shape, or null on any miss or error. */
export async function recallMapping(
  memory: MappingMemory,
  tenantId: string,
  entity: string,
  sheet: ParsedSheet,
): Promise<RecalledMapping | null> {
  try {
    const found = await lookupMapping(memory, shapeOf(tenantId, entity, sheet));
    return found.hit ? { mapping: found.mapping, savedAt: found.savedAt } : null;
  } catch {
    return null;
  }
}

/** Store the confirmed mapping. Never throws; resolves false when it didn't save. */
export async function saveConfirmedMapping(
  memory: MappingMemory,
  tenantId: string,
  entity: string,
  sheet: ParsedSheet,
  mapping: ColumnMappingRecord,
): Promise<boolean> {
  try {
    await rememberMapping(memory, shapeOf(tenantId, entity, sheet), mapping);
    return true;
  } catch {
    return false;
  }
}
