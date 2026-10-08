/**
 * @eq/intake — column registry for eq_tidy_read_entity_columns
 *
 * Every read of an app_data entity goes through eq_tidy_read_entity_columns,
 * which needs an explicit column list. The old 1-arg eq_tidy_read_entity
 * (full rows) does not exist on eq/zaap or graft, and is being gated on
 * sks/ehow (eq-shell 0397) — so "read the whole row" now means "ask for
 * every column this registry knows about".
 *
 * ENTITY_COLUMNS is the union of app_data's columns on every active tenant
 * data plane (eq/zaap, sks/ehow, graft — verified live 2026-10-09). The RPC
 * whitelists the request against the target tenant's real columns, so a
 * column one tenant lacks is simply not returned there. A column added to
 * app_data later is not read until it's added here.
 *
 * PII_COLUMNS mirrors the RPC's own deny list (v_denied in
 * eq_tidy_read_entity_columns). The RPC silently drops these for a caller
 * without entity.view_pii — the key is absent from every returned row, not
 * null. Callers that count or validate fields must treat an absent key as
 * "can't see", never as "blank".
 */

export type EntityTable = 'customers' | 'sites' | 'contacts' | 'staff' | 'licences' | 'assets';

export const ENTITY_COLUMNS: Record<EntityTable, readonly string[]> = {
  customers: [
    'customer_id', 'tenant_id', 'external_id', 'type', 'company_name', 'first_name', 'last_name',
    'salutation', 'abn', 'acn', 'street_address', 'suburb', 'state', 'postcode', 'country',
    'postal_address', 'postal_suburb', 'postal_state', 'postal_postcode', 'postal_country',
    'primary_phone', 'mobile_phone', 'alt_phone', 'fax', 'email', 'website', 'customer_group',
    'customer_profile', 'account_manager', 'currency', 'default_quote_method',
    'default_invoice_method', 'default_job_method', 'referred_by', 'notes', 'active',
    'created_date', 'imported_at', 'imported_from', 'intake_id', 'schema_version', 'created_at',
    'updated_at', 'created_by', 'updated_by', 'field_enabled', 'service_enabled', 'code',
    'contract_template', 'logo_url', 'logo_url_on_dark', 'market_vertical', 'invoice_email',
    'client_type', 'market_segment', 'default_end_client', 'deleted_at',
  ],
  sites: [
    'site_id', 'tenant_id', 'external_id', 'customer_id', 'external_customer_id', 'name', 'code',
    'client_name', 'site_type', 'address_line_1', 'address_line_2', 'suburb', 'state', 'postcode',
    'country', 'latitude', 'longitude', 'site_contact_name', 'site_contact_phone',
    'site_contact_email', 'induction_required', 'induction_url', 'active', 'notes', 'imported_at',
    'imported_from', 'intake_id', 'schema_version', 'created_at', 'updated_at', 'created_by',
    'updated_by', 'track_hours', 'budget_hours', 'slug', 'field_enabled', 'service_enabled',
    'gate_code', 'parking_notes', 'after_hours_phone', 'safety_notes', 'photo_url', 'logo_url',
    'logo_url_on_dark', 'primary_contact_name', 'primary_contact_phone', 'secondary_contact_name',
    'secondary_contact_phone', 'deleted_at', 'supervisor_id',
  ],
  contacts: [
    'contact_id', 'tenant_id', 'customer_id', 'external_id', 'external_customer_id',
    'company_name', 'salutation', 'first_name', 'last_name', 'email', 'work_phone',
    'mobile_phone', 'fax', 'position', 'department', 'notes', 'is_default_quote_contact',
    'is_default_job_contact', 'is_default_invoice_contact', 'is_default_statement_contact',
    'active', 'imported_at', 'imported_from', 'intake_id', 'schema_version', 'created_at',
    'updated_at', 'created_by', 'updated_by',
  ],
  staff: [
    'staff_id', 'tenant_id', 'external_id', 'first_name', 'last_name', 'preferred_name', 'email',
    'phone', 'employment_type', 'employment_basis', 'trade', 'level', 'start_date', 'end_date',
    'hourly_rate_cost', 'hourly_rate_charge', 'home_base', 'default_site_id', 'active', 'notes',
    'imported_at', 'imported_from', 'intake_id', 'schema_version', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'user_id', 'notify_roster', 'dob_day', 'dob_month',
    'digest_opt_in', 'digest_cron_schedule', 'tafe_day', 'year_level', 'date_of_birth',
    'address_street', 'address_suburb', 'address_state', 'address_postcode',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_mobile',
    'cards_worker_id', 'field_approved', 'field_approved_at', 'field_approved_by', 'activated_by',
    'activated_at', 'deactivated_at', 'email_locked_by_shell', 'phone_locked_by_shell',
    'employment_type_locked_by_shell', 'is_supervisor', 'supervisor_category', 'supervisor_role',
    'agency', 'hire_company', 'job_title', 'licence', 'on_roster', 'rating', 'rto', 'site_based',
    'archive_reason', 'archive_note', 'manager_id',
  ],
  licences: [
    'licence_id', 'tenant_id', 'staff_id', 'external_id', 'licence_type', 'licence_number',
    'issuing_authority', 'state', 'issue_date', 'expiry_date', 'photo_front_path',
    'photo_back_path', 'notes', 'metadata', 'active', 'imported_at', 'imported_from', 'intake_id',
    'schema_version', 'created_at', 'updated_at', 'created_by', 'updated_by',
    'cards_credential_id', 'confirmed_at', 'confirmed_by',
  ],
  assets: [
    'asset_id', 'tenant_id', 'external_id', 'site_id', 'parent_asset_id', 'asset_type', 'name',
    'make', 'model', 'serial_number', 'rating', 'install_date', 'warranty_expires', 'criticality',
    'condition', 'service_schedule_id', 'ppm_frequency', 'last_service_date', 'next_service_due',
    'location_in_site', 'barcode', 'active', 'defects_summary', 'client_classification', 'notes',
    'imported_at', 'imported_from', 'intake_id', 'schema_version', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'cert_url', 'assigned_to', 'maximo_id', 'is_stub', 'deleted_at',
  ],
};

export const PII_COLUMNS: Record<EntityTable, readonly string[]> = {
  staff: [
    'email', 'phone', 'date_of_birth', 'dob_day', 'dob_month',
    'address_street', 'address_suburb', 'address_state', 'address_postcode',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_mobile',
    'hourly_rate_cost', 'hourly_rate_charge', 'notes', 'licence', 'rating',
  ],
  contacts:  ['email', 'work_phone', 'mobile_phone', 'fax', 'notes'],
  licences:  ['licence_number', 'photo_front_path', 'photo_back_path', 'metadata', 'notes'],
  customers: [],
  sites:     [],
  assets:    [],
};

export function isEntityTable(table: string): table is EntityTable {
  return Object.prototype.hasOwnProperty.call(ENTITY_COLUMNS, table);
}

/** Every known column of `table` except the PII/rate ones — what any caller gets back. */
export function nonPiiColumns(table: EntityTable): string[] {
  const pii = new Set(PII_COLUMNS[table]);
  return ENTITY_COLUMNS[table].filter((c) => !pii.has(c));
}
