# eq-intake — CLAUDE.md

EQ Intake is the parse/emit engine behind EQ Cards, plus data-quality steward
runs against the live tenant planes. This file exists mainly to stop one
failure mode that has now happened twice.

## Rule 1 — Steward runs are DML-ONLY on live tenant planes

When a session (steward run, quality run, remediation pass) touches a live
Supabase tenant plane — ehow (`ehowgjardagevnrluult`, SKS) or zaap
(`zaapmfdkgedqupfjtchl`, EQ) — it may UPDATE/INSERT/DELETE **data** it has been
asked to fix. It must NOT:

- **Run any DDL** — no `CREATE TABLE/VIEW/FUNCTION/TRIGGER/INDEX`, no `ALTER`,
  no `DROP`, no RLS enable/disable, no `GRANT`/`REVOKE`, no policy changes.
- **Write to `app_data._eq_migrations`** — the eq-shell migration runner is
  the SINGLE ledger writer. As of 2026-07-03 the eq-shell drift gate
  hard-fails on any NULL-checksum ledger row dated after 2026-07-03, so a
  hand-inserted row (like `057_remediation_queue`, 2026-07-02, since reconciled away) now turns the
  gate red within 3 hours and blocks all eq-shell merges.

**Why:** the 2026-07-02 steward run 001 created `app_data.eq_remediation_queue`
and hand-inserted a ledger row on ehow. The table was sound, but it was
invisible to eq-shell's baseline/drift tooling and had to be retro-adopted
(eq-shell tenant-migration `0156_adopt_eq_remediation_queue.sql`). Schema that
lives outside a governed lineage is drift the moment it lands, however good it
is.

**If a steward run needs a table/RPC/index that doesn't exist:** stop, and
request it through the owning repo's migration path (see Rule 2). The queue
table you probably want already exists: `app_data.eq_remediation_queue`
(service_role-only; columns: entity, record_id, field, category,
current/suggested_value, confidence, reason, evidence, status).

## Rule 2 — Schema ownership on the tenant planes

One object, one lineage. Before authoring any schema change, route it to the
repo that owns the surface:

| Surface | Owner / pipe |
|---|---|
| `app_data.*` (canonical entities, ledger, queue tables) | **eq-shell** — `supabase/tenant-migrations/` via `tenant-migrate.yml` (Royce-dispatched) |
| `service.*` (EQ Service CMMS surface) | **eq-solves-service** — its own `supabase/migrations/` lineage (e.g. 0167 contacts cutover) |
| `public.*` legacy Field tables on ehow | frozen — lockdown work only, via eq-shell migrations |
| eq-intake `sql/` folder | staging for changes that get handed to the owning pipe — files here are NOT self-serve applyable to live planes |

Duplicating an object's DDL into a second lineage is itself drift — the two
repos will fight over its shape on every dispatch.

## Rule 3 — Migration numbering

eq-intake `sql/` numbers (3-digit: `053_…`, `057_…`) are staging numbers, not live
ledger names. Do not delete or renumber rows in the live ledger to "clean
up" — eq-shell's `--reconcile-ledger` coordinates that, and dropping a row
that a numbering assumes consumed causes collisions. Current state (checked on
ehow 2026-11-05): the `057_remediation_queue` row is no longer in the ledger; the
reconcile happened and the table is recorded by eq-shell migration
`0156_adopt_eq_remediation_queue.sql`. Live ledger names are eq-shell's 4-digit
style, so agree the number with eq-shell before handing a change to it.
