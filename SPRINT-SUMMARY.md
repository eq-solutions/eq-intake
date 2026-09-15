# EQ Intake — What Got Built

> Originally written: 2026-05-29 (canonical-layer sprint series, eq-intake + eq-solves-service).
> Annotated: 2026-07-26 — the body below is left as the original point-in-time record; see
> "Since this was written" for what's shipped in eq-intake specifically since. For anything
> current, `eq-context/eq/changelog/eq-intake.md` is the live source of truth, not this file.

---

## Since this was written (2026-06 → 2026-07)

The intake demo app (`@eq/intake-demo`) grew a whole adjudication layer on top of the canonical
spine this doc describes — none of it existed on 2026-05-29:

- **Write-time site duplicate resolver** — a `BEFORE INSERT` trigger flags likely-duplicate site
  writes as they happen, not after a scan (eq-shell migration 0179).
- **Adjudication console** (Health tab, "Duplicates caught at the write") — a human records
  Same/Different/Unsure against each flagged write; Claude can suggest a verdict + reason first.
- **Site merge preview → execute** — once a "Same" verdict is recorded, a manager can preview
  exactly what would move (row counts per table) before confirming a merge; the loser is retired,
  never deleted.
- **Sites Dupes tab** — usage-based survivor auto-pick (assets/quotes/contract-scopes/jobs
  counts decide which duplicate row is real, not just active+has-customer), plus a manual
  "Flag for merge" action feeding the same adjudication console.
- **Remediation queue** (Queue tab) — the data steward's review surface for anything the system
  can't defensibly auto-fix, with full audit lineage through `eq_intake_events`.
- **Ask tab** — natural-language queries over canonical data via the `eq-ai-assist` Edge Function.
- **Health tab polish (PR #76, 2026-07-26)** — tab pending-count badges, progressive section
  loading instead of one all-or-nothing spinner, an un-capped duplicates list, and Ask questions
  now carry their filters into the entity drill-down instead of dropping them.
- **Security/hardening**: `xlsx@0.18.5` migrated to `exceljs` (known CVE); basic CI (install,
  typecheck, build, test) added for the whole `eq-platform` monorepo; the duplicate detector's
  SY9 blind spot (it silently skipped inactive rows) fixed.
- `sql/029_rate_limiting.sql` and `sql/032_api_audit_log.sql` below are now annotated as
  superseded by the `app_metadata`-keyed RLS policy eq-shell actually ships — see those files.

---

## The point of this work

The canonical layer is the product. EQ apps are replaceable interfaces that read and write to one source of truth. This sprint series built that source of truth and wired EQ Service into it.

---

## What is live and useful today (as of 2026-05-29 — see above for what's shipped since)

### Canonical Supabase (sks-canonical — ehowgjardagevnrluult)

**Tables with real data:**
- `customers` — 128 rows
- `sites` — 52 rows
- `staff` — 50 rows
- `assets` — 1000 rows (with `condition`, `ppm_frequency`, `criticality`, `last_service_date`, `next_service_due`)
- `licences` — 3 rows

**PPM tables (live, empty — populated by EQ Service write-through):**
- `service_visits`
- `service_task_completions`
- `asset_test_results`
- `asset_defects`

**RPCs callable from Studio today:**
- `eq_ppm_asset_status(tenant_id, site_id?)` — per-asset compliance snapshot
- `eq_ppm_site_summary(tenant_id, site_id?)` — per-site health, open defects, next visit
- `eq_ppm_overdue_assets(tenant_id, days_overdue?)` — assets past due sorted by criticality
- `eq_ppm_open_defects(tenant_id, severity?)` — open defects with age in days
- `eq_ppm_visit_completion_rate(tenant_id, from_date?, to_date?)` — task completion per visit

---

### EQ Service write-through (eq-solves-service — live at service.eq.solutions)

Every time a technician does work in EQ Service, the relevant record syncs to canonical:

| EQ Service action | Canonical table populated |
|---|---|
| Asset created / updated | `asset_test_results` via `syncAsset` |
| Test record saved (generic) | `asset_test_results` via `syncTestResult` |
| RCD test saved & marked complete | `asset_test_results` via `syncTestResult` |
| Defect raised | `asset_defects` via `syncDefect` |
| Defect status changed | `asset_defects` via `syncDefect` |

All syncs are fire-and-forget — EQ Service never blocks on canonical being reachable.

Key file: `lib/canonical-sync.ts` — `syncAsset`, `syncTestResult`, `syncDefect`, plus external-ID helpers (`eq-service:asset:<id>`, `eq-service:rcd_test:<id>`, etc.)

---

### eq-intake (canonical intake engine)

**What it does:** Parses structured files (CSV, XLSX, SimPRO exports) and commits rows to the canonical Supabase via RPCs.

**Four intake surfaces:**
1. `RollupDropZone` — browser drag-and-drop, multi-sheet XLSX
2. `CanonicalCommitSection` — browser canonical commit with mapping preview + rejected-row CSV download
3. `scripts/migrate-cards-to-canonical.mjs` — one-shot CLI migration (Cards → canonical)
4. `edge-functions/api-intake` — POST endpoint, Bearer JWT auth, rate-limited, `dry_run` flag

**SQL migrations (sql/001–035):**
- 001–027: canonical spine — customers, sites, contacts, staff, licences, RPCs, RLS
- 028: PPM tables on canonical
- 029: per-tenant rate limiting (50 calls / 60 min rolling window)
- 030: `eq_get_intake_health` observability RPC
- 031: schema registry sync
- 032: `api_intake_calls` audit log
- 033: `eq_exec_sql` RPC (service_role only, used by migration runner)
- 034: 5 PPM report RPCs
- 035: (contains materialized views — **not applied to sks-canonical**, dropped as premature)

**Applying migrations:** `sql/` is staging only — NOT self-serve applyable to live tenant planes (CLAUDE.md Rule 2). Numbering is allocated from the live `app_data._eq_migrations` ledger; actual apply goes through eq-shell's `supabase/tenant-migrations/` via `tenant-migrate.yml` (Royce-dispatched). See sql/README.md.

**Derive profiles (12):**

| ID | Input | Purpose |
|---|---|---|
| `bom` | raw | Bill of materials |
| `device-register` | raw | Device register |
| `labour-summary` | raw | Labour summary |
| `equinix-asset-register` | raw | Equinix asset register |
| `equinix-contractor` | raw | Equinix contractor portal |
| `xero-payroll-timesheets` | raw | Xero payroll timesheets |
| `myob-payroll-timesheets` | raw | MYOB payroll timesheets |
| `equinix-audit-simpro` | raw | Equinix audit → SimPRO job completion |
| `ppm-sow` | canonical | PPM Statement of Work |
| `asset-register-export` | canonical | Client-ready asset register |
| `site-register-export` | canonical | Site register |
| `service-visit-schedule` | canonical | Monthly service visit schedule |

**Test coverage:** 131 assertions across all 5 canonical profiles + registry smoke tests (`eq-platform/packages/eq-format-ui/test/`).

---

## What is NOT built yet

| Item | Why not |
|---|---|
| PPM dashboard UI | No `/ppm` page exists in EQ Service. Build this before adding any more backend. |
| Cards → canonical migration (actual run) | Needs `sks-canonical-eq` Supabase provisioned (billing decision) |
| PostHog / Sentry wiring | Config-only, wire when API keys are ready |
| Materialized views for PPM | Dropped — premature without a dashboard. Add them if the live RPCs are too slow once a UI exists. |

---

## Known CI issues (eq-solves-service, pre-existing)

- `SUPABASE_ACCESS_TOKEN` GitHub secret expired — Data Quality workflow 401s on every push. Rotate in GitHub → Settings → Secrets.
- 4 moderate npm vulns remain (uuid chain through exceljs/svix/resend) — require breaking changes to fix, deferred.

---

## How to apply SQL migrations

`sql/` is staging, not a self-serve apply path (CLAUDE.md Rule 2). Author the
migration here, get it numbered against the live `app_data._eq_migrations`
ledger (see sql/README.md), then hand it to eq-shell's
`supabase/tenant-migrations/` lineage via `tenant-migrate.yml`
(Royce-dispatched) — that's the only writer of the live ledger.

(`scripts/apply-migrations.mjs`, an earlier self-apply tool referenced here,
was retired 2026-09-15 — it tracked a different, shadow ledger table
(`app_data.eq_migrations`, no underscore) that eq-shell's drift tooling
never saw, which is exactly the failure mode Rule 1 exists to prevent.
Confirmed live on both ehow and zaap: that shadow table was never actually
created on either — the script never successfully ran.)
