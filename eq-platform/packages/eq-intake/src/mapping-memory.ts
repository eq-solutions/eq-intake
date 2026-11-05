/**
 * Mapping memory — remember a user-confirmed column mapping, keyed by the
 * signature hash of the file's shape, so the same-shaped file next time skips
 * AI mapping.
 *
 * Client side only. The store is an interface; the only implementation here is
 * in-memory (tests, demo). The durable table + RPCs are specified for eq-shell
 * in docs/handoff-eq-intake-templates.md — nothing is applied from this repo.
 *
 * Rule: a lookup never silently trusts a stale hit. A remembered mapping that
 * names a source column the incoming file no longer has is reported as a miss
 * with a reason, so the caller falls through to normal mapping.
 */

import { computeSignatureHash } from "@eq/validation";

/** source column name -> canonical field (null = deliberately unmapped). */
export type ColumnMappingRecord = Record<string, string | null>;

export interface MappingMemoryKey {
  /** Tenant scope. A mapping is never shared across tenants. */
  tenantId: string;
  entity: string;
  /** Signature hash from computeSignatureHash. */
  hash: string;
}

export interface StoredMapping extends MappingMemoryKey {
  mapping: ColumnMappingRecord;
  savedAt: string;
  /** Times this mapping was applied from memory. */
  useCount: number;
}

export interface MappingMemory {
  find(key: MappingMemoryKey): Promise<StoredMapping | null>;
  save(entry: Omit<StoredMapping, "savedAt" | "useCount">): Promise<StoredMapping>;
  /** Record that a stored mapping was applied. */
  touch(key: MappingMemoryKey): Promise<void>;
}

export interface FileShape {
  tenantId: string;
  entity: string;
  columns: string[];
  sampleRows: Record<string, unknown>[];
}

export type MappingLookup =
  | { hit: true; hash: string; mapping: ColumnMappingRecord; savedAt: string }
  | { hit: false; hash: string; reason: "no_match" | "stale_columns"; detail?: string };

export class InMemoryMappingMemory implements MappingMemory {
  private readonly store = new Map<string, StoredMapping>();
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  private static id(k: MappingMemoryKey): string {
    return `${k.tenantId}|${k.entity.toLowerCase()}|${k.hash}`;
  }

  async find(key: MappingMemoryKey): Promise<StoredMapping | null> {
    const v = this.store.get(InMemoryMappingMemory.id(key));
    return v ? { ...v, mapping: { ...v.mapping } } : null;
  }

  async save(entry: Omit<StoredMapping, "savedAt" | "useCount">): Promise<StoredMapping> {
    const id = InMemoryMappingMemory.id(entry);
    const prev = this.store.get(id);
    const next: StoredMapping = {
      ...entry,
      mapping: { ...entry.mapping },
      savedAt: this.now(),
      useCount: prev?.useCount ?? 0,
    };
    this.store.set(id, next);
    return { ...next, mapping: { ...next.mapping } };
  }

  async touch(key: MappingMemoryKey): Promise<void> {
    const v = this.store.get(InMemoryMappingMemory.id(key));
    if (v) v.useCount += 1;
  }
}

/** Look up a remembered mapping for this file shape. */
export async function lookupMapping(
  memory: MappingMemory,
  shape: FileShape,
): Promise<MappingLookup> {
  const hash = await computeSignatureHash(shape);
  const found = await memory.find({ tenantId: shape.tenantId, entity: shape.entity, hash });
  if (!found) return { hit: false, hash, reason: "no_match" };

  const present = new Set(shape.columns);
  const missing = Object.keys(found.mapping).filter((c) => !present.has(c));
  if (missing.length > 0) {
    // Same shape hash (names are normalised) but the literal headers differ.
    return {
      hit: false,
      hash,
      reason: "stale_columns",
      detail: `remembered mapping names columns not in this file: ${missing.join(", ")}`,
    };
  }
  await memory.touch({ tenantId: shape.tenantId, entity: shape.entity, hash });
  return { hit: true, hash, mapping: found.mapping, savedAt: found.savedAt };
}

/** Store the mapping the user confirmed for this file shape. */
export async function rememberMapping(
  memory: MappingMemory,
  shape: FileShape,
  mapping: ColumnMappingRecord,
): Promise<StoredMapping> {
  const hash = await computeSignatureHash(shape);
  return memory.save({ tenantId: shape.tenantId, entity: shape.entity, hash, mapping });
}
