/**
 * Smoke tests for the destination-template engine + the four built-in
 * templates. Drives the engine against synthetic bundles (no real client
 * data) and asserts that each template produces the right column shape.
 *
 * This catches regressions that would otherwise only surface by clicking
 * through the UI — the heavy preview render makes browser-based
 * verification flaky.
 */

import { describe, it, expect } from "vitest";
import type { ParsedSheet } from "@eq/intake";
import { renderTemplate, renderToCsv } from "../src/rollup/template.js";
import { BUILTIN_TEMPLATES, buildUserTemplate } from "../src/rollup/templates.js";
import type { RoleName } from "../src/rollup/roles.js";

/** Build a ParsedSheet wrapping a header row + a few data rows. */
function sheet(headerRow: string[], rows: Record<string, unknown>[]): ParsedSheet {
  return {
    sheetName: "test",
    headerRow,
    rows,
    meta: {
      encoding: "utf-8",
      delimiter: ",",
      totalRows: rows.length,
      emptyRowsSkipped: 0,
      malformedRows: 0,
      bomDetected: false,
    },
  };
}

function bundle(): Partial<Record<RoleName, ParsedSheet>> {
  const customers = sheet(
    [
      "Type",
      "simPRO Customer ID",
      "Company Name",
      "ABN",
      "Street Address",
      "Suburb",
      "State",
      "Postcode",
      "Country",
      "Primary Phone",
      "Mobile Phone",
      "Email",
      "Website",
      "Customer Group",
      "Account Manager",
      "Default Quote Method",
      "Notes",
      "Create Date",
      "Postal Address",
      "Postal Suburb",
      "Postal State",
      "Postal Postcode",
    ],
    [
      {
        Type: "Customer",
        "simPRO Customer ID": "101",
        "Company Name": "Acme Pty Ltd",
        "ABN": "12 345 678 901",
        "Street Address": "1 George St",
        "Suburb": "Sydney",
        "State": "NSW",
        "Postcode": "2000",
        "Country": "Australia",
        "Primary Phone": "02 9000 1111",
        "Mobile Phone": "",
        "Email": "info@acme.example",
        "Website": "www.acme.example",
        "Customer Group": "Commercial",
        "Account Manager": "Royce",
        "Default Quote Method": "Email",
        "Notes": "",
        "Create Date": "01/02/2024",
        "Postal Address": "PO Box 1",
        "Postal Suburb": "Sydney",
        "Postal State": "NSW",
        "Postal Postcode": "2001",
      },
      {
        Type: "Customer",
        "simPRO Customer ID": "102",
        "Company Name": "BETA INDUSTRIES",
        "ABN": "98 765 432 109",
        "Street Address": "200 Collins St",
        "Suburb": "Melbourne",
        "State": "VIC",
        "Postcode": "3000",
        "Country": "Australia",
        "Primary Phone": "03 9000 2222",
        "Email": "ACCOUNTS@BETA.EXAMPLE",
        "Website": "",
        "Create Date": "15/06/2025",
        "Postal Address": "",
        "Postal Suburb": "",
        "Postal State": "",
        "Postal Postcode": "",
      },
      {
        Type: "Customer",
        "simPRO Customer ID": "103",
        "Company Name": "Gamma Services",
        "ABN": "",
        "Street Address": "",
        "Suburb": "",
        "State": "",
        "Postcode": "",
        "Country": "Australia",
        "Primary Phone": "",
        "Email": "",
        "Website": "",
        "Create Date": "01/01/2026",
        "Postal Address": "",
        "Postal Suburb": "",
        "Postal State": "",
        "Postal Postcode": "",
      },
    ],
  );

  const contacts = sheet(
    [
      "simPRO Customer ID",
      "simPRO Contact ID",
      "Company Name",
      "Contact First Name",
      "Contact Last Name",
      "Contact Email",
      "Contact Work Phone",
      "Contact Mobile Phone",
      "Contact Position",
      "Contact Department",
      "Is Default Quote Contact",
      "Is Default Invoice Contact",
    ],
    [
      {
        "simPRO Customer ID": "101",
        "simPRO Contact ID": "1",
        "Company Name": "Acme Pty Ltd",
        "Contact First Name": "Anna",
        "Contact Last Name": "Park",
        "Contact Email": "anna@acme.example",
        "Contact Work Phone": "02 9000 1112",
        "Contact Mobile Phone": "0412 000 001",
        "Contact Position": "Procurement",
        "Is Default Quote Contact": "Y",
        "Is Default Invoice Contact": "",
      },
      {
        "simPRO Customer ID": "101",
        "simPRO Contact ID": "2",
        "Company Name": "Acme Pty Ltd",
        "Contact First Name": "Ben",
        "Contact Last Name": "Wong",
        "Contact Email": "ben@acme.example",
        "Contact Mobile Phone": "0412 000 002",
        "Contact Position": "Accounts",
        "Is Default Quote Contact": "",
        "Is Default Invoice Contact": "Y",
      },
      {
        "simPRO Customer ID": "102",
        "simPRO Contact ID": "3",
        "Company Name": "BETA INDUSTRIES",
        "Contact First Name": "Carla",
        "Contact Last Name": "Singh",
        "Contact Email": "carla@beta.example",
        "Contact Mobile Phone": "0412 000 003",
      },
      // Orphan contact — customer ID 999 doesn't exist
      {
        "simPRO Customer ID": "999",
        "simPRO Contact ID": "4",
        "Company Name": "(orphan)",
        "Contact First Name": "Dave",
        "Contact Last Name": "Lim",
      },
    ],
  );

  const sites = sheet(
    [
      "simPRO Site ID",
      "simPRO Customer ID",
      "Site Name",
      "Street Address",
      "Suburb",
      "State",
      "Postcode",
    ],
    [
      {
        "simPRO Site ID": "501",
        "simPRO Customer ID": "101",
        "Site Name": "Acme HQ",
        "Street Address": "1 George St",
        "Suburb": "Sydney",
        "State": "NSW",
        "Postcode": "2000",
      },
      {
        "simPRO Site ID": "502",
        "simPRO Customer ID": "101",
        "Site Name": "Acme Warehouse",
        "Street Address": "10 Industrial Dr",
        "Suburb": "Botany",
        "State": "NSW",
        "Postcode": "2019",
      },
      {
        "simPRO Site ID": "503",
        "simPRO Customer ID": "102",
        "Site Name": "Beta Plant",
        "Street Address": "200 Collins St",
        "Suburb": "Melbourne",
        "State": "VIC",
        "Postcode": "3000",
      },
    ],
  );

  return { customer: customers, contact: contacts, site: sites };
}

describe("template engine — built-in templates", () => {
  it("registers 6 built-in templates with stable ids", () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual([
      "simpro-customer-rollup",
      "simpro-quotes-by-site",
      "site-contact-directory",
      "xero-contacts-import",
      "myob-card-file",
      "outlook-contacts",
    ]);
  });

  it("SimPRO customer rollup produces one row per customer with concatenated sites + contacts", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle());
    expect(result.headers).toContain("Sites");
    expect(result.headers).toContain("Contacts");
    expect(result.rows).toHaveLength(4);

    const acme = result.rows[0]!;
    expect(acme["Company Name"]).toBe("Acme Pty Ltd");
    expect(acme["Site Count"]).toBe("2");
    expect(acme["Sites"]).toContain("Acme HQ");
    expect(acme["Sites"]).toContain("Acme Warehouse");
    expect(acme["Sites"]).toContain(" | ");
    expect(acme["Contact Count"]).toBe("2");
    expect(acme["Contacts"]).toContain("Anna Park");
    expect(acme["Contacts"]).toContain("Ben Wong");

    // Gamma has zero sites + contacts but is still emitted by default
    const gamma = result.rows[2]!;
    expect(gamma["Site Count"]).toBe("0");
    expect(gamma["Contact Count"]).toBe("0");

    // Orphan contact (customer ID 999) surfaces as a pseudo-customer — every row out
    const orphan = result.rows[3]!;
    expect(orphan["Company Name"]).toContain("orphan");
    expect(orphan["Contacts"]).toContain("Dave");
  });

  it("Xero ContactsImport produces Xero's documented column shape", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "xero-contacts-import")!;
    const result = renderTemplate(template, bundle());
    expect(result.headers[0]).toBe("*ContactName");
    expect(result.headers).toContain("AccountNumber");
    expect(result.headers).toContain("EmailAddress");
    expect(result.headers).toContain("POAddressLine1");
    expect(result.headers).toContain("PhoneNumber");
    expect(result.headers).toContain("TaxNumber");
    expect(result.rows).toHaveLength(4);

    const acme = result.rows[0]!;
    expect(acme["*ContactName"]).toBe("Acme Pty Ltd");
    expect(acme["AccountNumber"]).toBe("101");
    expect(acme["TaxNumber"]).toBe("12 345 678 901");
    // EmailAddress pulls from default-invoice contact (Ben Wong) before company email
    expect(acme["EmailAddress"]).toBe("ben@acme.example");
    expect(acme["FirstName"]).toBe("Ben");
    expect(acme["LastName"]).toBe("Wong");
    // Beta has no contact flagged as default-invoice, falls back to company email
    const beta = result.rows[1]!;
    expect(beta["EmailAddress"]).toBe("ACCOUNTS@BETA.EXAMPLE");
  });

  it("MYOB Card File produces MYOB's documented column shape", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "myob-card-file")!;
    const result = renderTemplate(template, bundle());
    expect(result.headers).toContain("Co./Last Name");
    expect(result.headers).toContain("Card ID*");
    expect(result.headers).toContain("Card Status");
    expect(result.headers).toContain("A.B.N.");
    const acme = result.rows[0]!;
    expect(acme["Co./Last Name"]).toBe("Acme Pty Ltd");
    expect(acme["Card ID*"]).toBe("101");
    expect(acme["Card Status"]).toBe("Active");
    expect(acme["Currency Code"]).toBe("AUD");
    // Contact derived from default-invoice flag
    expect(acme["Addr 1 - Contact"]).toBe("Ben Wong");
  });

  it("Outlook contacts template emits Outlook's named columns", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "outlook-contacts")!;
    const result = renderTemplate(template, bundle());
    expect(result.headers).toContain("First Name");
    expect(result.headers).toContain("Last Name");
    expect(result.headers).toContain("Company");
    expect(result.headers).toContain("Business Phone");
    expect(result.headers).toContain("E-mail Address");
    const acme = result.rows[0]!;
    // Default-quote contact is Anna
    expect(acme["First Name"]).toBe("Anna");
    expect(acme["Last Name"]).toBe("Park");
    expect(acme["Company"]).toBe("Acme Pty Ltd");
    expect(acme["E-mail Address"]).toBe("anna@acme.example");
    expect(acme["E-mail Display Name"]).toBe("Anna Park <anna@acme.example>");
  });
});

describe("template engine — interaction options", () => {
  it("skipEmpty drops customers with no sites and no contacts (orphans still surface)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle(), { skipEmpty: true });
    // Gamma has neither → dropped; orphan contact 999 still surfaces
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r["Company Name"])).toEqual([
      "Acme Pty Ltd",
      "BETA INDUSTRIES",
      "(orphan — customer not in export)",
    ]);
    expect(result.stats.customersSkippedEmpty).toBe(1);
  });

  it("normaliseCase title-cases ALL-CAPS company names + lowercases emails", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle(), { normaliseCase: true });
    const beta = result.rows[1]!;
    expect(beta["Company Name"]).toBe("Beta Industries");
    expect(beta["Email"]).toBe("accounts@beta.example");
    // Acme already mixed-case, untouched
    expect(result.rows[0]!["Company Name"]).toBe("Acme Pty Ltd");
  });

  it("orphan strategy include is the default (every row out)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle());
    // Dave Lim (Customer ID 999) surfaces as a pseudo-customer
    expect(result.rows.find((r) => r["Contacts"]?.includes("Dave"))).toBeDefined();
    expect(result.stats.orphanContacts).toBe(1);
  });

  it("orphan strategy 'drop' opts into losing orphan rows", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle(), { orphanStrategy: "drop" });
    expect(result.rows.find((r) => r["Contacts"]?.includes("Dave"))).toBeUndefined();
    expect(result.stats.orphanContacts).toBe(1);
  });

  it("orphan strategy 'include-as-pseudo-customer' appends orphan rows", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle(), {
      orphanStrategy: "include-as-pseudo-customer",
    });
    expect(result.rows).toHaveLength(4); // 3 real + 1 orphan
    const orphan = result.rows[3]!;
    expect(orphan["simPRO Customer ID"]).toBe("999");
    expect(orphan["Company Name"]).toBe("(orphan — customer not in export)");
    expect(orphan["Contacts"]).toContain("Dave Lim");
  });
});

describe("SIMPRO_QUOTES_BY_SITE — site-iteration template for EQ Quotes", () => {
  it("registers as a built-in", () => {
    expect(BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")).toBeDefined();
  });

  it("emits one row per site (not per customer)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    // Fixture has 3 sites (501, 502 for Acme; 503 for Beta). Gamma has no sites.
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r["Site Name"])).toEqual([
      "Acme HQ",
      "Acme Warehouse",
      "Beta Plant",
    ]);
  });

  it("denormalises customer details onto each site row", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    const acmeHq = result.rows[0]!;
    const acmeWarehouse = result.rows[1]!;
    const betaPlant = result.rows[2]!;

    // Both Acme sites carry Acme's customer info
    expect(acmeHq["Customer Name"]).toBe("Acme Pty Ltd");
    expect(acmeWarehouse["Customer Name"]).toBe("Acme Pty Ltd");
    expect(acmeHq["Customer ABN"]).toBe("12 345 678 901");
    expect(acmeWarehouse["Customer ABN"]).toBe("12 345 678 901");

    // Beta carries Beta's
    expect(betaPlant["Customer Name"]).toBe("BETA INDUSTRIES");
    expect(betaPlant["Customer ABN"]).toBe("98 765 432 109");
  });

  it("pulls primary contact from the default-quote-contact flag (certain)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    // Acme's default-quote contact is Anna Park (explicit flag) — name NOT suffixed
    const acmeHq = result.rows[0]!;
    expect(acmeHq["Primary Contact Name"]).toBe("Anna Park");
    expect(acmeHq["Primary Contact Email"]).toBe("anna@acme.example");
    expect(acmeHq["Primary Contact Phone"]).toBe("0412 000 001");
    expect(acmeHq["Primary Contact Position"]).toBe("Procurement");
  });

  it("flags uncertain picks with '(no default contact set)' suffix when no flag is set", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    // Beta has no Is Default Quote Contact flag on Carla — name SHOULD carry the suffix
    const beta = result.rows[2]!;
    expect(beta["Primary Contact Name"]).toBe("Carla Singh (no default contact set)");
    expect(beta["Primary Contact Email"]).toBe("carla@beta.example");
  });

  it("includes all customer contacts in the fallback rollup cell", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    const acmeHq = result.rows[0]!;
    expect(acmeHq["All Customer Contacts"]).toContain("Anna Park");
    expect(acmeHq["All Customer Contacts"]).toContain("Ben Wong");
    expect(acmeHq["All Customer Contacts"]).toContain(" | ");
  });

  it("builds a single-line site address", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    expect(result.rows[0]!["Site Address"]).toBe("1 George St, Sydney, NSW, 2000");
    expect(result.rows[1]!["Site Address"]).toBe("10 Industrial Dr, Botany, NSW, 2019");
  });

  it("surfaces orphan sites by default (every row out)", () => {
    // Add a fourth site whose Customer ID 999 isn't in the customer file.
    const b = bundle();
    const sitesSheet = b.site!;
    sitesSheet.rows.push({
      "simPRO Site ID": "504",
      "simPRO Customer ID": "999",
      "Site Name": "Orphan Site",
      "Street Address": "1 Nowhere St",
      "Suburb": "Lost",
      "State": "NSW",
      "Postcode": "0000",
    });
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, b);
    expect(result.rows).toHaveLength(4);
    const orphan = result.rows.find((r) => r["Site Name"] === "Orphan Site");
    expect(orphan).toBeDefined();
    expect(orphan!["Customer Name"]).toContain("orphan");
    expect(result.stats.orphanSites).toBe(1);
  });

  it("drops orphan sites only when orphanStrategy is explicitly 'drop'", () => {
    const b = bundle();
    b.site!.rows.push({
      "simPRO Site ID": "504",
      "simPRO Customer ID": "999",
      "Site Name": "Orphan Site",
      "Street Address": "1 Nowhere St",
      "Suburb": "Lost",
      "State": "NSW",
      "Postcode": "0000",
    });
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, b, { orphanStrategy: "drop" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.find((r) => r["Site Name"] === "Orphan Site")).toBeUndefined();
    expect(result.stats.orphanSites).toBe(1);
  });

  it("defaults Currency to AUD when the customer's currency is blank", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundle());
    // None of the fixture customers have Currency set
    expect(result.rows[0]!["Currency"]).toBe("AUD");
    expect(result.rows[1]!["Currency"]).toBe("AUD");
    expect(result.rows[2]!["Currency"]).toBe("AUD");
  });
});

describe("multi-customer sites — SimPRO comma-separated Customer ID cells", () => {
  // SimPRO models data-centre tenants etc. by writing multiple customer IDs
  // into a single site's "simPRO Customer ID" cell as a comma-separated list
  // (e.g. "101, 102"). The engine must split the list — exact-string lookup
  // dropped these sites silently in the bug Royce caught on 2026-05-18 (lost
  // 72 sites in a rollup). The CLI script generate-quotes-csv.mjs holds the
  // canonical fix shape; the template engine mirrors it.

  function bundleWithMultiTenantSite(): Partial<Record<RoleName, ParsedSheet>> {
    const b = bundle();
    // Append a fourth site whose Customer ID cell lists BOTH 101 (Acme) and
    // 102 (Beta) — a shared data-centre suite the two companies co-occupy.
    b.site!.rows.push({
      "simPRO Site ID": "504",
      "simPRO Customer ID": "101, 102",
      "Site Name": "Shared DC Suite",
      "Street Address": "5 Cloud Way",
      "Suburb": "Mascot",
      "State": "NSW",
      "Postcode": "2020",
    });
    return b;
  }

  it("site-iteration: emits a row for the multi-tenant site (not silent-dropped)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    // 3 baseline sites + 1 new multi-tenant site = 4 rows. The buggy engine
    // dropped the multi-tenant site because customerById.get("101, 102")
    // returned undefined.
    expect(result.rows).toHaveLength(4);
    const shared = result.rows.find((r) => r["Site Name"] === "Shared DC Suite");
    expect(shared).toBeDefined();
  });

  it("site-iteration: joins to the FIRST customer ID as primary", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    const shared = result.rows.find((r) => r["Site Name"] === "Shared DC Suite")!;
    // First listed ID is 101 (Acme) — Acme is the primary customer
    expect(shared["Customer ID"]).toBe("101");
    expect(shared["Customer Name"]).toBe("Acme Pty Ltd");
    expect(shared["Customer ABN"]).toBe("12 345 678 901");
  });

  it("site-iteration: surfaces remaining customers in Linked Customer columns", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    const shared = result.rows.find((r) => r["Site Name"] === "Shared DC Suite")!;
    expect(shared["Linked Customer IDs"]).toBe("102");
    expect(shared["Linked Customer Names"]).toBe("BETA INDUSTRIES");
  });

  it("site-iteration: pulls primary contact from the FIRST customer (not from linked customers)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    const shared = result.rows.find((r) => r["Site Name"] === "Shared DC Suite")!;
    // Acme's default-quote contact is Anna Park (explicit flag)
    expect(shared["Primary Contact Name"]).toBe("Anna Park");
  });

  it("site-iteration: single-customer sites leave the Linked columns empty", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    const acmeHq = result.rows.find((r) => r["Site Name"] === "Acme HQ")!;
    expect(acmeHq["Linked Customer IDs"]).toBe("");
    expect(acmeHq["Linked Customer Names"]).toBe("");
  });

  it("site-iteration: surfaces when the PRIMARY id is unknown (true orphan)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const b = bundleWithMultiTenantSite();
    // Primary ID unknown (999) even though second is known (101) — primary
    // is authoritative; surface as orphan rather than silently inventing a
    // join to the secondary.
    b.site!.rows.push({
      "simPRO Site ID": "505",
      "simPRO Customer ID": "999, 101",
      "Site Name": "Bad Primary Site",
    });
    const result = renderTemplate(template, b);
    const orphan = result.rows.find((r) => r["Site Name"] === "Bad Primary Site");
    expect(orphan).toBeDefined();
    expect(orphan!["Customer Name"]).toContain("orphan");
    expect(orphan!["Customer ID"]).toBe("999");
  });

  it("site-iteration: drop strategy still loses true orphans", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const b = bundleWithMultiTenantSite();
    b.site!.rows.push({
      "simPRO Site ID": "505",
      "simPRO Customer ID": "999, 101",
      "Site Name": "Bad Primary Site",
    });
    const result = renderTemplate(template, b, { orphanStrategy: "drop" });
    expect(result.rows.find((r) => r["Site Name"] === "Bad Primary Site")).toBeUndefined();
  });

  it("site-iteration: a linked ID that's NOT in the customer file is skipped (no '(unknown)' filler)", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;
    const b = bundle();
    // Primary 101 resolves, secondary 999 doesn't. Site should still emit,
    // joined to Acme, with empty Linked columns (the unknown ID is dropped
    // rather than emitted as "(unknown ID 999)" — keeps the cell clean for
    // the quoter, since they can't act on an ID they don't have a name for).
    b.site!.rows.push({
      "simPRO Site ID": "506",
      "simPRO Customer ID": "101, 999",
      "Site Name": "One Bad Linked",
    });
    const result = renderTemplate(template, b);
    const row = result.rows.find((r) => r["Site Name"] === "One Bad Linked")!;
    expect(row).toBeDefined();
    expect(row["Customer ID"]).toBe("101");
    expect(row["Linked Customer IDs"]).toBe("");
    expect(row["Linked Customer Names"]).toBe("");
  });

  it("customer-iteration: a multi-tenant site appears in BOTH customers' Sites cells", () => {
    // The original silent-drop bug also hit the customer-rollup path: the
    // shared site landed under key "101, 102" in sitesByCustomer, invisible
    // to both customer 101 AND customer 102. The split-aware grouping now
    // indexes the site under each listed customer.
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundleWithMultiTenantSite());
    const acme = result.rows.find((r) => r["Company Name"] === "Acme Pty Ltd")!;
    const beta = result.rows.find((r) => r["Company Name"] === "BETA INDUSTRIES")!;
    expect(acme["Sites"]).toContain("Shared DC Suite");
    expect(beta["Sites"]).toContain("Shared DC Suite");
    // Acme also still has its own two sites
    expect(acme["Sites"]).toContain("Acme HQ");
    expect(acme["Sites"]).toContain("Acme Warehouse");
    // Site Count reflects the shared site too
    expect(acme["Site Count"]).toBe("3");
    expect(beta["Site Count"]).toBe("2");
  });

  it("orphan count: site is NOT counted as orphan when at least one linked customer exists", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const b = bundle();
    // Site references one known (101) and one unknown (999). Not an orphan.
    b.site!.rows.push({
      "simPRO Site ID": "510",
      "simPRO Customer ID": "101, 999",
      "Site Name": "Half-orphan",
    });
    const result = renderTemplate(template, b);
    expect(result.stats.orphanSites).toBe(0);
  });

  it("orphan count: site IS counted as orphan when NO linked customer resolves", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const b = bundle();
    b.site!.rows.push({
      "simPRO Site ID": "511",
      "simPRO Customer ID": "998, 999",
      "Site Name": "Fully orphan",
    });
    const result = renderTemplate(template, b);
    expect(result.stats.orphanSites).toBe(1);
  });
});

describe("primary-contact fallback chain (Bug 2 fix)", () => {
  function customerWithContacts(
    accountManager: string,
    contacts: Array<{ first: string; last: string; position?: string; defaultQuote?: boolean }>,
  ): Partial<Record<RoleName, ParsedSheet>> {
    return {
      customer: sheet(
        ["simPRO Customer ID", "Company Name", "Account Manager"],
        [{ "simPRO Customer ID": "1", "Company Name": "Test Co", "Account Manager": accountManager }],
      ),
      contact: sheet(
        [
          "simPRO Customer ID",
          "Contact First Name",
          "Contact Last Name",
          "Contact Position",
          "Contact Email",
          "Is Default Quote Contact",
        ],
        contacts.map((c) => ({
          "simPRO Customer ID": "1",
          "Contact First Name": c.first,
          "Contact Last Name": c.last,
          "Contact Position": c.position ?? "",
          "Contact Email": `${c.first.toLowerCase()}@test.example`,
          "Is Default Quote Contact": c.defaultQuote ? "Y" : "",
        })),
      ),
      site: sheet(
        ["simPRO Site ID", "simPRO Customer ID", "Site Name", "Street Address"],
        [{ "simPRO Site ID": "10", "simPRO Customer ID": "1", "Site Name": "S1", "Street Address": "Addr" }],
      ),
    };
  }
  const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-quotes-by-site")!;

  it("step 1 — explicit Is Default Quote Contact flag wins even when position matches another contact", () => {
    const result = renderTemplate(
      template,
      customerWithContacts("Royce", [
        { first: "Alice", last: "Smith", position: "Procurement" }, // position match
        { first: "Bob", last: "Jones", defaultQuote: true }, // flagged
      ]),
    );
    expect(result.rows[0]!["Primary Contact Name"]).toBe("Bob Jones");
  });

  it("step 2 — no flag, picks contact with quoting-relevant position", () => {
    const result = renderTemplate(
      template,
      customerWithContacts("Royce", [
        { first: "Royce", last: "Milmlow" }, // account manager (would be picked by step 3 fallback)
        { first: "Alice", last: "Smith", position: "Procurement Manager" }, // position match
      ]),
    );
    expect(result.rows[0]!["Primary Contact Name"]).toBe("Alice Smith (no default contact set)");
  });

  it("step 3 — no flag + no position match, skips contact matching the Account Manager", () => {
    const result = renderTemplate(
      template,
      customerWithContacts("Royce Milmlow", [
        { first: "Royce", last: "Milmlow" }, // matches AM
        { first: "Eve", last: "Carter" },
      ]),
    );
    expect(result.rows[0]!["Primary Contact Name"]).toBe("Eve Carter (no default contact set)");
  });

  it("step 4 — final fallback to first contact when nothing else matches", () => {
    const result = renderTemplate(
      template,
      customerWithContacts("", [{ first: "Solo", last: "Person" }]),
    );
    expect(result.rows[0]!["Primary Contact Name"]).toBe("Solo Person (no default contact set)");
  });

  it("covers the Schneider real-world case — account manager doesn't get picked even with quote-relevant title", () => {
    // Mirrors the actual bug Royce surfaced: SimPRO had Royce listed as a
    // contact on Schneider Electric, with position "Director" (which would
    // otherwise be a quote-relevant title). The fix filters AM-matching
    // contacts BEFORE the position-match step, so the picker now correctly
    // skips Royce and picks the next non-AM contact (Deepika).
    const result = renderTemplate(
      template,
      customerWithContacts("ROYCE MILMLOW", [
        { first: "Royce", last: "Milmlow", position: "Director" }, // AM — should be skipped
        { first: "Deepika", last: "Nagpal", position: "Sales Manager" }, // non-AM
      ]),
    );
    // The fix means we pick Deepika, not Royce, even though Royce's
    // position would have matched the position-match step.
    expect(result.rows[0]!["Primary Contact Name"]).toBe(
      "Deepika Nagpal (no default contact set)",
    );
  });

  it("falls through to AM-named contact if EVERY contact matches the AM (truly nothing else)", () => {
    // Edge case: customer has only one contact, and that contact happens to
    // share a name with the AM. Better to surface SOMETHING flagged than to
    // emit a blank Primary Contact cell. Internal-only suffix tells the
    // quoter the only contact is the AM.
    const result = renderTemplate(
      template,
      customerWithContacts("Royce Milmlow", [
        { first: "Royce", last: "Milmlow", position: "Director" },
      ]),
    );
    expect(result.rows[0]!["Primary Contact Name"]).toBe(
      "Royce Milmlow (matches your Account Manager — verify)",
    );
  });

  it("Schneider real-world case 2 — AM has Is Default Quote Contact flag, picker still skips them", () => {
    // The actual SimPRO situation Royce found: on the Schneider customer
    // record, Royce was added as a contact AND had Is Default Quote Contact
    // = Y (1). The naive "flagged contact wins" rule would have picked him
    // despite him being the SKS Account Manager. The fix skips AM-matching
    // contacts even at the flagged step IF there are non-AM contacts
    // available.
    const result = renderTemplate(
      template,
      customerWithContacts("Royce Milmlow", [
        { first: "Royce", last: "Milmlow", position: "Director", defaultQuote: true }, // AM, flagged
        { first: "Deepika", last: "Nagpal", position: "Sales Manager" }, // non-AM, no flag
      ]),
    );
    // Picker picks Deepika (non-AM with position match) — Royce is skipped
    // despite the explicit flag because he matches the AM.
    expect(result.rows[0]!["Primary Contact Name"]).toBe(
      "Deepika Nagpal (no default contact set)",
    );
  });
});

describe("renderToCsv — UTF-8 BOM (Bug 1 fix)", () => {
  it("starts with U+FEFF so Excel decodes it as UTF-8 not Windows-1252", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle());
    const csv = renderToCsv(result);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    // The header still starts with the right text immediately after the BOM
    expect(csv.slice(1)).toMatch(/^simPRO Customer ID,Company Name,/);
  });
});

describe("template engine — user-supplied templates", () => {
  it("builds a working template from a user mapping", () => {
    const template = buildUserTemplate({
      id: "user-test-1",
      name: "SharePoint quoting project",
      destinationLabel: "SharePoint",
      columnNames: ["Account No.", "Customer", "Phone", "Tax No.", "Untouched"],
      canonicalFieldMap: {
        "Account No.": "simPRO Customer ID",
        Customer: "Company Name",
        Phone: "Primary Phone",
        "Tax No.": "ABN",
        Untouched: null,
      },
    });
    const result = renderTemplate(template, bundle());
    expect(result.headers).toEqual([
      "Account No.",
      "Customer",
      "Phone",
      "Tax No.",
      "Untouched",
    ]);
    const acme = result.rows[0]!;
    expect(acme["Account No."]).toBe("101");
    expect(acme["Customer"]).toBe("Acme Pty Ltd");
    expect(acme["Phone"]).toBe("02 9000 1111");
    expect(acme["Tax No."]).toBe("12 345 678 901");
    // Unmapped column stays empty
    expect(acme["Untouched"]).toBe("");
  });
});

describe("renderToCsv — RFC-4180 escaping", () => {
  it("quotes cells containing commas, quotes, or newlines", () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === "simpro-customer-rollup")!;
    const result = renderTemplate(template, bundle());
    const csv = renderToCsv(result);
    // Skip the UTF-8 BOM (first char) before matching the header.
    expect(csv.slice(1)).toMatch(/^simPRO Customer ID,Company Name,/);
    expect(csv.endsWith("\r\n")).toBe(true);
    // Sites cell for Acme contains " | " AND a comma inside addresses → must be quoted
    expect(csv).toContain('"Acme HQ — 1 George St, Sydney, NSW, 2000');
  });
});
