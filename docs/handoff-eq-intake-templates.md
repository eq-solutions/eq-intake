# Hand-off to eq-shell: `eq_intake_templates` (mapping memory)

**Status: spec only. Nothing here is applied, and no DDL lives in this repo.**
eq-shell owns `app_data.*` and the tenant-migrations pipe
(`supabase/tenant-migrations/` via `tenant-migrate.yml`, Royce-dispatched), so
it authors the real migration, picks the 4-digit number, and adopts the object
into its ledger. Per `CLAUDE.md` Rules 1–3, eq-intake only stages the intent.

## Why

`@eq/validation` `computeSignatureHash` fingerprints a file's shape (entity,
normalised column names, per-column value-pattern class — no values, no PII).
The client side (`eq-intake/src/mapping-memory.ts`) looks a confirmed mapping
up by that hash before calling the AI mapper, and stores the mapping the user
confirms. Today only an in-memory store exists.

## Verified live 2026-11-05 (read-only SELECT)

- ehow `ehowgjardagevnrluult` and zaap `zaapmfdkgedqupfjtchl`: no table or
  function matching `%intake_template%`.
- Both have `public.eq_intake_commit_batch_{cards,core,field,quotes,service}`.

## Table (proposed): `app_data.eq_intake_templates`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | |
| `tenant_id` | `uuid` not null | tenant scope; mapping is never shared across tenants |
| `entity` | `text` not null | canonical entity, lower-case |
| `signature_hash` | `text` not null | 64-char hex SHA-256 |
| `mapping` | `jsonb` not null | `{ "<source column>": "<canonical field>" \| null }` |
| `confirmed_by` | `uuid` null | user who confirmed the mapping |
| `use_count` | `integer` not null default 0 | |
| `created_at` / `updated_at` | `timestamptz` not null default `now()` | |
| `last_used_at` | `timestamptz` null | |

- Unique `(tenant_id, entity, signature_hash)`.
- Check `signature_hash ~ '^[a-f0-9]{64}$'`; `jsonb_typeof(mapping) = 'object'`.
- RLS on; no direct grants to `anon`/`authenticated`. Access only through the
  RPCs below (consistent with the other intake RPCs). `service_role` full.
- No row data is stored — only column names and canonical field names.

## RPCs (proposed, `SECURITY DEFINER`, `search_path` pinned, `EXECUTE` revoked from `PUBLIC`/`anon`)

1. `eq_intake_template_find(p_entity text, p_signature_hash text) returns jsonb`
   - Tenant taken from the caller's JWT, never from an argument.
   - Returns `{ "hit": false }` or `{ "hit": true, "mapping": {...}, "saved_at": "...", "use_count": n }`.
2. `eq_intake_template_save(p_entity text, p_signature_hash text, p_mapping jsonb) returns jsonb`
   - Upsert on the unique key; sets `confirmed_by` from the JWT; keeps `use_count`.
   - Requires an import-capable role (use the existing intake permission).
3. `eq_intake_template_touch(p_entity text, p_signature_hash text) returns void`
   - Increments `use_count`, sets `last_used_at`.

Client contract these map to: `MappingMemory.find / save / touch` in
`eq-intake/src/mapping-memory.ts`. The client treats a hit whose mapping names
a column absent from the incoming file as a miss (`stale_columns`), so the
server does not need to validate that.

## Open questions for eq-shell

- Tenant planes only (ehow, zaap, graft, madagins) or also the jvkn control plane?
  Recommendation: tenant planes, since mappings follow the tenant's data.
- Should templates be per-user or per-tenant? Spec assumes per-tenant.
- Retention: none proposed; rows are tiny.

## Not in scope here

Applying anything, editing eq-shell, or adding `sql/` files. When eq-shell
lands the migration, wire a Supabase-backed `MappingMemory` in the app that
owns the Supabase client; this package stays dependency-free.
