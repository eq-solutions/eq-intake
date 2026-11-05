import { describe, it, expect } from "vitest";
import { InMemoryMappingMemory, lookupMapping, type MappingMemory, type ParsedSheet } from "@eq/intake";
import { recallMapping, saveConfirmedMapping } from "../src/shared/mapping-memory-flow.js";
import { effectiveMapping } from "../src/canonical/commit-canonical.js";

const TENANT = "tenant-1";

function sheet(headerRow: string[], rows: Record<string, string>[]): ParsedSheet {
  return { sheetName: "Sheet1", headerRow, rows, meta: {} } as unknown as ParsedSheet;
}

const customers = sheet(
  ["Cust Name", "Phone No", "Email Address"],
  [
    { "Cust Name": "Acme Pty Ltd", "Phone No": "0412 345 678", "Email Address": "a@acme.com.au" },
    { "Cust Name": "Beta Pty Ltd", "Phone No": "0498 765 432", "Email Address": "b@beta.com.au" },
  ],
);

/** Every call throws, like a network failure or an RLS refusal. */
function throwingMemory(): MappingMemory & { calls: string[] } {
  const calls: string[] = [];
  const boom = (op: string) => async () => {
    calls.push(op);
    throw new Error(`${op} failed`);
  };
  return { calls, find: boom("find"), save: boom("save"), touch: boom("touch") } as never;
}

describe("mapping memory in the import flow", () => {
  it("hit: a confirmed mapping comes back for the same-shaped file, ready to pre-fill", async () => {
    const memory = new InMemoryMappingMemory(() => "2026-11-06T00:00:00.000Z");
    const confirmed = { "Cust Name": "name", "Phone No": "phone", "Email Address": null };

    expect(await saveConfirmedMapping(memory, TENANT, "customer", customers, confirmed)).toBe(true);

    const recalled = await recallMapping(memory, TENANT, "customer", customers);
    expect(recalled).toEqual({ mapping: confirmed, savedAt: "2026-11-06T00:00:00.000Z" });
  });

  it("confirm: remembers the mapping the commit used (inferred + manual picks)", async () => {
    const memory = new InMemoryMappingMemory();
    const used = effectiveMapping(customers, "customer", { "Cust Name": "customer_name" });
    expect(used["Cust Name"]).toBe("customer_name");

    await saveConfirmedMapping(memory, TENANT, "customer", customers, used);
    expect((await recallMapping(memory, TENANT, "customer", customers))?.mapping).toEqual(used);
  });

  it("miss: nothing remembered for this shape", async () => {
    const memory = new InMemoryMappingMemory();
    expect(await recallMapping(memory, TENANT, "customer", customers)).toBeNull();
  });

  it("miss: another tenant's mapping is never returned", async () => {
    const memory = new InMemoryMappingMemory();
    await saveConfirmedMapping(memory, "tenant-2", "customer", customers, { "Cust Name": "name" });
    expect(await recallMapping(memory, TENANT, "customer", customers)).toBeNull();
  });

  it("stale_columns: remembered mapping names a column this file lacks -> miss", async () => {
    const memory = new InMemoryMappingMemory();
    // Same normalised shape, but a remembered header ("Phone No.") isn't literally in the file.
    await saveConfirmedMapping(memory, TENANT, "customer", customers, {
      "Cust Name": "name",
      "Phone No.": "phone",
    });
    expect(await recallMapping(memory, TENANT, "customer", customers)).toBeNull();
    const raw = await lookupMapping(memory, {
      tenantId: TENANT,
      entity: "customer",
      columns: customers.headerRow,
      sampleRows: customers.rows,
    });
    expect(raw).toMatchObject({ hit: false, reason: "stale_columns" });
  });

  it("error as miss: a store that throws on find never throws out of recall", async () => {
    const memory = throwingMemory();
    await expect(recallMapping(memory, TENANT, "customer", customers)).resolves.toBeNull();
    expect(memory.calls).toEqual(["find"]);
  });

  it("error as miss: a throwing touch (after a hit) is also a miss, not a crash", async () => {
    const inner = new InMemoryMappingMemory();
    await saveConfirmedMapping(inner, TENANT, "customer", customers, { "Cust Name": "name" });
    const memory: MappingMemory = {
      find: (k) => inner.find(k),
      save: (e) => inner.save(e),
      touch: async () => {
        throw new Error("touch failed");
      },
    };
    await expect(recallMapping(memory, TENANT, "customer", customers)).resolves.toBeNull();
  });

  it("save refused: a throwing save resolves false and never throws (import carries on)", async () => {
    const memory = throwingMemory();
    await expect(
      saveConfirmedMapping(memory, TENANT, "customer", customers, { "Cust Name": "name" }),
    ).resolves.toBe(false);
    expect(memory.calls).toEqual(["save"]);
  });

  it("sends only column and field names, never row data", async () => {
    const seen: unknown[] = [];
    const memory: MappingMemory = {
      find: async (k) => {
        seen.push(k);
        return null;
      },
      save: async (e) => {
        seen.push(e);
        return { ...e, savedAt: "", useCount: 0 };
      },
      touch: async () => {},
    };
    await recallMapping(memory, TENANT, "customer", customers);
    await saveConfirmedMapping(memory, TENANT, "customer", customers, { "Cust Name": "name" });
    const wire = JSON.stringify(seen);
    for (const secret of ["Acme", "0412", "acme.com.au"]) expect(wire).not.toContain(secret);
  });
});
