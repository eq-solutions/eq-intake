-- ============================================================================
-- 066 — Go/no-go tender qualification pack (Part C.1, remedial-building demo)
-- ============================================================================
-- Adds the pre-sale go/no-go screening entity: app_data.tender_qualifications.
--
-- Why a new standalone table, not an extension of contract_scope: a
-- qualification happens before a customer/job/contract exists in EQ at all —
-- no customer_id, site_id, or contact_id is available yet. It carries only
-- raw free-text header fields (customer_name_raw / contact_raw /
-- site_address_raw) and is promoted into the real canonical spine later, if
-- and when the tender is won. Matches schemas/tender_qualification.schema.json.
--
-- RLS + tenant scoping matches 001_intake_spine.sql's SHAPE (RLS enabled,
-- idempotent drop-then-create policies gated on the caller's tenant) but uses
-- the current JWT claim path — app_metadata, not 001's original user_metadata.
-- user_metadata is end-user-writable via supabase.auth.updateUser(), so a
-- tenant check keyed on it is spoofable; every migration from 008 onward
-- (_eq_intake_check_tenant_match, 009's quote tables, 049/053/065) already
-- moved to app_metadata for exactly this reason. New tables follow the
-- current standard, not the superseded one.
--
-- Commit path: ONE SECURITY DEFINER RPC, eq_intake_commit_qualification, a
-- single-row upsert keyed on qualification_id. Deliberately does NOT use
-- jsonb_populate_record(NULL::app_data.tender_qualifications, row) — that
-- exact pattern (see 054_contract_scope_commit.sql's assets branch) is a
-- live, known bug: it nulls out every column the caller's jsonb payload
-- omits, including NOT-NULL-defaulted ones. Every column is assigned
-- explicitly from p_payload instead, so an omitted key simply keeps its
-- column default / existing value on update.
--
-- "Rollback" is deliberately NOT a call to eq_intake_rollback or
-- eq_create_intake_event / eq_finish_intake_event — all three are permanently
-- dead fleet-wide (see commits a2282c1 / ac2486e; eq_create_intake_event
-- stopped creating the row eq_intake_rollback depends on). Archiving a
-- qualification is just calling eq_intake_commit_qualification again with
-- status='archived' — the same upsert path, no separate RPC needed.
--
-- This entity does not route through the generic eq_intake_commit_batch
-- dispatcher (it isn't a batch/spreadsheet import — one record per tender,
-- built up incrementally through a Q&A flow), so it has no
-- eq_intake_commit_batch_* branch and no unwinder. It is still registered in
-- shell_control.eq_schema_registry (module='intake') so the entity is
-- discoverable/versioned like every other canonical schema — see 009's own
-- step 5 for the precedent of registering straight from a migration rather
-- than depending on a separate seed-schemas.ts run against a live env.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_data.tender_qualifications (
  qualification_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL DEFAULT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  customer_name_raw        text NULL,
  contact_raw              text NULL,
  site_address_raw         text NULL,
  scope_summary            text NULL,
  contract_value_estimate  numeric(14,2) NULL,
  margin_estimate_pct      numeric(5,2) NULL,
  risk_answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision                 text NULL,
  decision_reason          text NULL,
  decision_made_by         uuid NULL,
  decision_made_at         timestamptz NULL,
  source_files             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                   text NOT NULL DEFAULT 'draft',
  schema_version           text NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NULL,
  updated_by               uuid NULL,
  CONSTRAINT tender_qualifications_decision_valid
    CHECK (decision IS NULL OR decision IN ('price', 'walk', 'needs_review')),
  CONSTRAINT tender_qualifications_status_valid
    CHECK (status IN ('draft', 'decided', 'archived')),
  CONSTRAINT tender_qualifications_decision_reason_required
    CHECK (decision IS NULL OR (decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0)),
  CONSTRAINT tender_qualifications_decided_has_decision
    CHECK (status <> 'decided' OR decision IS NOT NULL),
  CONSTRAINT tender_qualifications_risk_answers_is_object
    CHECK (jsonb_typeof(risk_answers) = 'object'),
  CONSTRAINT tender_qualifications_source_files_is_array
    CHECK (jsonb_typeof(source_files) = 'array')
);

CREATE INDEX IF NOT EXISTS tender_qualifications_tenant_idx
  ON app_data.tender_qualifications (tenant_id);
CREATE INDEX IF NOT EXISTS tender_qualifications_tenant_status_idx
  ON app_data.tender_qualifications (tenant_id, status, created_at DESC);

COMMENT ON TABLE app_data.tender_qualifications IS
  'Pre-sale go/no-go screening decisions for remedial-building tenders (plan '
  '§C.1). One row per tender. No customer/site/contact FK — those don''t '
  'exist yet at qualification time. Written only via eq_intake_commit_qualification.';

-- ----------------------------------------------------------------------------
-- 2. updated_at trigger — reuses the existing generic app_data._set_updated_at()
--    (defined in 009_quotes_domain.sql, hardened in 013_security_revoke_fix.sql)
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_tender_qualifications_updated_at ON app_data.tender_qualifications;
CREATE TRIGGER trg_tender_qualifications_updated_at
  BEFORE UPDATE ON app_data.tender_qualifications
  FOR EACH ROW EXECUTE FUNCTION app_data._set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. RLS — same shape as 001_intake_spine.sql (enable + idempotent
--    drop-then-create policies), current app_metadata tenant claim (see
--    header note). No DELETE policy: archiving is a status update, never a
--    hard delete — there is deliberately no way for even an RLS-permitted
--    caller to remove a row outright.
-- ----------------------------------------------------------------------------

ALTER TABLE app_data.tender_qualifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tender_qualifications_select ON app_data.tender_qualifications;
CREATE POLICY tender_qualifications_select ON app_data.tender_qualifications
  FOR SELECT TO authenticated
  USING (tenant_id = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid));

DROP POLICY IF EXISTS tender_qualifications_insert ON app_data.tender_qualifications;
CREATE POLICY tender_qualifications_insert ON app_data.tender_qualifications
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid));

DROP POLICY IF EXISTS tender_qualifications_update ON app_data.tender_qualifications;
CREATE POLICY tender_qualifications_update ON app_data.tender_qualifications
  FOR UPDATE TO authenticated
  USING (tenant_id = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid))
  WITH CHECK (tenant_id = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid));

-- ----------------------------------------------------------------------------
-- 4. RPC — eq_intake_commit_qualification: single-row upsert, explicit
--    column list (never jsonb_populate_record). Returns the committed row.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_intake_commit_qualification(
  p_tenant_id uuid,
  p_payload   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_id              uuid;
  v_status          text;
  v_decision        text;
  v_decision_reason text;
  v_decision_by     uuid;
  v_decision_at     timestamptz;
  v_risk_answers    jsonb;
  v_source_files    jsonb;
  v_row             app_data.tender_qualifications;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: p_tenant_id is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: p_payload must be a JSON object';
  END IF;

  -- Same tenant guard every eq_intake_commit_batch_* RPC already uses
  -- (008_decompose_intake_commit_batch.sql) — authenticated callers must
  -- match their own JWT tenant; service_role / non-REST callers bypass.
  PERFORM _eq_intake_check_tenant_match(p_tenant_id);

  v_id := NULLIF(p_payload ->> 'qualification_id', '')::uuid;
  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
  END IF;

  v_status := COALESCE(NULLIF(p_payload ->> 'status', ''), 'draft');
  IF v_status NOT IN ('draft', 'decided', 'archived') THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: invalid status %', v_status;
  END IF;

  v_decision := NULLIF(p_payload ->> 'decision', '');
  IF v_decision IS NOT NULL AND v_decision NOT IN ('price', 'walk', 'needs_review') THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: invalid decision %', v_decision;
  END IF;

  -- EQ-AS-CONDUIT rule #11 — a decision without its reasoning trail is a
  -- silent drop. Enforced here AND as a table CHECK constraint (belt + braces:
  -- this RPC is the only sanctioned write path, but the constraint still
  -- catches a future direct-RLS write that bypasses it).
  v_decision_reason := NULLIF(p_payload ->> 'decision_reason', '');
  IF v_decision IS NOT NULL AND (v_decision_reason IS NULL OR btrim(v_decision_reason) = '') THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: decision_reason is required whenever decision is set';
  END IF;
  IF v_status = 'decided' AND v_decision IS NULL THEN
    RAISE EXCEPTION 'eq_intake_commit_qualification: status ''decided'' requires a decision';
  END IF;

  -- Defaults: a freshly-set decision picks up who/when if the caller didn't
  -- supply them, without overriding an explicit value (e.g. a background
  -- extraction job back-filling an earlier manual decision's timestamp).
  v_decision_by := NULLIF(p_payload ->> 'decision_made_by', '')::uuid;
  IF v_decision_by IS NULL AND v_decision IS NOT NULL THEN
    v_decision_by := auth.uid();
  END IF;
  v_decision_at := NULLIF(p_payload ->> 'decision_made_at', '')::timestamptz;
  IF v_decision_at IS NULL AND v_decision IS NOT NULL THEN
    v_decision_at := now();
  END IF;

  v_risk_answers := p_payload -> 'risk_answers';
  IF v_risk_answers IS NULL OR jsonb_typeof(v_risk_answers) <> 'object' THEN
    v_risk_answers := '{}'::jsonb;
  END IF;
  v_source_files := p_payload -> 'source_files';
  IF v_source_files IS NULL OR jsonb_typeof(v_source_files) <> 'array' THEN
    v_source_files := '[]'::jsonb;
  END IF;

  INSERT INTO app_data.tender_qualifications AS tq (
    qualification_id,
    tenant_id,
    customer_name_raw,
    contact_raw,
    site_address_raw,
    scope_summary,
    contract_value_estimate,
    margin_estimate_pct,
    risk_answers,
    decision,
    decision_reason,
    decision_made_by,
    decision_made_at,
    source_files,
    status,
    schema_version,
    created_by,
    updated_by
  )
  VALUES (
    v_id,
    p_tenant_id,
    NULLIF(p_payload ->> 'customer_name_raw', ''),
    NULLIF(p_payload ->> 'contact_raw', ''),
    NULLIF(p_payload ->> 'site_address_raw', ''),
    NULLIF(p_payload ->> 'scope_summary', ''),
    (p_payload ->> 'contract_value_estimate')::numeric,
    (p_payload ->> 'margin_estimate_pct')::numeric,
    v_risk_answers,
    v_decision,
    v_decision_reason,
    v_decision_by,
    v_decision_at,
    v_source_files,
    v_status,
    NULLIF(p_payload ->> 'schema_version', ''),
    auth.uid(),
    auth.uid()
  )
  ON CONFLICT (qualification_id) DO UPDATE SET
    customer_name_raw        = EXCLUDED.customer_name_raw,
    contact_raw              = EXCLUDED.contact_raw,
    site_address_raw         = EXCLUDED.site_address_raw,
    scope_summary            = EXCLUDED.scope_summary,
    contract_value_estimate  = EXCLUDED.contract_value_estimate,
    margin_estimate_pct      = EXCLUDED.margin_estimate_pct,
    risk_answers             = EXCLUDED.risk_answers,
    decision                 = EXCLUDED.decision,
    decision_reason          = EXCLUDED.decision_reason,
    decision_made_by         = EXCLUDED.decision_made_by,
    decision_made_at         = EXCLUDED.decision_made_at,
    source_files             = EXCLUDED.source_files,
    status                   = EXCLUDED.status,
    schema_version           = EXCLUDED.schema_version,
    updated_by               = auth.uid()
  WHERE tq.tenant_id = p_tenant_id
  RETURNING tq.* INTO v_row;

  IF v_row.qualification_id IS NULL THEN
    -- Either a brand-new row (handled above — always returns) or an existing
    -- qualification_id owned by a DIFFERENT tenant, which the WHERE guard
    -- silently skipped. Surface that as an explicit error, never a quiet no-op.
    RAISE EXCEPTION 'eq_intake_commit_qualification: qualification % is not owned by tenant %', v_id, p_tenant_id;
  END IF;

  RETURN to_jsonb(v_row);
END;
$$;

COMMENT ON FUNCTION public.eq_intake_commit_qualification(uuid, jsonb) IS
  'Single-row upsert for app_data.tender_qualifications, keyed on '
  'qualification_id (minted here if absent). Explicit column-list INSERT/'
  'ON CONFLICT DO UPDATE only — never jsonb_populate_record. Archiving is '
  'the same call with status=''archived''; there is no separate rollback RPC.';

REVOKE ALL ON FUNCTION public.eq_intake_commit_qualification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eq_intake_commit_qualification(uuid, jsonb) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Register in shell_control.eq_schema_registry — same direct-INSERT
--    convention 009_quotes_domain.sql used for its own new entities (a
--    migration-time INSERT is self-contained; it doesn't depend on someone
--    later running sql/seed-schemas.ts against a live env). module='intake'
--    since this entity isn't owned by core/field/cards/quotes/service and
--    doesn't route through eq_intake_commit_batch's per-module dispatch.
-- ----------------------------------------------------------------------------

INSERT INTO shell_control.eq_schema_registry (entity, module, version, schema_json, description, is_current)
VALUES (
  'tender_qualification',
  'intake',
  '1.0.0',
  '{"x-eq-entity":"tender_qualification","x-eq-module":"intake","x-eq-version":"1.0.0","x-eq-table":"tender_qualifications","type":"object","description":"Pre-sale go/no-go screening decision for a remedial-building tender."}'::jsonb,
  'Pre-sale go/no-go tender screening decision.',
  true
)
ON CONFLICT (entity, version) DO UPDATE SET
  module      = EXCLUDED.module,
  schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description,
  is_current  = EXCLUDED.is_current;

-- Migration record — per sql/README.md, every self-insert stamps a checksum;
-- never insert (name) alone (eq-shell's check-tenant-drift.mjs hard-fails on
-- a NULL-checksum row dated on/after 2026-07-03).
INSERT INTO app_data._eq_migrations (name, checksum)
VALUES ('066_intake_qualification_pack', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
