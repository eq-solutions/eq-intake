import { describe, it, expect } from "vitest";
import { InMemoryMappingMemory, lookupMapping, rememberMapping } from "../src/mapping-memory.js";

const cols = ["First Name", "Surname", "Email"];
const rows = [
  { "First Name": "Anna", Surname: "Example", Email: "anna@example.test" },
  { "First Name": "Ben", Surname: "Sample", Email: "ben@example.test" },
];
const mapping = { "First Name": "first_name", Surname: "last_name", Email: "email" };
const shape = { tenantId: "t1", entity: "staff", columns: cols, sampleRows: rows };

describe("mapping memory", () => {
  it("misses on an unseen shape", async () => {
    const r = await lookupMapping(new InMemoryMappingMemory(), shape);
    expect(r).toMatchObject({ hit: false, reason: "no_match" });
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hits after a mapping is remembered, and counts the use", async () => {
    const mem = new InMemoryMappingMemory(() => "2026-11-05T00:00:00.000Z");
    await rememberMapping(mem, shape, mapping);
    const r = await lookupMapping(mem, shape);
    expect(r).toMatchObject({ hit: true, mapping, savedAt: "2026-11-05T00:00:00.000Z" });
    await lookupMapping(mem, shape);
    const stored = await mem.find({ tenantId: "t1", entity: "staff", hash: r.hash });
    expect(stored?.useCount).toBe(2);
  });

  it("hits for a re-ordered file with different sample people (same shape)", async () => {
    const mem = new InMemoryMappingMemory();
    await rememberMapping(mem, shape, mapping);
    const again = {
      ...shape,
      columns: ["Email", "First Name", "Surname"],
      sampleRows: [{ "First Name": "Cara", Surname: "Placeholder", Email: "cara@example.test" }],
    };
    expect((await lookupMapping(mem, again)).hit).toBe(true);
  });

  it("never shares a mapping across tenants", async () => {
    const mem = new InMemoryMappingMemory();
    await rememberMapping(mem, shape, mapping);
    expect((await lookupMapping(mem, { ...shape, tenantId: "t2" })).hit).toBe(false);
  });

  it("does not share across entities", async () => {
    const mem = new InMemoryMappingMemory();
    await rememberMapping(mem, shape, mapping);
    expect((await lookupMapping(mem, { ...shape, entity: "site" })).hit).toBe(false);
  });

  it("reports a stale hit (header spelling changed) as a miss with a reason", async () => {
    const mem = new InMemoryMappingMemory();
    await rememberMapping(mem, shape, mapping);
    const renamed = {
      ...shape,
      columns: ["first name", "Surname", "Email"],
      sampleRows: rows.map((r) => ({ "first name": r["First Name"], Surname: r.Surname, Email: r.Email })),
    };
    const r = await lookupMapping(mem, renamed);
    expect(r).toMatchObject({ hit: false, reason: "stale_columns" });
    expect((r as { detail?: string }).detail).toContain("First Name");
  });

  it("overwrites on re-save", async () => {
    const mem = new InMemoryMappingMemory();
    await rememberMapping(mem, shape, mapping);
    await rememberMapping(mem, shape, { ...mapping, Email: null });
    const r = await lookupMapping(mem, shape);
    expect(r).toMatchObject({ hit: true, mapping: { ...mapping, Email: null } });
  });
});
