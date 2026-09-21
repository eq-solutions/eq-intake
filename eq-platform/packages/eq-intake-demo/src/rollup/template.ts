/**
 * Destination template engine.
 *
 * A `DestinationTemplate` defines the column shape of an output CSV —
 * what columns to emit, in what order, with each column's value pulled
 * from the canonical-form input (customer + sites + contacts) via a
 * pure function.
 *
 * Same engine drives:
 *   - SimPRO customer rollup → SharePoint paste (the original)
 *   - SimPRO customers → Xero ContactsImport.csv
 *   - SimPRO customers → MYOB Card File import
 *   - SimPRO customers → Outlook contacts.csv
 *   - User-supplied templates: drop a sample CSV from the destination,
 *     read its column headers, map each one to a canonical field
 *
 * Adding a new pre-built route is one file: name + columns + value
 * functions. The picker UI auto-discovers templates in the registry.
 */

import type { ParsedSheet } from "@eq/intake";
import type { RoleName } from "./roles.js";

export type Row = Record<string, unknown>;

/**
 * Inputs a column's value-function receives.
 *
 * - In `customer` iteration mode (default), one row is emitted per customer
 *   and the context holds `customer` + all of that customer's `sites` and
 *   `contacts`.
 * - In `site` iteration mode, one row is emitted per site. The context
 *   still holds `customer` (the site's parent customer) + `contacts` (all
 *   of that customer's contacts), plus `site` (the current site row).
 *   `sites` in this mode is a single-entry array containing the current
 *   site, so site-rollup helpers still work.
 */
export interface ColumnContext {
  customer: Row;
  sites: Row[];
  contacts: Row[];
  /** Only set in 'site' iteration mode. The current site for this output row. */
  site?: Row;
  /**
   * Only set in 'contact' iteration mode. The current contact for this output row.
   */
  contact?: Row;
  /**
   * Only set in 'site' iteration mode. Other customers (besides `customer`)
   * whose IDs appear in the site's `simPRO Customer ID` cell. SimPRO models
   * data-centre tenants etc. as a site belonging to multiple customers, e.g.
   * cell value `"31, 32, 208"` — the first ID becomes the primary `customer`
   * for the row; the rest land here so templates can surface them in
   * "Linked Customer …" columns.
   */
  linkedCustomers?: Row[];
}

export type ColumnValueFn = (ctx: ColumnContext) => string;

export interface TemplateColumn {
  /** Output column header, exactly as it should appear in the CSV. */
  name: string;
  /** Pure function that returns the cell value for a given customer. */
  value: ColumnValueFn;
  /** Optional help text shown on hover in the preview. */
  description?: string;
}

export interface DestinationTemplate {
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** One-line description shown under the name. */
  description?: string;
  /** Where this template's output is typically pasted/imported. */
  destinationLabel?: string;
  /** Required source roles. Most templates need 'customer'; some also need contact / site. */
  requiredRoles: RoleName[];
  /** Output columns in order. */
  columns: TemplateColumn[];
  /** Separator placed between concatenated sites/contacts in a cell. Default ' | '. */
  separator?: string;
  /** Source of the template — built-in code vs user-supplied. */
  origin?: "builtin" | "user";
  /**
   * How rows are iterated. Default 'customer' — one row per customer with
   * the customer's sites + contacts available via context. 'site' iterates
   * once per site, with each site's parent customer + that customer's
   * contacts in context. 'contact' iterates once per contact. Orphan
   * sites/contacts (customer ID missing from the customers file) are
   * surfaced by default — pass orphanStrategy: "drop" to opt into loss.
   */
  iterationMode?: "customer" | "site" | "contact";
}

export interface TemplateRenderOptions {
  /** Skip customers that have no sites and no contacts. Default false. */
  skipEmpty?: boolean;
  /**
   * What to do with sites/contacts whose customer ID isn't in the customers
   * file. Default is include — every row in deserves a row out. Pass "drop"
   * only when the caller explicitly accepts losing those rows (and still sees
   * the count in stats.orphanSites / orphanContacts).
   */
  orphanStrategy?: "drop" | "include-as-pseudo-customer" | "separate-section";
  /** Normalise ALL-CAPS company names + emails to standard case. Default false. */
  normaliseCase?: boolean;
}

export interface TemplateRenderResult {
  template: DestinationTemplate;
  headers: string[];
  rows: Record<string, string>[];
  stats: {
    customers: number;
    contacts: number;
    sites: number;
    customersWithSite: number;
    customersWithContact: number;
    customersSkippedEmpty: number;
    orphanSites: number;
    orphanContacts: number;
  };
}

const DEFAULT_SEPARATOR = " | ";

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Render a template against the source bundle. Returns the headers + rows
 * + diagnostic stats. Pure function — no DOM, no React, no AI.
 */
export function renderTemplate(
  template: DestinationTemplate,
  sheets: Partial<Record<RoleName, ParsedSheet>>,
  opts: TemplateRenderOptions = {},
): TemplateRenderResult {
  const customer = sheets.customer;
  const contact = sheets.contact;
  const site = sheets.site;

  const customers = customer?.rows ?? [];
  const contacts = contact?.rows ?? [];
  const sites = site?.rows ?? [];

  const contactsByCustomer = groupBy(contacts, "simPRO Customer ID");
  // Sites use split-aware grouping: a SimPRO site cell can carry a
  // comma-separated list of customer IDs (e.g. "31, 32, 208") when the site
  // is co-owned by multiple legal entities (typical of data-centre tenants).
  // We index the site under every listed customer so neither customer's
  // rollup loses it. The CLI script generate-quotes-csv.mjs uses the same
  // parseCustomerIds shape; keep them in sync.
  const sitesByCustomer = groupSitesByCustomer(sites);

  const knownIds = new Set(
    customers
      .map((c) => stringOf(c["simPRO Customer ID"]))
      .filter((v) => v !== ""),
  );

  const customerById = new Map<string, Row>();
  for (const c of customers) {
    const id = stringOf(c["simPRO Customer ID"]);
    if (id) customerById.set(id, c);
  }

  const outputRows: Record<string, string>[] = [];
  let customersWithSite = 0;
  let customersWithContact = 0;
  let customersSkippedEmpty = 0;

  const iterationMode = template.iterationMode ?? "customer";

  if (iterationMode === "customer") {
    for (const c of customers) {
      const id = stringOf(c["simPRO Customer ID"]);
      const customerSites = sitesByCustomer.get(id) ?? [];
      const customerContacts = contactsByCustomer.get(id) ?? [];

      if (customerSites.length > 0) customersWithSite++;
      if (customerContacts.length > 0) customersWithContact++;

      if (
        opts.skipEmpty &&
        customerSites.length === 0 &&
        customerContacts.length === 0
      ) {
        customersSkippedEmpty++;
        continue;
      }

      const ctx: ColumnContext = {
        customer: opts.normaliseCase ? normaliseRowCase(c) : c,
        sites: customerSites,
        contacts: customerContacts,
      };
      outputRows.push(buildRow(template, ctx));
    }
  } else if (iterationMode === "contact") {
    // 'contact' iteration: one row per contact. Orphans (no matching customer)
    // are surfaced by default — every row in deserves a row out. Opt in to
    // orphanStrategy: "drop" only when the caller explicitly accepts loss.
    const orphanStrategy = opts.orphanStrategy ?? "include-as-pseudo-customer";
    for (const cc of contacts) {
      const id = stringOf(cc["simPRO Customer ID"]);
      const parent = id ? customerById.get(id) : undefined;
      if (!parent) {
        if (orphanStrategy === "drop") continue;
        const ctx: ColumnContext = {
          customer: {
            "simPRO Customer ID": id || "(blank)",
            "Company Name": id
              ? `(orphan — references unknown customer ID ${id})`
              : "(orphan — contact has no customer ID)",
          },
          sites: [],
          contacts: [cc],
          contact: opts.normaliseCase ? normaliseRowCase(cc) : cc,
        };
        outputRows.push(buildRow(template, ctx));
        continue;
      }
      const customerSites = sitesByCustomer.get(id) ?? [];
      const ctx: ColumnContext = {
        customer: opts.normaliseCase ? normaliseRowCase(parent) : parent,
        sites: customerSites,
        contacts: [cc],
        contact: opts.normaliseCase ? normaliseRowCase(cc) : cc,
      };
      outputRows.push(buildRow(template, ctx));
    }
    for (const c of customers) {
      const id = stringOf(c["simPRO Customer ID"]);
      if ((sitesByCustomer.get(id) ?? []).length > 0) customersWithSite++;
      if ((contactsByCustomer.get(id) ?? []).length > 0) customersWithContact++;
    }
  } else {
    // 'site' iteration: one row per site. Orphans surfaced by default.
    const orphanStrategy = opts.orphanStrategy ?? "include-as-pseudo-customer";
    for (const s of sites) {
      const ids = parseCustomerIds(s["simPRO Customer ID"]);
      const primaryId = ids[0] ?? "";
      const parent = primaryId ? customerById.get(primaryId) : undefined;
      if (!parent) {
        if (orphanStrategy === "drop") continue;
        const ctx: ColumnContext = {
          customer: {
            "simPRO Customer ID": primaryId || "(blank)",
            "Company Name": primaryId
              ? `(orphan — references unknown customer ID ${primaryId})`
              : "(orphan — site has no customer ID)",
          },
          sites: [s],
          contacts: [],
          site: opts.normaliseCase ? normaliseRowCase(s) : s,
          linkedCustomers: [],
        };
        outputRows.push(buildRow(template, ctx));
        continue;
      }
      const linkedCustomers: Row[] = [];
      for (const id of ids.slice(1)) {
        const linked = customerById.get(id);
        if (linked) linkedCustomers.push(linked);
      }
      const customerContacts = contactsByCustomer.get(primaryId) ?? [];
      const ctx: ColumnContext = {
        customer: opts.normaliseCase ? normaliseRowCase(parent) : parent,
        sites: [s],
        contacts: customerContacts,
        site: opts.normaliseCase ? normaliseRowCase(s) : s,
        linkedCustomers: opts.normaliseCase
          ? linkedCustomers.map(normaliseRowCase)
          : linkedCustomers,
      };
      outputRows.push(buildRow(template, ctx));
    }
    // Customer-with-* counts are only meaningful in customer mode; left as
    // computed (which is 0 here, since the loop above didn't run).
    for (const c of customers) {
      const id = stringOf(c["simPRO Customer ID"]);
      if ((sitesByCustomer.get(id) ?? []).length > 0) customersWithSite++;
      if ((contactsByCustomer.get(id) ?? []).length > 0) customersWithContact++;
    }
  }

  // Orphan handling for customer-iteration — append pseudo-customer rows for
  // sites/contacts whose Customer ID isn't in the customers file. Default is
  // include (every row out). Site/contact iteration surfaces orphans in-loop.
  if (
    iterationMode === "customer" &&
    (opts.orphanStrategy ?? "include-as-pseudo-customer") === "include-as-pseudo-customer"
  ) {
    const orphanCustomerIds = new Set<string>();
    for (const s of sites) {
      const ids = parseCustomerIds(s["simPRO Customer ID"]);
      if (ids.length === 0) continue;
      if (ids.some((id) => knownIds.has(id))) continue;
      for (const id of ids) orphanCustomerIds.add(id);
    }
    for (const cc of contacts) {
      const id = stringOf(cc["simPRO Customer ID"]);
      if (id && !knownIds.has(id)) orphanCustomerIds.add(id);
    }
    for (const id of orphanCustomerIds) {
      const ctx: ColumnContext = {
        customer: { "simPRO Customer ID": id, "Company Name": "(orphan — customer not in export)" },
        sites: sitesByCustomer.get(id) ?? [],
        contacts: contactsByCustomer.get(id) ?? [],
      };
      outputRows.push(buildRow(template, ctx));
    }
  }

  let orphanSites = 0;
  for (const s of sites) {
    const ids = parseCustomerIds(s["simPRO Customer ID"]);
    if (ids.length === 0) continue;
    if (!ids.some((id) => knownIds.has(id))) orphanSites++;
  }
  let orphanContacts = 0;
  for (const cc of contacts) {
    const id = stringOf(cc["simPRO Customer ID"]);
    if (id && !knownIds.has(id)) orphanContacts++;
  }

  return {
    template,
    headers: template.columns.map((c) => c.name),
    rows: outputRows,
    stats: {
      customers: customers.length,
      contacts: contacts.length,
      sites: sites.length,
      customersWithSite,
      customersWithContact,
      customersSkippedEmpty,
      orphanSites,
      orphanContacts,
    },
  };
}

/**
 * Serialise a render result to RFC-4180 CSV bytes (CRLF line endings).
 *
 * Starts with a UTF-8 BOM (U+FEFF). Without it, Excel opens UTF-8
 * CSV files as Windows-1252 and mangles every non-ASCII character
 * (em-dashes, curly quotes, accented company names). Standard
 * "Excel + UTF-8 CSV" trap. The BOM is invisible to any RFC-4180
 * parser; only Excel + a few other Microsoft tools care about it.
 */
export function renderToCsv(result: TemplateRenderResult): string {
  const lines: string[] = [result.headers.map(csvEscape).join(",")];
  for (const row of result.rows) {
    lines.push(result.headers.map((h) => csvEscape(row[h] ?? "")).join(","));
  }
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

const UTF8_BOM = "﻿";

// ============================================================================
// HELPERS — exported for reuse in built-in templates
// ============================================================================

export function field(name: string): ColumnValueFn {
  return ({ customer }) => stringOf(customer[name]);
}

/** Pull a value from the current site row (site-iteration mode only). */
export function site(name: string): ColumnValueFn {
  return ({ site: s }) => stringOf(s?.[name]);
}

/**
 * One-line address built from the current site's street/suburb/state/postcode.
 * Site-iteration mode only.
 */
export function siteAddress(): ColumnValueFn {
  return ({ site: s }) => {
    if (!s) return "";
    const parts = [
      stringOf(s["Street Address"]),
      stringOf(s["Suburb"]),
      stringOf(s["State"]),
      stringOf(s["Postcode"]),
    ]
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.join(", ");
  };
}

export function staticValue(value: string): ColumnValueFn {
  return () => value;
}

export function siteCount(): ColumnValueFn {
  return ({ sites }) => String(sites.length);
}

export function contactCount(): ColumnValueFn {
  return ({ contacts }) => String(contacts.length);
}

/**
 * Concatenate a per-site value across all of a customer's sites,
 * separated by the template's separator. If no per-site format function
 * is supplied, defaults to `Site Name — Address`.
 */
export function siteRollup(
  formatter?: (s: Row) => string,
  separator: string = DEFAULT_SEPARATOR,
): ColumnValueFn {
  const fmt = formatter ?? defaultFormatSite;
  return ({ sites }) => sites.map(fmt).filter(Boolean).join(separator);
}

/** Same shape as siteRollup, for contacts. Defaults to `Name (Position) · email · phone`. */
export function contactRollup(
  formatter?: (c: Row) => string,
  separator: string = DEFAULT_SEPARATOR,
): ColumnValueFn {
  const fmt = formatter ?? defaultFormatContact;
  return ({ contacts }) => contacts.map(fmt).filter(Boolean).join(separator);
}

/** Pull a single value from the FIRST row in `sites` (e.g. for "primary site address"). */
export function firstSiteField(name: string): ColumnValueFn {
  return ({ sites }) => stringOf(sites[0]?.[name]);
}

/** Pull a single value from the FIRST row in `contacts`. */
export function firstContactField(name: string): ColumnValueFn {
  return ({ contacts }) => stringOf(contacts[0]?.[name]);
}

/** Pull a value from the current contact row (contact-iteration mode only). */
export function contactField(name: string): ColumnValueFn {
  return ({ contact: c }) => stringOf(c?.[name]);
}

/**
 * One-line address built from the first site belonging to the current
 * contact's customer. Most useful in contact-iteration mode to give each
 * contact their site's physical address (e.g. for visitor management or
 * contractor portal pre-fill).
 */
export function contactFirstSiteAddress(): ColumnValueFn {
  return ({ sites }) => {
    const s = sites[0];
    if (!s) return "";
    const parts = [
      stringOf(s["Street Address"]),
      stringOf(s["Suburb"]),
      stringOf(s["State"]),
      stringOf(s["Postcode"]),
    ]
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.join(", ");
  };
}

/** Pull a named field from the first site belonging to the contact's customer. */
export function contactFirstSiteField(name: string): ColumnValueFn {
  return ({ sites }) => stringOf(sites[0]?.[name]);
}

/**
 * Comma-separated extra customer IDs for a multi-tenant site (site-iteration
 * mode only — empty otherwise). Excludes the primary customer ID, which is
 * already emitted via the standard "Customer ID" column.
 */
export function linkedCustomerIds(separator: string = ", "): ColumnValueFn {
  return ({ linkedCustomers }) =>
    (linkedCustomers ?? [])
      .map((c) => stringOf(c["simPRO Customer ID"]))
      .filter(Boolean)
      .join(separator);
}

/**
 * Pipe-separated extra customer Company Names for a multi-tenant site
 * (site-iteration mode only — empty otherwise). Excludes the primary
 * customer.
 */
export function linkedCustomerNames(separator: string = " | "): ColumnValueFn {
  return ({ linkedCustomers }) =>
    (linkedCustomers ?? [])
      .map((c) => stringOf(c["Company Name"]).trim())
      .filter(Boolean)
      .join(separator);
}

/**
 * Parse a "simPRO Customer ID" cell. The cell carries a single ID for most
 * sites, but a comma-separated list like "31, 32, 208" for sites co-owned by
 * multiple customers (typical of data-centre tenants where multiple legal
 * entities share an address). Returns IDs in order; first is treated as
 * primary by the engine.
 */
export function parseCustomerIds(raw: unknown): string[] {
  return stringOf(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull from contacts where a flag is true (e.g. `Is Default Quote Contact`).
 * Returns the first match's `name` field, or fallback to firstContactField.
 */
export function defaultContactField(
  fieldName: string,
  flag: string = "Is Default Quote Contact",
): ColumnValueFn {
  return ({ contacts }) => {
    const def = contacts.find((c) => isTruthy(c[flag]));
    if (def) return stringOf(def[fieldName]);
    return stringOf(contacts[0]?.[fieldName]);
  };
}

// ============================================================================
// INTERNAL
// ============================================================================

function buildRow(
  template: DestinationTemplate,
  ctx: ColumnContext,
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const col of template.columns) {
    try {
      row[col.name] = col.value(ctx);
    } catch (e) {
      // Surface the error — silent "" would produce a blank cell with no trace.
      // eslint-disable-next-line no-console
      console.error(
        `buildRow: column "${col.name}" threw — check template definition.`,
        e,
      );
      row[col.name] = `#ERROR:${col.name}`;
    }
  }
  return row;
}

function stringOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const k = stringOf(r[key]);
    if (!k) continue;
    let bucket = map.get(k);
    if (!bucket) {
      bucket = [];
      map.set(k, bucket);
    }
    bucket.push(r);
  }
  return map;
}

/**
 * Group sites by `simPRO Customer ID`, splitting comma-separated lists so a
 * multi-tenant site (`"31, 32, 208"`) is indexed under EVERY listed customer.
 * Without this split the original exact-string `groupBy` would file such a
 * site under the literal key `"31, 32, 208"` and customers 31 / 32 / 208
 * would all see an empty site list — the same silent-drop bug that lost 72
 * sites in the SimPRO rollup on 2026-05-18.
 */
function groupSitesByCustomer(sites: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const s of sites) {
    const ids = parseCustomerIds(s["simPRO Customer ID"]);
    for (const id of ids) {
      let bucket = map.get(id);
      if (!bucket) {
        bucket = [];
        map.set(id, bucket);
      }
      bucket.push(s);
    }
  }
  return map;
}

function isTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "true" || t === "yes" || t === "y" || t === "1";
  }
  return false;
}

function csvEscape(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function defaultFormatSite(s: Row): string {
  const name = stringOf(s["Site Name"]).trim();
  const addr = [
    stringOf(s["Street Address"]),
    stringOf(s["Suburb"]),
    stringOf(s["State"]),
    stringOf(s["Postcode"]),
  ]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
  if (name && addr && name.toLowerCase() !== addr.toLowerCase()) {
    return `${name} — ${addr}`;
  }
  return name || addr || "(site, no address)";
}

function defaultFormatContact(c: Row): string {
  const name = [stringOf(c["Contact First Name"]), stringOf(c["Contact Last Name"])]
    .filter(Boolean)
    .join(" ")
    .trim();
  const email = stringOf(c["Contact Email"]).trim();
  const mobile = stringOf(c["Contact Mobile Phone"]).trim();
  const work = stringOf(c["Contact Work Phone"]).trim();
  const position = stringOf(c["Contact Position"]).trim();
  const head = position ? `${name} (${position})` : name;
  return [head, email, mobile || work].filter((p) => p && p !== "").join(" · ");
}

/**
 * Soft normalisation of ALL-CAPS company names + emails. Title-cases
 * common cases (e.g. "ABC ELECTRICAL" → "Abc Electrical") and lowercases
 * email cells. Leaves mixed-case + lowercase strings alone.
 */
function normaliseRowCase(row: Row): Row {
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;

    if (k.toLowerCase().includes("email")) {
      // Lowercase the local part; preserve the domain as-is. Most email
      // pipelines treat addresses as case-insensitive.
      if (trimmed === trimmed.toUpperCase() || /[A-Z]/.test(trimmed)) {
        out[k] = trimmed.toLowerCase();
      }
      continue;
    }

    // Treat as ALL-CAPS only if the string has letters AND is fully upper-case
    const letters = trimmed.replace(/[^A-Za-z]/g, "");
    if (letters.length > 1 && letters === letters.toUpperCase()) {
      out[k] = titleCase(trimmed);
    }
  }
  return out;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
