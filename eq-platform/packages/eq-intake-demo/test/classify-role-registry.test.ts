/**
 * classifySheet against the REAL ROLE_REGISTRY (simpro-schemas.ts), the one
 * RollupDropZone.tsx and intake-bundle.ts actually wire up — not a synthetic
 * fixture. Regression coverage for a misroute found during Madagins tenant
 * onboarding: a plain "Clients / Contacts / Sites" client register (one row
 * per client, no other columns) scored customer and site as an accidental
 * tie while contact was never even offered as a candidate in the UI's
 * close-call tier (DetectionLine.tsx only shows the top two scores).
 */

import { describe, it, expect } from "vitest";
import { classifySheet, type ParsedSheet } from "@eq/intake";
import { CUSTOMER_SCHEMA, CONTACT_SCHEMA, SITE_SCHEMA, STAFF_SCHEMA } from "../src/simpro-schemas.js";
import type { RoleName } from "../src/rollup/roles.js";

const ROLE_REGISTRY: Record<RoleName, Record<string, unknown>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  staff: STAFF_SCHEMA,
};

function sheet(headers: string[]): ParsedSheet {
  return {
    sheetName: "test",
    headerRow: headers,
    rows: headers.map(() => ({})),
    meta: {
      encoding: "utf-8",
      delimiter: ",",
      totalRows: 0,
      emptyRowsSkipped: 0,
      malformedRows: 0,
      bomDetected: false,
    },
  };
}

describe("classifySheet — real ROLE_REGISTRY", () => {
  it("flags a Clients/Contacts/Sites client register as ambiguous rather than silently picking one", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["col_1", "Clients", "Contacts", "Sites"]),
    });
    expect(result.method).not.toBe("heuristic");
    // Each role should only get credit for the column that's genuinely
    // theirs — no schema should out-score the others on borrowed signal
    // from an unrelated compound alias (e.g. "contact_position").
    expect(result.scores.customer).toBeCloseTo(result.scores.site!, 5);
    expect(result.scores.contact).toBeGreaterThan(0);
  });

  it("still classifies a genuine customer sheet confidently", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["Company Name", "ABN", "Street Address", "Suburb", "State", "Postcode", "Primary Phone", "Email", "Account Manager"]),
    });
    expect(result.entity).toBe("customer");
    expect(result.method).toBe("heuristic");
  });

  it("still classifies a genuine site sheet confidently", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["Site Name", "Street Address", "Suburb", "State", "Postcode", "Zone", "Primary Contact First Name", "Primary Contact Email"]),
    });
    expect(result.entity).toBe("site");
    expect(result.method).toBe("heuristic");
  });

  it("still classifies a genuine contact sheet confidently", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["First Name", "Last Name", "Email", "Mobile Phone", "Position", "Department"]),
    });
    expect(result.entity).toBe("contact");
    expect(result.method).toBe("heuristic");
  });

  it("still classifies a genuine staff sheet confidently", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["First Name", "Last Name", "Trade", "Classification", "Employment Type", "Mobile Phone", "State"]),
    });
    expect(result.entity).toBe("staff");
    expect(result.method).toBe("heuristic");
  });

  it("resolves a plain 'Client' column to customer via the alias it was missing", async () => {
    const result = await classifySheet({
      schemas: ROLE_REGISTRY,
      sheet: sheet(["Client", "ABN", "Street Address", "Primary Phone", "Email"]),
    });
    expect(result.entity).toBe("customer");
  });
});
