/**
 * Tidy pass — gap classification and messages must be plain English and
 * correctly typed, never a raw ValidationError.kind leaked to the UI.
 *
 * Regression: the gap-type check compared against 'required_field_missing',
 * but the validator's real kind is 'field_required' — so every required-field
 * gap was mis-badged "Invalid format" and, since field_required carries no
 * .message/.reason, rendered the raw kind string ("field_required") as the
 * issue text instead of a sentence.
 */

import { describe, it, expect } from "vitest";
import { runTidyPass, commitTidyFixes } from "../src/tidy-pass.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";
import type { TidyFix } from "../src/tidy-types.js";

const TENANT = "7dee117c-98bd-4d39-af8c-2c81d02a1e85";

function fakeClient(staffRows: unknown[]): SupabaseLikeClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === "eq_tidy_read_entity" && params.p_table === "staff") {
        return { data: staffRows, error: null };
      }
      return { data: [], error: null };
    },
  } as unknown as SupabaseLikeClient;
}

describe("runTidyPass — required-field gaps", () => {
  it("classifies a missing required field as required_missing, not format_invalid", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: null,
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap).toBeDefined();
    expect(gap!.gap_type).toBe("required_missing");
  });

  it("never surfaces the raw ValidationError.kind as the message", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: null,
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap!.message).not.toBe("field_required");
    expect(gap!.message).toBe("Employment Type is required.");
  });

  it("gives an invalid enum value a readable message with the field name spelled out", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: "Direct",
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap).toBeDefined();
    expect(gap!.message).toContain("Direct");
    expect(gap!.message).not.toBe("field_enum_invalid");
  });

  it("carries the schema's enum values on an invalid-value gap, so the UI can render a dropdown", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: "Direct",
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap!.allowed_values).toBeDefined();
    expect(gap!.allowed_values!.length).toBeGreaterThan(0);
    expect(gap!.allowed_values).not.toContain("Direct");
  });

  it("still carries allowed_values on a blank (required_missing) enum field, not just an invalid-value one", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: null,
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap!.gap_type).toBe("required_missing");
    expect(gap!.allowed_values).toBeDefined();
    expect(gap!.allowed_values!.length).toBeGreaterThan(0);
  });
});

describe("commitTidyFixes", () => {
  // eq_create_intake_event / eq_finish_intake_event were dropped from every
  // tenant plane 2026-05-24 (same finding as commit-canonical.ts, PR #142).
  // This mock errors on any RPC name it doesn't explicitly recognise — the
  // permissive fakeClient() above (blanket { data: [], error: null }) is
  // exactly the kind of mock that let the real bug hide for months.
  function makeCommitMock(state: {
    rpcCalls: string[];
    commitError?: { message: string };
    commitData?: { applied: number; skipped: number };
  }): SupabaseLikeClient {
    return {
      rpc: async (name: string, _params: unknown) => {
        state.rpcCalls.push(name);
        if (name === "eq_tidy_commit_fixes") {
          if (state.commitError) return { data: null, error: state.commitError };
          return { data: state.commitData ?? { applied: 1, skipped: 0 }, error: null };
        }
        return { data: null, error: { message: `mock: no handler for rpc "${name}"` } };
      },
    } as unknown as SupabaseLikeClient;
  }

  const FIX: TidyFix = {
    entity: "staff",
    table: "staff",
    row_id: "s-1",
    row_label: "Tom Ivicevic",
    field: "employment_type",
    fix_type: "auto_normalise",
    old_value: "Direct",
    new_value: "employee",
  };

  it("regression: never calls the retired eq_create_intake_event / eq_finish_intake_event RPCs", async () => {
    // Reported live: this used to throw "Session expired" or "Failed to
    // create tidy intake event" before eq_tidy_commit_fixes ever ran, on
    // EVERY call — EQ Shell's real tenant client never carries a Supabase
    // Auth session, so the old unconditional auth.getUser() check always
    // failed there regardless of whether the user was signed in.
    const state = { rpcCalls: [] as string[] };
    const supabase = makeCommitMock(state);

    const result = await commitTidyFixes({ supabase, tenantId: "tenant-1", fixes: [FIX] });

    expect(result.applied).toBe(1);
    expect(state.rpcCalls).toEqual(["eq_tidy_commit_fixes"]);
  });

  it("does not call eq_tidy_commit_fixes at all for an empty fix list", async () => {
    const state = { rpcCalls: [] as string[] };
    const supabase = makeCommitMock(state);

    const result = await commitTidyFixes({ supabase, tenantId: "tenant-1", fixes: [] });

    expect(result).toEqual({ intakeId: null, applied: 0, skipped: 0, errors: [] });
    expect(state.rpcCalls).toEqual([]);
  });

  it("surfaces an eq_tidy_commit_fixes failure as a thrown error", async () => {
    const state = { rpcCalls: [] as string[], commitError: { message: "tenant_id mismatch" } };
    const supabase = makeCommitMock(state);

    await expect(
      commitTidyFixes({ supabase, tenantId: "tenant-1", fixes: [FIX] }),
    ).rejects.toThrow(/tenant_id mismatch/);
  });
});
