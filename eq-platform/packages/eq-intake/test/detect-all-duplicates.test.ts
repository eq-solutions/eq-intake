/**
 * detectAllDuplicates — reads every non-PII column through
 * eq_tidy_read_entity_columns, so the completeness tie-break (and the
 * suggested survivor) is the same with or without entity.view_pii. A failed
 * read throws rather than reporting "no duplicates" for that entity.
 */

import { describe, it, expect } from "vitest";
import { detectAllDuplicates } from "../src/duplicate-detect.js";
import { PII_COLUMNS } from "../src/entity-columns.js";
import { fakeEntityRpc } from "./fake-entity-rpc.js";

const STAFF = [
  { staff_id: "s-1", first_name: "Tom", last_name: "Ivicevic", active: true, trade: "Electrician", email: "t@example.com" },
  { staff_id: "s-2", first_name: "Tom", last_name: "Ivicevic", active: true, trade: null,          email: null },
];

describe("detectAllDuplicates", () => {
  it("never asks for a PII column", async () => {
    const { client, calls } = fakeEntityRpc({ staff: STAFF }, { canViewPii: true });

    await detectAllDuplicates(client);

    expect(calls.map((c) => c.table).sort()).toEqual(["assets", "contacts", "customers", "sites", "staff"]);
    for (const { table, columns } of calls) {
      const pii = PII_COLUMNS[table as keyof typeof PII_COLUMNS];
      expect(columns.filter((c) => pii.includes(c))).toEqual([]);
    }
  });

  it("finds the same cluster and survivor whether or not the viewer can see PII", async () => {
    const withPii    = await detectAllDuplicates(fakeEntityRpc({ staff: STAFF }, { canViewPii: true }).client);
    const withoutPii = await detectAllDuplicates(fakeEntityRpc({ staff: STAFF }, { canViewPii: false }).client);

    const staffWith    = withPii.find((r) => r.entity === "staff")!;
    const staffWithout = withoutPii.find((r) => r.entity === "staff")!;
    expect(staffWith.clusters).toHaveLength(1);
    expect(staffWithout).toEqual(staffWith);
  });

  it("throws on a failed read instead of reporting no duplicates", async () => {
    const { client } = fakeEntityRpc({ staff: STAFF }, { errorFor: "sites" });

    await expect(detectAllDuplicates(client)).rejects.toThrow(/sites/);
  });
});
