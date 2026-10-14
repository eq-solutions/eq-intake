import { describe, it, expect } from "vitest";
import { fetchCanonicalRows } from "../src/fetch-canonical.js";
import { fakeEntityRpc } from "./fake-entity-rpc.js";

const contacts = [{ contact_id: "c1", first_name: "Ann", email: "ann@example.com" }];

describe("fetchCanonicalRows", () => {
  it("reads contacts through the projected RPC, not a table select", async () => {
    const { client, calls } = fakeEntityRpc({ contacts }, { canViewPii: true });
    const rows = await fetchCanonicalRows(client, "contacts");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe("contacts");
    expect(rows[0]).toMatchObject({ contact_id: "c1", email: "ann@example.com" });
  });

  it("omits PII keys for a caller without view_pii", async () => {
    const { client } = fakeEntityRpc({ contacts });
    const rows = await fetchCanonicalRows(client, "contacts");
    expect(rows[0]).toMatchObject({ contact_id: "c1", first_name: "Ann" });
    expect(rows[0]).not.toHaveProperty("email");
  });

  it("maps aliases (worker -> staff) and returns [] for unknown entities", async () => {
    const { client, calls } = fakeEntityRpc({ staff: [] });
    expect(await fetchCanonicalRows(client, "worker")).toEqual([]);
    expect(calls[0]!.table).toBe("staff");
    expect(await fetchCanonicalRows(client, "nonsense")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("throws the RPC error with the table name", async () => {
    const { client } = fakeEntityRpc({}, { errorFor: "contacts" });
    await expect(fetchCanonicalRows(client, "contacts")).rejects.toThrow(/fetchCanonicalRows\(contacts\): mock: contacts refused/);
  });
});

import { withheldPiiColumns } from "../src/fetch-canonical.js";

describe("withheldPiiColumns", () => {
  it("lists PII columns absent from the rows", async () => {
    const { client } = fakeEntityRpc({ contacts });
    const rows = await fetchCanonicalRows(client, "contacts");
    expect(withheldPiiColumns("contacts", rows)).toEqual(["email", "work_phone", "mobile_phone", "fax", "notes"]);
  });

  it("is empty when the viewer can see PII, or there are no rows", async () => {
    const { client } = fakeEntityRpc({ contacts }, { canViewPii: true });
    expect(withheldPiiColumns("contacts", await fetchCanonicalRows(client, "contacts"))).toEqual([]);
    expect(withheldPiiColumns("contacts", [])).toEqual([]);
    expect(withheldPiiColumns("nonsense", [{ a: 1 }])).toEqual([]);
  });
});
