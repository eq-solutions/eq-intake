/**
 * commit-canonical tests — uses a hand-built mock Supabase client.
 *
 * We don't pull in @supabase/supabase-js — the helper is structurally typed
 * via SupabaseLikeClient, so the mocks just need shape compatibility.
 *
 * Coverage:
 * - Happy path: customer + site + contact all commit, FK resolution works
 * - Empty bundle (no entities provided) returns empty result
 * - Customer-only commit (no FK resolution path)
 * - RPC error stops the bundle before FK-dependent entities
 * - Auth error throws before any intake_event is created
 * - inferMapping resolves SimPRO headers via x-eq-source-aliases
 *
 * NOTE: All shell_control and app_data access goes through SECURITY DEFINER
 * RPCs (eq_create_intake_event, eq_finish_intake_event,
 * eq_read_customers_by_intake) because those schemas are not REST-exposed.
 * Tests verify the RPC call shapes rather than from() call shapes.
 */

import { describe, it, expect, vi } from "vitest";
import {
  commitBundleToCanonical,
  inferMapping,
  previewMultiValueCandidates,
  previewUnmappedRequiredFields,
  previewDuplicateRows,
  previewDuplicatesAgainstLive,
  type SupabaseLikeClient,
  type StageCommitFn,
} from "../src/canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

interface MockState {
  rpcCalls: Array<{ name: string; params: unknown }>;
  /** Override responses for eq_intake_commit_batch calls keyed by p_table. */
  commitBatchResponse?: (params: { p_table: string }) => {
    data: unknown;
    error: { message: string } | null;
  };
  /** Customers to return from eq_read_customers_by_intake. */
  customerLookupRows?: Array<{ customer_id: string; external_id: string }>;
  authUser?: { id: string } | null;
}

function makeMockSupabase(state: MockState): SupabaseLikeClient {
  return {
    from: (_table: string) => ({
      // from() is no longer called for eq_intake_events or customers —
      // all event lifecycle and FK reads go through RPCs (migrations 016, 019).
      // Keep the shape so structural typing still compiles.
      insert: async () => ({ data: null, error: null }),
      update: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
      select: (_cols: string) => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }) as unknown as ReturnType<SupabaseLikeClient["from"]>,

    rpc: async (name: string, params: unknown) => {
      state.rpcCalls.push({ name, params });

      // Lifecycle RPCs — always succeed unless explicitly overridden.
      if (name === "eq_create_intake_event") return { data: null, error: null };
      if (name === "eq_finish_intake_event") return { data: null, error: null };
      if (name === "eq_read_customers_by_intake") {
        return { data: state.customerLookupRows ?? [], error: null };
      }

      // eq_intake_commit_batch — delegate to override or default success.
      if (state.commitBatchResponse) {
        return state.commitBatchResponse(params as { p_table: string });
      }
      const rows = (params as { p_rows?: unknown[] }).p_rows ?? [];
      return {
        data: [{ committed_count: rows.length, committed_ids: rows.map((_, i) => `uuid-${i}`) }],
        error: null,
      };
    },

    auth: {
      getUser: async () =>
        state.authUser === null
          ? { data: { user: null }, error: { message: "no auth" } }
          : {
              data: { user: state.authUser ?? { id: "test-user-uuid" } },
              error: null,
            },
    },
  };
}

const TENANT = "00000000-0000-4000-8000-000000000001";

// Realistic SimPRO-shaped headers, matching x-eq-source-aliases on the
// canonical customer/site/contact schemas.
const CUSTOMER_SHEET = {
  sheetName: "csv",
  headerRow: [
    "simPRO Customer ID",
    "Company Name",
    "First Name",
    "Last Name",
    "ABN",
    "Street Address",
    "Suburb",
    "State",
    "Postcode",
    "Email",
    "Primary Phone",
  ],
  rows: [
    {
      "simPRO Customer ID": "31",
      "Company Name": "Equinix (Australia) Enterprises Pty Ltd",
      "First Name": "",
      "Last Name": "",
      "ABN": "26 605 084 473",
      "Street Address": "Unit B, 639 Gardeners Road",
      "Suburb": "Mascot",
      "State": "NSW",
      "Postcode": "2020",
      "Email": "payable-au@ap.equinix.com",
      "Primary Phone": "0283372000",
    },
  ],
  meta: {
    encoding: "utf-8",
    delimiter: ",",
    totalRows: 1,
    emptyRowsSkipped: 0,
    malformedRows: 0,
    malformed: [],
    bomDetected: false,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inferMapping", () => {
  it("maps SimPRO Customer ID → external_id via x-eq-source-aliases", () => {
    // Pull the real customer schema via the same import path the helper uses
    // — async dynamic-import to avoid a hard import at the top of the file.
    return import("../src/canonical/commit-canonical.js").then(({ inferMapping }) => {
      // Use a tiny schema shape rather than the real one, so this test stays focused
      // on the alias-matching logic.
      const schema = {
        "x-eq-entity": "customer",
        properties: {
          external_id: {
            type: "string",
            "x-eq-source-aliases": ["simpro_customer_id", "customer_id"],
          },
          company_name: {
            type: "string",
            "x-eq-source-aliases": ["company_name", "company", "name"],
          },
          ignored_field: { type: "string" },
        },
      } as unknown as Parameters<typeof inferMapping>[1];

      const mapping = inferMapping(
        ["simPRO Customer ID", "Company Name", "Some Unmapped Column"],
        schema,
      );
      expect(mapping).toEqual({
        "simPRO Customer ID": "external_id",
        "Company Name": "company_name",
        "Some Unmapped Column": null,
      });
    });
  });

  it("falls back to normalised field name when no alias matches", () => {
    const schema = {
      "x-eq-entity": "test",
      properties: {
        first_name: { type: "string" }, // no aliases declared
      },
    } as unknown as Parameters<typeof inferMapping>[1];
    const mapping = inferMapping(["First Name", "first_name"], schema);
    expect(mapping["First Name"]).toBe("first_name");
    expect(mapping["first_name"]).toBe("first_name");
  });
});

describe("commitBundleToCanonical — auth", () => {
  it("throws when no authenticated user", async () => {
    const state: MockState = {
      rpcCalls: [],
      authUser: null,
    };
    const supabase = makeMockSupabase(state);
    await expect(
      commitBundleToCanonical({
        supabase,
        bundle: { customer: CUSTOMER_SHEET as never },
        tenantId: TENANT,
      }),
    ).rejects.toThrow(/Cannot commit canonical without an authenticated user/);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("uses an explicitly-supplied createdBy without ever calling auth.getUser", async () => {
    // Mirrors EQ Shell's real tenant-data clients: no Supabase Auth session
    // exists (authUser: null would normally throw — see the test above), but
    // the host already knows who's signed in and passes it directly.
    const state: MockState = {
      rpcCalls: [],
      authUser: null,
    };
    const supabase = makeMockSupabase(state);
    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: CUSTOMER_SHEET as never },
      tenantId: TENANT,
      createdBy: "shell-session-user-id",
    });
    expect(result.bundleSuccess).toBe(true);
    const createEventCall = state.rpcCalls.find((c) => c.name === "eq_create_intake_event");
    expect((createEventCall?.params as { p_created_by?: string } | undefined)?.p_created_by).toBe(
      "shell-session-user-id",
    );
  });
});

describe("commitBundleToCanonical — empty bundle", () => {
  it("returns success with empty perEntity array", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const result = await commitBundleToCanonical({
      supabase,
      bundle: {},
      tenantId: TENANT,
    });
    expect(result.bundleSuccess).toBe(true);
    expect(result.perEntity).toEqual([]);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("commitBundleToCanonical — customer-only happy path", () => {
  it("creates intake event, calls RPC, finalises event", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: CUSTOMER_SHEET as never },
      tenantId: TENANT,
      sourceFilename: "customer_export.csv",
    });

    expect(result.bundleSuccess).toBe(true);
    expect(result.perEntity).toHaveLength(1);

    // Verify the intake event was created via RPC (not direct table insert).
    const createCall = state.rpcCalls.find((c) => c.name === "eq_create_intake_event");
    expect(createCall).toBeDefined();
    const createParams = createCall?.params as Record<string, unknown>;
    expect(createParams.p_tenant_id).toBe(TENANT);
    expect(createParams.p_entity).toBe("customer");
    expect(createParams.p_source_filename).toBe("customer_export.csv");
    expect(createParams.p_status).toBe("committing");

    // Verify commit batch was called.
    const commitCalls = state.rpcCalls.filter((c) => c.name === "eq_intake_commit_batch");
    expect(commitCalls).toHaveLength(1);
    expect((commitCalls[0]?.params as { p_table: string }).p_table).toBe("customers");

    // Verify the intake event was finalised via RPC (not direct table update).
    const finishCall = state.rpcCalls.find((c) => c.name === "eq_finish_intake_event");
    expect(finishCall).toBeDefined();
    expect((finishCall?.params as Record<string, unknown>).p_status).toBe("completed");
  });
});

describe("commitBundleToCanonical — RPC failure stops bundle early", () => {
  it("does not commit later entities when an earlier RPC fails", async () => {
    const state: MockState = {
      rpcCalls: [],
      commitBatchResponse: (p) => {
        if (p.p_table === "customers") {
          return { data: null, error: { message: "tenant_id mismatch" } };
        }
        return { data: [{ committed_count: 0, committed_ids: [] }], error: null };
      },
    };
    const supabase = makeMockSupabase(state);

    const result = await commitBundleToCanonical({
      supabase,
      bundle: {
        customer: CUSTOMER_SHEET as never,
        site: CUSTOMER_SHEET as never, // reused shape — just to prove site/contact get skipped
        contact: CUSTOMER_SHEET as never,
      },
      tenantId: TENANT,
    });

    expect(result.bundleSuccess).toBe(false);
    // Only one commit_batch call — the failure short-circuited before site/contact.
    const commitCalls = state.rpcCalls.filter((c) => c.name === "eq_intake_commit_batch");
    expect(commitCalls).toHaveLength(1);
    expect(result.perEntity).toHaveLength(1);
    expect(result.perEntity[0]?.fatalError).toContain("tenant_id mismatch");

    // The intake event for the failed entity is closed as 'failed' via RPC.
    const finishCall = state.rpcCalls.find((c) => c.name === "eq_finish_intake_event");
    expect(finishCall).toBeDefined();
    expect((finishCall?.params as Record<string, unknown>).p_status).toBe("failed");
  });
});

describe("commitBundleToCanonical — FK resolution between customer and contact", () => {
  it("uses the customer external_id → customer_id map to resolve contact.customer_id", async () => {
    const state: MockState = {
      rpcCalls: [],
      customerLookupRows: [{ customer_id: "11111111-2222-4333-8444-555566667777", external_id: "31" }],
    };
    const supabase = makeMockSupabase(state);

    const CONTACT_SHEET = {
      sheetName: "csv",
      headerRow: ["simPRO Contact ID", "simPRO Customer ID", "First Name", "Last Name", "Email"],
      rows: [
        {
          "simPRO Contact ID": "100",
          "simPRO Customer ID": "31",
          "First Name": "Ben",
          "Last Name": "Dunn",
          "Email": "bdunn@ap.equinix.com",
        },
      ],
      meta: {
        encoding: "utf-8",
        delimiter: ",",
        totalRows: 1,
        emptyRowsSkipped: 0,
        malformedRows: 0,
        malformed: [],
        bomDetected: false,
      },
    };

    const result = await commitBundleToCanonical({
      supabase,
      bundle: {
        customer: CUSTOMER_SHEET as never,
        contact: CONTACT_SHEET as never,
      },
      tenantId: TENANT,
    });

    expect(result.bundleSuccess).toBe(true);

    // Two commit_batch calls — one per entity.
    const commitCalls = state.rpcCalls.filter((c) => c.name === "eq_intake_commit_batch");
    expect(commitCalls).toHaveLength(2);

    // FK read-back was done via RPC, not from("customers").
    const fkReadCall = state.rpcCalls.find((c) => c.name === "eq_read_customers_by_intake");
    expect(fkReadCall).toBeDefined();

    // Contact RPC's p_rows should contain customer_id resolved via FK map.
    const contactCommit = commitCalls.find(
      (c) => (c.params as { p_table: string }).p_table === "contacts",
    );
    expect(contactCommit).toBeDefined();
    const contactRows = (contactCommit?.params as { p_rows: Array<Record<string, unknown>> }).p_rows;
    const resolved = contactRows.find((r) => r.customer_id === "11111111-2222-4333-8444-555566667777");
    expect(resolved).toBeDefined();
  });
});

describe("commitBundleToCanonical — flagged rows carry field + recordId (Fix/Skip scope)", () => {
  // One clean row, one with an unparseable phone — @eq/validation flags the
  // latter (phone_kept_raw) rather than rejecting it, same shape as
  // @eq/validation's own staff-messy.csv fixture (Tom O'Sullivan / "no mobile").
  const STAFF_SHEET_MESSY = {
    sheetName: "csv",
    headerRow: ["first_name", "last_name", "email", "phone", "employment_type", "trade", "start_date", "active"],
    rows: [
      {
        first_name: "James", last_name: "Patel", email: "james.patel@example.com.au",
        phone: "+61412345678", employment_type: "employee", trade: "electrical",
        start_date: "2022-03-01", active: "true",
      },
      {
        first_name: "Tom", last_name: "O'Sullivan", email: "tom.osullivan@example.com.au",
        phone: "no mobile", employment_type: "employee", trade: "electrical",
        start_date: "2022-05-05", active: "true",
      },
    ],
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: 2,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  };

  it("attaches the flagged field and the row's real canonical id when committed_ids lines up", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { staff: STAFF_SHEET_MESSY as never },
      tenantId: TENANT,
    });

    const staffResult = result.perEntity.find((r) => r.entity === "staff");
    expect(staffResult).toBeDefined();
    expect(staffResult?.flaggedCount).toBeGreaterThan(0);
    expect(staffResult?.flaggedRows.length).toBeGreaterThan(0);

    const flagged = staffResult!.flaggedRows[0]!;
    expect(flagged.field).toBe("phone");
    expect(flagged.reasons.join(" ")).toMatch(/phone/i);
    // Mock's default committed_ids are `uuid-${index in the chunk}` — the
    // flagged row is the tail of toCommit (after the valid rows), so its id
    // is whatever the mock assigned at that position, not necessarily uuid-0.
    expect(flagged.recordId).toBeDefined();
    expect(flagged.recordId).toMatch(/^uuid-\d+$/);
  });

  it("leaves recordId undefined when the RPC's id array doesn't line up with the chunk sent", async () => {
    const state: MockState = {
      rpcCalls: [],
      // Simulates the SQL's `if v_id is not null` guard producing a short
      // array — must never be guessed onto the wrong row.
      commitBatchResponse: () => ({
        data: [{ committed_count: 1, committed_ids: ["only-one-id"] }],
        error: null,
      }),
    };
    const supabase = makeMockSupabase(state);

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { staff: STAFF_SHEET_MESSY as never },
      tenantId: TENANT,
    });

    const staffResult = result.perEntity.find((r) => r.entity === "staff");
    expect(staffResult?.flaggedRows.length).toBeGreaterThan(0);
    expect(staffResult?.flaggedRows[0]?.recordId).toBeUndefined();
  });
});

describe("previewMultiValueCandidates", () => {
  const sheet = (rows: Record<string, unknown>[], headerRow = ["Site Name"]) => ({
    sheetName: "csv",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: rows.length,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  });

  it("flags a comma-joined site name against the real site schema", () => {
    const candidates = previewMultiValueCandidates(
      sheet([{ "Site Name": "Wollongong, Malabar" }, { "Site Name": "Single Site" }]) as never,
      "site",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ field: "name", sourceColumn: "Site Name", affectedRowCount: 1 });
    expect(candidates[0]?.sampleValues).toEqual(["Wollongong, Malabar"]);
  });

  it("never fires on a field with no x-eq-multi-value hint — a comma in a legal name is not a split", () => {
    const candidates = previewMultiValueCandidates(
      sheet([{ "Company Name": "Acme, Inc" }], ["Company Name"]) as never,
      "customer",
    );
    expect(candidates).toEqual([]);
  });

  it("returns nothing when no cell actually has 2+ segments", () => {
    expect(previewMultiValueCandidates(sheet([{ "Site Name": "Wollongong" }]) as never, "site")).toEqual([]);
  });

  it("a manual mapping is honoured the same as an inferred one", () => {
    // "Location" doesn't exactly match any of site.name's aliases, so without
    // a manual override this would score zero candidates too — proving the
    // manual pick is what makes the multi-value check see the column at all.
    const candidates = previewMultiValueCandidates(
      sheet([{ Location: "Wollongong, Malabar" }], ["Location"]) as never,
      "site",
      { Location: "name" },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ field: "name", sourceColumn: "Location" });
  });
});

describe("previewUnmappedRequiredFields", () => {
  const sheet = (rows: Record<string, unknown>[], headerRow: string[]) => ({
    sheetName: "csv",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: rows.length,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  });

  it("flags site.name when no header exactly matches its aliases", () => {
    // "Description" deliberately isn't one of site.name's aliases
    // (site_name/location/location_name/project_name/site).
    const missing = previewUnmappedRequiredFields(
      sheet([{ Description: "Wollongong" }], ["Description"]) as never,
      "site",
    );
    expect(missing).toEqual([{ field: "name", reason: "required", availableHeaders: ["Description"] }]);
  });

  it("does not flag site_id/tenant_id/active — required, but generated on commit or defaulted", () => {
    const missing = previewUnmappedRequiredFields(
      sheet([{ "Site Name": "Wollongong" }], ["Site Name"]) as never,
      "site",
    );
    expect(missing).toEqual([]);
  });

  it("flags customer's cross-field name rule, not a flat required entry", () => {
    const missing = previewUnmappedRequiredFields(
      sheet([{ Phone: "0400000000" }], ["Phone"]) as never,
      "customer",
    );
    expect(missing).toEqual([
      { field: "company_name", reason: "customer_needs_a_name", availableHeaders: ["Phone"] },
    ]);
  });

  it("does not flag customer when only first_name/last_name are mapped (no company)", () => {
    const missing = previewUnmappedRequiredFields(
      sheet([{ "First Name": "Mark", "Last Name": "Dobson" }], ["First Name", "Last Name"]) as never,
      "customer",
    );
    expect(missing).toEqual([]);
  });

  it("a manual mapping clears the warning it resolves", () => {
    const withoutOverride = previewUnmappedRequiredFields(
      sheet([{ Clients: "Orise" }], ["Clients"]) as never,
      "customer",
    );
    expect(withoutOverride).toHaveLength(1);

    const withOverride = previewUnmappedRequiredFields(
      sheet([{ Clients: "Orise" }], ["Clients"]) as never,
      "customer",
      { Clients: "company_name" },
    );
    expect(withOverride).toEqual([]);
  });
});

describe("previewDuplicateRows", () => {
  const sheet = (rows: Record<string, unknown>[], headerRow: string[]) => ({
    sheetName: "csv",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: rows.length,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  });

  it("flags two customer rows that are the same company under trivially different spelling", () => {
    const candidates = previewDuplicateRows(
      sheet(
        [{ Clients: "Ergo Group" }, { Clients: "Kilo Group" }, { Clients: "ERGO GROUP PTY LTD" }],
        ["Clients"],
      ) as never,
      "customer",
      { Clients: "company_name" },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ rowIndices: [0, 2] });
    expect(candidates[0]?.values).toEqual(["Ergo Group", "ERGO GROUP PTY LTD"]);
  });

  it("does not flag genuinely different customers", () => {
    const candidates = previewDuplicateRows(
      sheet([{ Clients: "Orise" }, { Clients: "ARA" }, { Clients: "D4C Water" }], ["Clients"]) as never,
      "customer",
      { Clients: "company_name" },
    );
    expect(candidates).toEqual([]);
  });

  it("does not flag 'SKS' against 'SKS Technology' — genuinely different strings by dice, not this check's job", () => {
    // Documents the boundary deliberately, rather than leaving it to be
    // rediscovered by surprise: this is a *within-batch* check. Catching a
    // near-miss against an ALREADY-COMMITTED customer (the actual Madagins
    // case) needs reading existing customers, which has no RPC yet — see
    // previewDuplicateRows's own doc comment.
    const candidates = previewDuplicateRows(
      sheet([{ Clients: "SKS" }, { Clients: "SKS Technology" }], ["Clients"]) as never,
      "customer",
      { Clients: "company_name" },
    );
    expect(candidates).toEqual([]);
  });

  it("flags two contact rows with the same first+last name", () => {
    const candidates = previewDuplicateRows(
      sheet(
        [
          { First: "Mark", Last: "Dobson" },
          { First: "Adam", Last: "Shepherd" },
          { First: "Mark", Last: "Dobson" },
        ],
        ["First", "Last"],
      ) as never,
      "contact",
      { First: "first_name", Last: "last_name" },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ rowIndices: [0, 2] });
  });

  it("returns nothing for an entity with no defined identity field (licence)", () => {
    const candidates = previewDuplicateRows(
      sheet([{ X: "a" }, { X: "a" }], ["X"]) as never,
      "licence",
    );
    expect(candidates).toEqual([]);
  });

  it("a manual mapping is honoured the same as an inferred one", () => {
    const candidates = previewDuplicateRows(
      sheet([{ Name: "Ergo Group" }, { Name: "Ergo Group" }], ["Name"]) as never,
      "customer",
      { Name: "company_name" },
    );
    expect(candidates).toHaveLength(1);
  });
});

describe("previewDuplicatesAgainstLive", () => {
  const sheet = (rows: Record<string, unknown>[], headerRow: string[]) => ({
    sheetName: "csv",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: rows.length,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  });

  it("flags a new row that looks like a customer already saved in EQ — the Madagins case", async () => {
    const lookup = vi.fn(async (entity: string) => {
      expect(entity).toBe("customers"); // singular CanonicalEntity -> plural table name
      return [{ customer_id: "cust-1", company_name: "ERGO GROUP PTY LTD", active: true }];
    });
    const candidates = await previewDuplicatesAgainstLive(
      sheet([{ Clients: "Ergo Group" }], ["Clients"]) as never,
      "customer",
      lookup,
      { Clients: "company_name" },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      rowIndex: 0,
      newValue: "Ergo Group",
      existingId: "cust-1",
      existingLabel: "ERGO GROUP PTY LTD",
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not flag a genuinely new customer", async () => {
    const lookup = vi.fn(async () => [
      { customer_id: "cust-1", company_name: "ERGO GROUP PTY LTD", active: true },
    ]);
    const candidates = await previewDuplicatesAgainstLive(
      sheet([{ Clients: "D4C Water" }], ["Clients"]) as never,
      "customer",
      lookup,
      { Clients: "company_name" },
    );
    expect(candidates).toEqual([]);
  });

  it("returns [] for licence without calling the lookup — no identity fields defined, same boundary as previewDuplicateRows", async () => {
    const lookup = vi.fn(async () => []);
    const candidates = await previewDuplicatesAgainstLive(
      sheet([{ X: "a" }], ["X"]) as never,
      "licence",
      lookup,
    );
    expect(candidates).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("degrades to [] rather than throwing when the live lookup fails", async () => {
    const lookup = vi.fn(async () => { throw new Error("network error"); });
    const candidates = await previewDuplicatesAgainstLive(
      sheet([{ Clients: "Ergo Group" }], ["Clients"]) as never,
      "customer",
      lookup,
      { Clients: "company_name" },
    );
    expect(candidates).toEqual([]);
  });
});

describe("commitBundleToCanonical — manualMapping", () => {
  const sheet = (rows: Record<string, unknown>[], headerRow: string[]) => ({
    sheetName: "csv",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8", delimiter: ",", totalRows: rows.length,
      emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
    },
  });

  it("without a manual mapping, an unmatched header leaves company_name blank and the row is rejected", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: sheet([{ Clients: "Orise" }], ["Clients"]) as never },
      tenantId: TENANT,
    });
    const customerResult = result.perEntity.find((r) => r.entity === "customer");
    expect(customerResult?.committedCount).toBe(0);
    expect(customerResult?.rejectedCount).toBe(1);
  });

  it("with a manual mapping, the same header commits company_name correctly", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: sheet([{ Clients: "Orise" }], ["Clients"]) as never },
      tenantId: TENANT,
      manualMapping: { customer: { Clients: "company_name" } },
    });
    const customerResult = result.perEntity.find((r) => r.entity === "customer");
    expect(customerResult?.rejectedCount).toBe(0);
    expect(customerResult?.committedCount).toBe(1);

    const commitCall = state.rpcCalls.find((c) => c.name === "eq_intake_commit_batch");
    const rows = (commitCall?.params as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(rows[0]?.company_name).toBe("Orise");
  });
});

describe("commitBundleToCanonical — multi_value_candidate flag", () => {
  it("flags a comma-joined site name with a readable message, and still commits it as one row", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);

    const SITE_SHEET = {
      sheetName: "csv",
      headerRow: ["Site Name"],
      rows: [{ "Site Name": "Wollongong, Malabar" }],
      meta: {
        encoding: "utf-8", delimiter: ",", totalRows: 1,
        emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
      },
    };

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { site: SITE_SHEET as never },
      tenantId: TENANT,
    });

    const siteResult = result.perEntity.find((r) => r.entity === "site");
    expect(siteResult).toBeDefined();
    expect(siteResult?.flaggedCount).toBeGreaterThan(0);
    expect(siteResult?.flaggedRows[0]?.reasons.join(" ")).toMatch(/looks like 2 separate values/i);
    // "Flag for review, never silent" means visible, not blocked — the row
    // still commits as one merged value, same fallback @eq/confirm-ui uses
    // for an unresolved split_row flag.
    expect(siteResult?.committedCount).toBe(1);
  });
});

describe("commitBundleToCanonical — stageCommit (the /intake vs /intake/core parity fix)", () => {
  it("routes rows through stageCommit instead of the direct RPC when supplied", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const stageCalls: Array<{ table: string; entity: string; rows: unknown[] }> = [];
    const stageCommit: StageCommitFn = async ({ table, entity, rows }) => {
      stageCalls.push({ table, entity, rows });
      return { committed_count: rows.length, committed_ids: rows.map((_, i) => `uuid-${i}`), staged_count: 0 };
    };

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: CUSTOMER_SHEET as never },
      tenantId: TENANT,
      stageCommit,
    });

    expect(result.bundleSuccess).toBe(true);
    expect(result.perEntity[0]?.committedCount).toBe(1);
    expect(result.perEntity[0]?.stagedCount).toBe(0);
    expect(stageCalls).toHaveLength(1);
    expect(stageCalls[0]?.table).toBe("customers");
    // The direct RPC must never fire once stageCommit is supplied — that's
    // the whole point of the fix (no bypass of the staging gate).
    expect(state.rpcCalls.some((c) => c.name === "eq_intake_commit_batch")).toBe(false);
    // intake-stage.ts finalises the event itself — the client must not
    // stomp that by also calling eq_finish_intake_event on success.
    expect(state.rpcCalls.some((c) => c.name === "eq_finish_intake_event")).toBe(false);
  });

  it("does not treat staged rows as committed, and still finalises the event on total staging", async () => {
    const state: MockState = { rpcCalls: [] };
    const supabase = makeMockSupabase(state);
    const stageCommit: StageCommitFn = async ({ rows }) => ({
      committed_count: 0,
      committed_ids: [],
      staged_count: rows.length,
    });

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: CUSTOMER_SHEET as never },
      tenantId: TENANT,
      stageCommit,
    });

    expect(result.perEntity[0]?.committedCount).toBe(0);
    expect(result.perEntity[0]?.stagedCount).toBe(1);
    // Not a failure — everything landing in review is expected behaviour,
    // not an error state.
    expect(result.bundleSuccess).toBe(true);
    expect(result.perEntity[0]?.fatalError).toBeUndefined();
  });

  it("a fully-staged customer batch does not silently pass its FK to dependent contacts", async () => {
    // The exact gap this fix closes: if a customer row is flagged/conflicting
    // and parked for review instead of committed, a contact row in the same
    // bundle referencing that customer must NOT sail through with a null
    // customer_id — it must come back as an explicit, visible rejection.
    const state: MockState = {
      rpcCalls: [],
      customerLookupRows: [], // nothing committed yet — customer is still pending review
    };
    const supabase = makeMockSupabase(state);
    const stageCommit: StageCommitFn = async ({ entity, rows }) => {
      if (entity === "customer") return { committed_count: 0, committed_ids: [], staged_count: rows.length };
      return { committed_count: rows.length, committed_ids: rows.map((_, i) => `uuid-${i}`), staged_count: 0 };
    };

    const CONTACT_SHEET = {
      sheetName: "csv",
      headerRow: ["simPRO Contact ID", "simPRO Customer ID", "First Name", "Last Name", "Email"],
      rows: [
        {
          "simPRO Contact ID": "100",
          "simPRO Customer ID": "31",
          "First Name": "Ben",
          "Last Name": "Dunn",
          "Email": "bdunn@ap.equinix.com",
        },
      ],
      meta: {
        encoding: "utf-8", delimiter: ",", totalRows: 1,
        emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false,
      },
    };

    const result = await commitBundleToCanonical({
      supabase,
      bundle: { customer: CUSTOMER_SHEET as never, contact: CONTACT_SHEET as never },
      tenantId: TENANT,
      stageCommit,
    });

    // The customer FK lookup ran (map building isn't skipped just because
    // nothing committed) and came back empty, so the contact never resolves.
    const fkReadCall = state.rpcCalls.find((c) => c.name === "eq_read_customers_by_intake");
    expect(fkReadCall).toBeDefined();

    const contactResult = result.perEntity.find((r) => r.entity === "contact");
    expect(contactResult).toBeDefined();
    expect(contactResult?.committedCount).toBe(0);
    expect(contactResult?.rejectedCount).toBeGreaterThan(0);
    expect(contactResult?.rejectedRows[0]?.reasons.join(" ")).toMatch(/fk_no_match|no customer found/);
  });
});
