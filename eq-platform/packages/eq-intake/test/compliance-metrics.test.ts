/**
 * computeComplianceMetrics — reads through eq_tidy_read_entity_columns, and
 * reports a PII field the viewer can't see as null ("can't see"), never as
 * 0 ("nobody has one").
 */

import { describe, it, expect } from "vitest";
import { computeComplianceMetrics } from "../src/compliance-metrics.js";
import { fakeEntityRpc } from "./fake-entity-rpc.js";

const STAFF = [
  { staff_id: "s-1", active: true,  email: "a@example.com", phone: "0400000000", trade: "Electrician", emergency_contact_name: "Sam" },
  { staff_id: "s-2", active: true,  email: null,            phone: null,         trade: null,          emergency_contact_name: null },
  { staff_id: "s-3", active: false, email: "c@example.com", phone: null,         trade: "Apprentice",  emergency_contact_name: null },
];
const LICENCES = [{ licence_id: "l-1" }, { licence_id: "l-2" }];

describe("computeComplianceMetrics", () => {
  it("counts filled fields on active staff when the viewer can see PII", async () => {
    const { client } = fakeEntityRpc({ staff: STAFF, licences: LICENCES }, { canViewPii: true });

    const m = await computeComplianceMetrics(client);

    expect(m.staff).toEqual({
      total: 2, has_email: 1, has_phone: 1, has_trade: 1, has_emergency_contact: 1,
    });
    expect(m.licences.total).toBe(2);
  });

  it("returns null, not 0, for PII fields the viewer can't see", async () => {
    const { client } = fakeEntityRpc({ staff: STAFF, licences: LICENCES }, { canViewPii: false });

    const m = await computeComplianceMetrics(client);

    expect(m.staff.total).toBe(2);
    expect(m.staff.has_email).toBeNull();
    expect(m.staff.has_phone).toBeNull();
    expect(m.staff.has_emergency_contact).toBeNull();
    expect(m.staff.has_trade).toBe(1);
  });

  it("throws on a failed read instead of reporting zeros", async () => {
    const { client } = fakeEntityRpc({ staff: STAFF, licences: LICENCES }, { errorFor: "staff" });

    await expect(computeComplianceMetrics(client)).rejects.toThrow(/staff/);
  });
});
