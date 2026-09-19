/**
 * Quick Export destinations — the MVP set.
 *
 * Each destination is "one source file in, one CSV out." Pure column
 * mapping, no joins, no required cross-file lookups. If the destination
 * has columns the source doesn't carry, those output cells stay blank.
 *
 * Adding a new destination is a five-line addition to QUICK_DESTINATIONS
 * below — no engine changes needed.
 *
 * This is intentionally separate from the rollup engine in src/rollup/.
 * The rollup engine is for richer multi-file joins (Xero ContactsImport
 * with denormalised company info, etc.). Quick Export is for the
 * "I just want my contacts in Outlook" case — no join required, no
 * "you need the customer file too" friction.
 */

import type { RoleName } from "../rollup/roles.js";

export interface QuickDestinationColumn {
  /** The output column header as it appears in the destination CSV. */
  name: string;
  /**
   * Function that picks the value for this column from a source row.
   * Source rows are keyed by the source CSV's header names (e.g. SimPRO's
   * "Contact First Name"). Return "" for blank.
   */
  value: (row: Record<string, unknown>) => string;
}

export interface QuickDestination {
  /** Stable ID, used by the picker. */
  id: string;
  /** Display label for the picker. */
  label: string;
  /** Short description shown under the picker. */
  description: string;
  /** Which classified role this destination needs as input. */
  needsRole: RoleName;
  /** Output column spec, in order. */
  columns: QuickDestinationColumn[];
  /** Filename suggested when downloading. */
  filename: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

// SimPRO contact column names, as they appear in the export header verbatim.
// These match what's in customer_contacts_export_*.csv.
const FIRST = (r: Record<string, unknown>) => str(r["Contact First Name"] ?? r["First Name"]);
const LAST = (r: Record<string, unknown>) => str(r["Contact Last Name"] ?? r["Last Name"]);
const EMAIL = (r: Record<string, unknown>) =>
  str(r["Contact Email"] ?? r["Email"] ?? r["Email Address"]);
const MOBILE = (r: Record<string, unknown>) =>
  str(r["Contact Mobile Phone"] ?? r["Mobile Phone"] ?? r["Mobile"]);
const WORK = (r: Record<string, unknown>) =>
  str(r["Contact Work Phone"] ?? r["Work Phone"] ?? r["Phone"]);
const POSITION = (r: Record<string, unknown>) =>
  str(r["Contact Position"] ?? r["Position"] ?? r["Title"]);

// SimPRO customer column names (from customer_export_*.csv).
const CUST_ID = (r: Record<string, unknown>) =>
  str(r["simPRO Customer ID"] ?? r["Customer ID"] ?? r["External ID"]);
const COMPANY = (r: Record<string, unknown>) =>
  str(r["Company Name"] ?? r["Customer Name"] ?? r["Name"]);
const CUST_FIRST = (r: Record<string, unknown>) => str(r["First Name"]);
const CUST_LAST = (r: Record<string, unknown>) => str(r["Last Name"]);
const CUST_EMAIL = (r: Record<string, unknown>) => str(r["Email"] ?? r["Email Address"]);
const CUST_PHONE = (r: Record<string, unknown>) =>
  str(r["Primary Phone"] ?? r["Phone"] ?? r["Mobile Phone"]);
const CUST_FAX = (r: Record<string, unknown>) => str(r["Company Fax"] ?? r["Fax"]);
const CUST_WEB = (r: Record<string, unknown>) => str(r["Website"]);
const CUST_ABN = (r: Record<string, unknown>) => str(r["ABN"]);
const CUST_ADDR1 = (r: Record<string, unknown>) => str(r["Street Address"] ?? r["Address"]);
const CUST_SUBURB = (r: Record<string, unknown>) => str(r["Suburb"] ?? r["City"]);
const CUST_STATE = (r: Record<string, unknown>) => str(r["State"]);
const CUST_POSTCODE = (r: Record<string, unknown>) => str(r["Postcode"]);
const CUST_COUNTRY = (r: Record<string, unknown>) => str(r["Country"]) || "Australia";

// SimPRO / EQ Field staff column names.
const STAFF_FIRST = (r: Record<string, unknown>) =>
  str(r["First Name"] ?? r["first_name"] ?? r["Given Name"]);
const STAFF_LAST = (r: Record<string, unknown>) =>
  str(r["Last Name"] ?? r["last_name"] ?? r["Surname"]);
const STAFF_EMAIL = (r: Record<string, unknown>) =>
  str(r["Email"] ?? r["email"] ?? r["Work Email"]);
const STAFF_PHONE = (r: Record<string, unknown>) =>
  str(r["Mobile Phone"] ?? r["mobile_phone"] ?? r["Phone"] ?? r["Mobile"]);
const STAFF_TRADE = (r: Record<string, unknown>) =>
  str(r["Trade"] ?? r["trade"] ?? r["Discipline"] ?? r["trade_type"]);
const STAFF_LEVEL = (r: Record<string, unknown>) =>
  str(r["Classification"] ?? r["classification"] ?? r["Level"] ?? r["Pay Level"] ?? r["Grade"]);
const STAFF_EMP_TYPE = (r: Record<string, unknown>) =>
  str(r["Employment Type"] ?? r["employment_type"] ?? r["Type"] ?? r["Worker Type"]) || "Contractor";
const STAFF_COMPANY = (r: Record<string, unknown>) =>
  str(r["Company"] ?? r["company_name"] ?? r["Employer"] ?? r["Agency"]) || "SKS Technologies";
const STAFF_STATUS = (r: Record<string, unknown>) => {
  const active = str(r["active"] ?? r["Active"] ?? r["Status"] ?? "").toLowerCase();
  if (active === "false" || active === "0" || active === "inactive") return "Inactive";
  return "Active";
};
const STAFF_NOTES = (r: Record<string, unknown>) =>
  str(r["Notes"] ?? r["notes"] ?? r["Comments"]);

// SimPRO site column names (from site_export_*.csv).
const SITE_NAME = (r: Record<string, unknown>) =>
  str(r["Site Name"] ?? r["Name"] ?? r["Location Name"] ?? r["site_name"]);
const SITE_EXT_ID = (r: Record<string, unknown>) =>
  str(r["simPRO Site ID"] ?? r["Site ID"] ?? r["External ID"] ?? r["ID"]);
const SITE_CUST_ID = (r: Record<string, unknown>) =>
  str(r["simPRO Customer ID"] ?? r["Customer ID"] ?? r["Account ID"]);
const SITE_ADDR = (r: Record<string, unknown>) =>
  str(r["Street Address"] ?? r["Address"]);
const SITE_SUBURB = (r: Record<string, unknown>) =>
  str(r["Suburb"] ?? r["City"] ?? r["Town"]);
const SITE_STATE = (r: Record<string, unknown>) => str(r["State"]);
const SITE_POSTCODE = (r: Record<string, unknown>) => str(r["Postcode"]);
const SITE_NOTES = (r: Record<string, unknown>) =>
  str(r["Public Notes"] ?? r["Notes"] ?? r["Site Notes"]);

export const QUICK_DESTINATIONS: QuickDestination[] = [
  {
    id: "outlook-contacts",
    label: "Outlook contacts",
    description:
      "A CSV that Outlook can import as contacts. Drop your SimPRO contacts file.",
    needsRole: "contact",
    filename: "outlook-contacts.csv",
    columns: [
      // Microsoft's documented Outlook CSV import columns. Order matters
      // — Outlook reads by header name so technically any order works,
      // but matching their docs makes the file recognisable in support.
      { name: "First Name", value: FIRST },
      { name: "Last Name", value: LAST },
      { name: "E-mail Address", value: EMAIL },
      { name: "Mobile Phone", value: MOBILE },
      { name: "Business Phone", value: WORK },
      { name: "Job Title", value: POSITION },
      // Company stays blank in the MVP. If the bookkeeper drops the
      // customer file too, a richer destination ("Outlook contacts with
      // company names") will fill it via join — that's a future template.
      { name: "Company", value: () => "" },
    ],
  },

  {
    id: "xero-contacts",
    label: "Xero contacts (CSV)",
    description:
      "Xero's ContactsImport.csv format. One row per customer. Drop your SimPRO customers file.",
    needsRole: "customer",
    filename: "xero-contacts.csv",
    columns: [
      // Xero's documented ContactsImport columns. ContactName is required
      // (it's the contact's display name in Xero — usually the company).
      { name: "*ContactName", value: COMPANY },
      { name: "AccountNumber", value: CUST_ID },
      { name: "EmailAddress", value: CUST_EMAIL },
      { name: "FirstName", value: CUST_FIRST },
      { name: "LastName", value: CUST_LAST },
      { name: "PhoneNumber", value: CUST_PHONE },
      { name: "FaxNumber", value: CUST_FAX },
      { name: "Website", value: CUST_WEB },
      { name: "TaxNumber", value: CUST_ABN },
      // Postal address — Xero calls it "POAddress*"
      { name: "POAddressLine1", value: CUST_ADDR1 },
      { name: "POCity", value: CUST_SUBURB },
      { name: "PORegion", value: CUST_STATE },
      { name: "POPostalCode", value: CUST_POSTCODE },
      { name: "POCountry", value: CUST_COUNTRY },
    ],
  },

  {
    id: "site-sharepoint",
    label: "Site register (SharePoint / CMDB)",
    description:
      "Site register CSV for SharePoint or a CMDB. One row per site. Drop your SimPRO sites file.",
    needsRole: "site",
    filename: "site-register.csv",
    columns: [
      { name: "Site Name",         value: SITE_NAME },
      { name: "SimPRO Site ID",    value: SITE_EXT_ID },
      { name: "SimPRO Customer ID",value: SITE_CUST_ID },
      { name: "Street Address",    value: SITE_ADDR },
      { name: "Suburb",            value: SITE_SUBURB },
      { name: "State",             value: SITE_STATE },
      { name: "Postcode",          value: SITE_POSTCODE },
      { name: "Notes",             value: SITE_NOTES },
    ],
  },

  {
    id: "equinix-contractor-portal",
    label: "Equinix Contractor Portal",
    description:
      "Equinix contractor registration CSV. One row per staff member. Drop your EQ Field or SimPRO staff export.",
    needsRole: "staff",
    filename: "equinix-contractors.csv",
    columns: [
      { name: "First Name",       value: STAFF_FIRST },
      { name: "Last Name",        value: STAFF_LAST },
      { name: "Email",            value: STAFF_EMAIL },
      { name: "Phone",            value: STAFF_PHONE },
      { name: "Trade",            value: STAFF_TRADE },
      { name: "Level",            value: STAFF_LEVEL },
      { name: "Employment Type",  value: STAFF_EMP_TYPE },
      { name: "Company",          value: STAFF_COMPANY },
      { name: "Status",           value: STAFF_STATUS },
      { name: "Notes",            value: STAFF_NOTES },
    ],
  },

  {
    id: "myob-cardfile",
    label: "MYOB Card File (customers)",
    description:
      "MYOB's Card File import CSV. One row per customer card. Drop your SimPRO customers file.",
    needsRole: "customer",
    filename: "myob-cardfile.csv",
    columns: [
      // MYOB Card File import columns. Customer cards use these.
      // The "Co./Last Name" column is required — for companies it's the
      // trading name; for sole traders it's the surname (we use company
      // name when present, fall back to last name).
      {
        name: "Co./Last Name",
        value: (r) => COMPANY(r) || CUST_LAST(r) || "(no name)",
      },
      { name: "First Name", value: CUST_FIRST },
      { name: "Card ID*", value: CUST_ID },
      { name: "Card Status", value: () => "Active" },
      { name: "Currency Code", value: () => "AUD" },
      { name: "Addr 1 - Line 1", value: CUST_ADDR1 },
      { name: "Addr 1 - City", value: CUST_SUBURB },
      { name: "Addr 1 - State", value: CUST_STATE },
      { name: "Addr 1 - Postcode", value: CUST_POSTCODE },
      { name: "Addr 1 - Country", value: CUST_COUNTRY },
      { name: "Addr 1 - Phone No. 1", value: CUST_PHONE },
      { name: "Addr 1 - Fax No.", value: CUST_FAX },
      { name: "Addr 1 - Email", value: CUST_EMAIL },
      { name: "Addr 1 - WWW", value: CUST_WEB },
      { name: "A.B.N. / G.S.T. No.", value: CUST_ABN },
    ],
  },
];

/**
 * RFC-4180-ish CSV encoder with UTF-8 BOM. BOM matters: without it, Excel
 * opens the file as Windows-1252 and mangles every accented company name.
 */
export function encodeCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const escape = (s: unknown): string => {
    if (s == null) return "";
    const v = String(s);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [headers.map(escape).join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
