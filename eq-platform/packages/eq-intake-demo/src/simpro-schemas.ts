/**
 * Demo schemas sized to real SimPRO export files.
 *
 * Three entities — customer / contact / site — that capture the data
 * shapes Royce gets out of his SKS SimPRO account. The aliases match
 * the actual SimPRO export column headers verbatim (after normalisation:
 * lowercase + spaces → underscores), so the classifier + mock AI map
 * source columns to canonical fields with no manual remapping needed.
 *
 * These are demo-grade, not the @eq/schemas canonical source of truth.
 * When Phase 2-3 schema work lands they'll be replaced with the real
 * canonical versions in @eq/schemas, with full validation rules,
 * cross-field guards, FK declarations, and source-of-truth IDs.
 */

export const CUSTOMER_SCHEMA = {
  $id: "https://schemas.eq.solutions/demo/customer.json",
  title: "Customer (demo)",
  "x-eq-entity": "customer",
  type: "object",
  // No required-at-top-level. A customer is identified by EITHER a company
  // name OR a person name (sole traders / individuals appear in SimPRO
  // exports without a Company Name set). A cross-field rule covers that.
  required: [],
  "x-eq-cross-field-rules": [
    {
      id: "customer_has_a_name",
      rule: "(company_name != null AND company_name != '') OR (first_name != null AND first_name != '') OR (last_name != null AND last_name != '')",
      message: "Customer must have either a company name or a person name.",
    },
  ],
  properties: {
    external_id: {
      type: ["string", "null"],
      description: "Source-system ID (SimPRO Customer ID, MYOB CardID, etc.). Preserved for round-trip exports.",
      "x-eq-source-aliases": ["simpro_customer_id", "customer_id", "client_id", "id", "code", "card_id"],
    },
    type: {
      type: ["string", "null"],
      description: "Customer / Prospect / Lead — from the source system's classification column.",
      "x-eq-source-aliases": ["type", "customer_type", "category", "kind"],
    },
    company_name: {
      type: ["string", "null"],
      description: "Trading name / company name. Optional — sole traders have first_name/last_name instead.",
      "x-eq-source-aliases": ["company_name", "company", "name", "business_name", "trading_name", "client_name", "client"],
      maxLength: 200,
    },
    first_name: {
      type: ["string", "null"],
      description: "Given name (for individual customers / sole traders).",
      "x-eq-source-aliases": ["first_name", "first", "given_name", "fname"],
      maxLength: 80,
    },
    last_name: {
      type: ["string", "null"],
      description: "Family name (for individual customers / sole traders).",
      "x-eq-source-aliases": ["last_name", "last", "surname", "lname", "family_name"],
      maxLength: 80,
    },
    contact_title: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["title", "salutation"],
    },
    abn: {
      type: ["string", "null"],
      description: "Australian Business Number (11 digits).",
      "x-eq-source-aliases": ["abn", "business_number"],
    },
    acn: {
      type: ["string", "null"],
      description: "Australian Company Number (9 digits).",
      "x-eq-source-aliases": ["acn", "company_number"],
    },
    street_address: {
      type: ["string", "null"],
      description: "Main street address (line 1).",
      "x-eq-source-aliases": ["street_address", "address", "street", "address_line_1"],
    },
    suburb: {
      type: ["string", "null"],
      description: "Suburb or town.",
      "x-eq-source-aliases": ["suburb", "city", "town", "address_suburb"],
    },
    state: {
      type: ["string", "null"],
      description: "Australian state (NSW, VIC, QLD…).",
      "x-eq-coerce": "au-state",
      "x-eq-source-aliases": ["state", "state_code", "address_state"],
    },
    postcode: {
      type: ["string", "null"],
      description: "Postcode.",
      "x-eq-source-aliases": ["postcode", "zip", "postal_code", "address_postcode"],
    },
    country: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["country", "address_country"],
    },
    postal_address: {
      type: ["string", "null"],
      description: "Postal / billing address (when different from physical).",
      "x-eq-source-aliases": ["postal_address", "billing_address", "mailing_address"],
    },
    postal_suburb: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postal_suburb", "billing_suburb"],
    },
    postal_state: {
      type: ["string", "null"],
      "x-eq-coerce": "au-state",
      "x-eq-source-aliases": ["postal_state", "billing_state"],
    },
    postal_postcode: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postal_postcode", "billing_postcode"],
    },
    primary_phone: {
      type: ["string", "null"],
      description: "Primary phone. Normalised to E.164 where possible.",
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["primary_phone", "phone", "company_phone", "main_phone", "telephone"],
    },
    mobile_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["mobile_phone", "mobile", "cell"],
    },
    alt_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["alt_phone", "alternative_phone", "secondary_phone"],
    },
    fax: {
      type: ["string", "null"],
      description: "Fax. Kept for completeness — rarely used now.",
      "x-eq-source-aliases": ["company_fax", "fax"],
    },
    email: {
      type: ["string", "null"],
      format: "email",
      "x-eq-source-aliases": ["email", "company_email", "primary_email"],
    },
    website: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["website", "url", "homepage"],
    },
    customer_group: {
      type: ["string", "null"],
      description: "Segmentation (Commercial / Residential / etc.).",
      "x-eq-source-aliases": ["customer_group", "group", "segment"],
    },
    customer_profile: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["customer_profile", "profile"],
    },
    account_manager: {
      type: ["string", "null"],
      description: "Internal owner / sales rep.",
      "x-eq-source-aliases": ["account_manager", "owner", "rep", "salesperson"],
    },
    currency: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["currency"],
    },
    referred_by: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["referred_by", "referral", "source"],
    },
    notes: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["notes", "comments", "remarks"],
    },
    created_date: {
      type: ["string", "null"],
      format: "date",
      "x-eq-coerce": "date",
      "x-eq-source-aliases": ["create_date", "created", "created_at", "date_created"],
    },
  },
};

export const CONTACT_SCHEMA = {
  $id: "https://schemas.eq.solutions/demo/contact.json",
  title: "Contact (demo)",
  "x-eq-entity": "contact",
  type: "object",
  required: ["first_name", "last_name"],
  properties: {
    external_id: {
      type: ["string", "null"],
      description: "Source-system contact ID.",
      "x-eq-source-aliases": ["simpro_contact_id", "contact_id", "id"],
    },
    customer_external_id: {
      type: ["string", "null"],
      description: "Source-system customer ID this contact belongs to.",
      "x-eq-source-aliases": ["simpro_customer_id", "customer_id", "account_id", "company_id"],
    },
    company_name: {
      type: ["string", "null"],
      description: "Denormalised company name from the source. Useful when contact rows arrive without a customer lookup table.",
      "x-eq-source-aliases": ["company_name", "company", "business_name"],
    },
    title: {
      type: ["string", "null"],
      description: "Honorific (Mr / Mrs / Dr / etc).",
      "x-eq-source-aliases": ["contact_title", "title", "salutation"],
    },
    first_name: {
      type: "string",
      description: "Given name. Required.",
      "x-eq-source-aliases": [
        "contact_first_name",
        "first_name",
        "first",
        "given_name",
        "fname",
        "firstname",
      ],
      minLength: 1,
      maxLength: 80,
    },
    last_name: {
      type: "string",
      description: "Family name. Required.",
      "x-eq-source-aliases": [
        "contact_last_name",
        "last_name",
        "last",
        "surname",
        "lname",
        "lastname",
        "family_name",
      ],
      minLength: 1,
      maxLength: 80,
    },
    email: {
      type: ["string", "null"],
      format: "email",
      "x-eq-source-aliases": ["contact_email", "email", "e_mail"],
    },
    work_phone: {
      type: ["string", "null"],
      description: "Work / office phone. Normalised to E.164.",
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["contact_work_phone", "work_phone", "office_phone", "phone"],
    },
    mobile_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": [
        "contact_mobile_phone",
        "mobile_phone",
        "mobile",
        "cell",
        "cell_phone",
      ],
    },
    fax: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["contact_fax", "fax"],
    },
    position: {
      type: ["string", "null"],
      description: "Job title or role.",
      "x-eq-source-aliases": ["contact_position", "position", "job_title", "role"],
    },
    department: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["contact_department", "department", "team"],
    },
    notes: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["contact_notes", "notes", "comments"],
    },
    is_default_quote_contact: {
      type: ["boolean", "null"],
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": ["is_default_quote_contact", "default_quote_contact", "default_quote"],
    },
    is_default_job_contact: {
      type: ["boolean", "null"],
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": ["is_default_job_contact", "default_job_contact", "default_job"],
    },
    is_default_invoice_contact: {
      type: ["boolean", "null"],
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": [
        "is_default_invoice_contact",
        "default_invoice_contact",
        "default_invoice",
      ],
    },
    is_default_statement_contact: {
      type: ["boolean", "null"],
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": [
        "is_default_statement_contact",
        "default_statement_contact",
        "default_statement",
      ],
    },
  },
};

export const STAFF_SCHEMA = {
  $id: "https://schemas.eq.solutions/demo/staff.json",
  title: "Staff (demo)",
  "x-eq-entity": "staff",
  type: "object",
  required: ["first_name", "last_name"],
  properties: {
    external_id: {
      type: ["string", "null"],
      description: "Source-system staff ID (SimPRO employee ID, MYOB Card ID, etc.).",
      "x-eq-source-aliases": ["staff_id", "employee_id", "id", "card_id", "payroll_id", "simpro_staff_id"],
    },
    first_name: {
      type: "string",
      description: "Given name. Required.",
      "x-eq-source-aliases": ["first_name", "first", "given_name", "fname", "firstname"],
      minLength: 1,
      maxLength: 80,
    },
    last_name: {
      type: "string",
      description: "Family name. Required.",
      "x-eq-source-aliases": ["last_name", "last", "surname", "lname", "lastname", "family_name"],
      minLength: 1,
      maxLength: 80,
    },
    preferred_name: {
      type: ["string", "null"],
      description: "Preferred name or nickname.",
      "x-eq-source-aliases": ["preferred_name", "nickname", "known_as"],
    },
    email: {
      type: ["string", "null"],
      format: "email",
      "x-eq-source-aliases": ["email", "work_email", "staff_email"],
    },
    mobile_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["mobile_phone", "mobile", "cell", "phone"],
    },
    work_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": ["work_phone", "office_phone", "direct_phone"],
    },
    trade: {
      type: ["string", "null"],
      description: "Primary trade (Electrician, Instrumentation, etc.).",
      "x-eq-source-aliases": ["trade", "trade_type", "discipline", "skill"],
    },
    classification: {
      type: ["string", "null"],
      description: "Classification or pay level (e.g. EW3, EW5, Apprentice).",
      "x-eq-source-aliases": ["classification", "level", "pay_level", "grade", "award_level"],
    },
    employment_type: {
      type: ["string", "null"],
      description: "Employee, Contractor, Labour Hire, etc.",
      "x-eq-source-aliases": ["employment_type", "type", "worker_type", "engagement_type"],
    },
    company: {
      type: ["string", "null"],
      description: "Employer or labour hire firm name.",
      "x-eq-source-aliases": ["company", "company_name", "employer", "agency"],
    },
    state: {
      type: ["string", "null"],
      "x-eq-coerce": "au-state",
      "x-eq-source-aliases": ["state", "work_state", "base_state"],
    },
    active: {
      type: ["boolean", "null"],
      description: "Whether this staff member is currently active.",
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": ["active", "is_active", "status", "enabled"],
    },
    notes: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["notes", "comments", "remarks"],
    },
  },
};

export const SITE_SCHEMA = {
  $id: "https://schemas.eq.solutions/demo/site.json",
  title: "Site (demo)",
  "x-eq-entity": "site",
  type: "object",
  required: ["site_name"],
  properties: {
    external_id: {
      type: ["string", "null"],
      description: "Source-system site ID.",
      "x-eq-source-aliases": ["simpro_site_id", "site_id", "id", "code"],
    },
    customer_external_id: {
      type: ["string", "null"],
      description: "Customer this site belongs to.",
      "x-eq-source-aliases": ["simpro_customer_id", "customer_id", "account_id"],
    },
    site_name: {
      type: "string",
      description: "Site name. Often the address used as a label. Required.",
      "x-eq-source-aliases": ["site_name", "name", "location_name", "site"],
      minLength: 1,
      maxLength: 200,
    },
    zone: {
      type: ["string", "null"],
      description: "Zone code (used in some workflows for geographic grouping).",
      "x-eq-source-aliases": ["zone", "region"],
    },
    street_address: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["street_address", "address", "street", "address_line_1"],
    },
    suburb: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["suburb", "city", "town"],
    },
    state: {
      type: ["string", "null"],
      "x-eq-coerce": "au-state",
      "x-eq-source-aliases": ["state", "state_code"],
    },
    postcode: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postcode", "zip"],
    },
    country: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["country"],
    },
    postal_address: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postal_address", "billing_address"],
    },
    postal_suburb: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postal_suburb"],
    },
    postal_state: {
      type: ["string", "null"],
      "x-eq-coerce": "au-state",
      "x-eq-source-aliases": ["postal_state"],
    },
    postal_postcode: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["postal_postcode"],
    },
    primary_contact_first_name: {
      type: ["string", "null"],
      "x-eq-source-aliases": [
        "primary_contact_first_name",
        "contact_first_name",
        "first_name",
      ],
    },
    primary_contact_last_name: {
      type: ["string", "null"],
      "x-eq-source-aliases": [
        "primary_contact_last_name",
        "contact_last_name",
        "last_name",
      ],
    },
    primary_contact_position: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["primary_contact_position", "contact_position", "position"],
    },
    primary_contact_email: {
      type: ["string", "null"],
      format: "email",
      "x-eq-source-aliases": ["primary_contact_email", "contact_email", "email"],
    },
    primary_contact_work_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": [
        "primary_contact_work_phone",
        "contact_work_phone",
        "work_phone",
      ],
    },
    primary_contact_mobile_phone: {
      type: ["string", "null"],
      "x-eq-coerce": "phone-au",
      "x-eq-source-aliases": [
        "primary_contact_mobile_phone",
        "contact_mobile_phone",
        "mobile",
        "mobile_phone",
      ],
    },
    preferred_notification_method: {
      type: ["string", "null"],
      "x-eq-source-aliases": [
        "preferred_notification_method",
        "notification_method",
      ],
    },
    archived: {
      type: ["boolean", "null"],
      description: "True if the site is no longer active.",
      "x-eq-coerce": "boolean",
      "x-eq-source-aliases": ["archived", "is_archived", "inactive"],
    },
    part_tax_code: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["part_tax_code", "material_tax_code"],
    },
    labour_tax_code: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["labour_tax_code", "labor_tax_code"],
    },
    public_notes: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["public_notes", "notes", "site_notes"],
    },
    private_notes: {
      type: ["string", "null"],
      "x-eq-source-aliases": ["private_notes", "internal_notes"],
    },
  },
};
