/**
 * @eq/intake — "Tidy Our Data" types
 *
 * Shared types for the tidy-pass engine (tidy-pass.ts) and orphan-check
 * (orphan-check.ts). These are also consumed by the tidy UI.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Entity scope
// ---------------------------------------------------------------------------

export type TidyEntity =
  | 'customer'
  | 'site'
  | 'contact'
  | 'staff'
  | 'licence'
  | 'asset';

export const TIDY_ENTITY_TABLES: Record<TidyEntity, string> = {
  customer: 'customers',
  site:     'sites',
  contact:  'contacts',
  staff:    'staff',
  licence:  'licences',
  asset:    'assets',
};

// ---------------------------------------------------------------------------
// Auto-fixable normalisation issues (Phase 1)
// ---------------------------------------------------------------------------

export type TidyFixType =
  | 'phone'      // E.164 normalisation
  | 'au_state'   // "New South Wales" → "NSW"
  | 'email'      // lowercase + typo fix
  | 'abn'        // spacing normalisation + checksum validation
  | 'date'       // ISO 8601 normalisation
  | 'string'     // trim / collapse whitespace
  | 'boolean'    // "Yes" → true
  | 'other';

export interface TidyFix {
  entity:    TidyEntity;
  table:     string;
  row_id:    string;          // DB primary key (uuid)
  row_label: string;          // display name for this row (company name, full name, etc.)
  field:     string;          // canonical field name
  fix_type:  TidyFixType;
  old_value: string;          // original value as it sits in the DB
  new_value: string;          // corrected value that will be written on approval
}

// ---------------------------------------------------------------------------
// Gap items — required fields missing or format invalid (Phase 2)
// ---------------------------------------------------------------------------

export type GapType =
  | 'required_missing'   // field is required but null/empty
  | 'format_invalid'     // value present but fails format check
  | 'fk_no_match';       // FK field has a value that doesn't resolve

export interface GapItem {
  entity:    TidyEntity;
  table:     string;
  row_id:    string;
  row_label: string;
  field:     string;
  gap_type:  GapType;
  message:   string;
  /** Present when the field is a closed enum (schema `enum: [...]`) — lets the UI render a dropdown of valid values instead of a free-text input. */
  allowed_values?: string[];
}

// ---------------------------------------------------------------------------
// Orphan items — broken FK relationships (Phase 4)
// ---------------------------------------------------------------------------

export type OrphanType =
  | 'asset_no_site'         // asset.site_id points to non-existent site
  | 'contact_no_parent'     // contact has no customer_id and no site_id
  | 'licence_no_staff'      // licence.staff_id points to non-existent staff
  | 'site_no_customer';     // site.customer_id points to non-existent customer

export interface OrphanItem {
  entity:      TidyEntity;
  table:       string;
  row_id:      string;
  row_label:   string;
  orphan_type: OrphanType;
  message:     string;
  bad_fk_id?:  string;      // the broken FK value, for display
}

// ---------------------------------------------------------------------------
// Review flags — items that need human attention but can't be auto-fixed
// ---------------------------------------------------------------------------

export interface ReviewFlag {
  entity:    TidyEntity;
  table:     string;
  row_id:    string;
  row_label: string;
  field:     string;
  flag_type: 'phone_kept_raw' | 'date_ambiguous' | 'value_unusual' | 'cross_field_warning';
  message:   string;
}

/** Entity the tidy pass could not scan — accountable skip, never a quiet hole. */
export interface TidyNotScanned {
  entity: TidyEntity;
  table:  string;
  reason: string;
}

// ---------------------------------------------------------------------------
// The full tidy report
// ---------------------------------------------------------------------------

export interface TidyReport {
  generated_at:  string;    // ISO timestamp
  tenant_id:     string;
  auto_fixes:    TidyFix[];
  gaps:          GapItem[];
  orphans:       OrphanItem[];
  review_flags:  ReviewFlag[];
  /** Entities requested but not scanned (missing schema, etc.). */
  not_scanned:   TidyNotScanned[];
  summary: {
    total_rows_scanned:  number;
    auto_fixes_found:    number;
    gaps_found:          number;
    orphans_found:       number;
    review_flags_found:  number;
    not_scanned_count:   number;
  };
}

// ---------------------------------------------------------------------------
// Options for running the tidy pass
// ---------------------------------------------------------------------------

export interface TidyPassOpts {
  supabase:    SupabaseLikeClient;
  tenantId:    string;
  /** Limit to specific entities. Defaults to all. */
  entities?:   TidyEntity[];
  onProgress?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Options for committing approved fixes
// ---------------------------------------------------------------------------

export interface TidyCommitOpts {
  supabase:    SupabaseLikeClient;
  tenantId:    string;
  /** Only the user-approved subset of auto_fixes. */
  fixes:       TidyFix[];
  onProgress?: (msg: string) => void;
}

export interface TidyCommitResult {
  intakeId:  string | null;
  applied:   number;
  skipped:   number;
  errors:    Array<{ fix: TidyFix; message: string }>;
}

// ---------------------------------------------------------------------------
// Options for orphan check
// ---------------------------------------------------------------------------

export interface OrphanCheckOpts {
  supabase:    SupabaseLikeClient;
  tenantId:    string;
  onProgress?: (msg: string) => void;
}

export interface OrphanCheckResult {
  orphans: OrphanItem[];
  summary: {
    assets_no_site_count:       number;
    contacts_no_parent_count:   number;
    licences_no_staff_count:    number;
    sites_no_customer_count:    number;
    total:                      number;
  };
}
