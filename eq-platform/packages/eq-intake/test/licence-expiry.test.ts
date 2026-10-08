/**
 * Licence expiry check — the summary must reflect the licence data itself,
 * even when alert persistence (eq_quality_upsert_alert) fails.
 *
 * Regression: on sks-canonical the upsert RPC was not executable by
 * `authenticated`, every upsert failed, and the old code only counted a
 * licence after a successful upsert — so the dashboard reported
 * "All N licences current" over a 9-months-expired safety-critical licence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLicenceExpiryCheck } from "../src/licence-expiry-check.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

const TENANT = "7dee117c-98bd-4d39-af8c-2c81d02a1e85";

interface RpcCall {
  name:   string;
  params: Record<string, unknown>;
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function licence(id: string, expiryDays: number | null) {
  return {
    licence_id:   id,
    licence_type: "lvr",
    expiry_date:  expiryDays === null ? null : isoDaysFromNow(expiryDays),
    staff_id:     "s-1",
    staff_name:   "Huon Henne",
  };
}

function fakeClient(
  licences: unknown[],
  opts: { upsertError?: string } = {},
): { client: SupabaseLikeClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "eq_tidy_read_entity_columns") {
        return { data: licences, error: null };
      }
      if (name === "eq_quality_upsert_alert") {
        return opts.upsertError
          ? { data: null, error: { message: opts.upsertError } }
          : { data: "alert-id", error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  } as unknown as SupabaseLikeClient;
  return { client, calls };
}

describe("runLicenceExpiryCheck", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts an expired licence as critical and upserts an alert", async () => {
    const { client, calls } = fakeClient([
      licence("l-expired", -270), // ~9 months expired
      licence("l-fine", 300),     // outside the 60-day window
    ]);

    const summary = await runLicenceExpiryCheck(client, TENANT);

    expect(summary).toMatchObject({
      records_total: 2,
      total:         1,
      critical:      1,
      warning:       0,
      info:          0,
      alerts_failed: 0,
    });

    const upserts = calls.filter((c) => c.name === "eq_quality_upsert_alert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].params).toMatchObject({
      p_tenant_id:  TENANT,
      p_entity_id:  "l-expired",
      p_severity:   "critical",
      p_alert_type: "licence_expiry",
    });
  });

  it("still counts severities when every alert upsert fails (regression)", async () => {
    const { client } = fakeClient(
      [
        licence("l-expired", -270),
        licence("l-soon", 20),   // warning band
        licence("l-later", 45),  // info band
        licence("l-fine", 300),
      ],
      { upsertError: "permission denied for function eq_quality_upsert_alert" },
    );

    const summary = await runLicenceExpiryCheck(client, TENANT);

    // The old behaviour returned total: 0 here — rendered as "All 4 licences
    // current" despite an expired licence. The counts must come from the data.
    expect(summary).toMatchObject({
      records_total: 4,
      total:         3,
      critical:      1,
      warning:       1,
      info:          1,
      alerts_failed: 3,
    });
  });

  it("skips rows without an expiry date but includes them in records_total", async () => {
    const { client, calls } = fakeClient([licence("l-no-expiry", null)]);

    const summary = await runLicenceExpiryCheck(client, TENANT);

    expect(summary).toMatchObject({ records_total: 1, total: 0, alerts_failed: 0 });
    expect(calls.filter((c) => c.name === "eq_quality_upsert_alert")).toHaveLength(0);
  });

  it("throws when the licence read itself fails", async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as SupabaseLikeClient;

    await expect(runLicenceExpiryCheck(client, TENANT)).rejects.toThrow(/failed to read licences/);
  });
});
