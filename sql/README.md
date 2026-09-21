# eq-intake tenant-plane SQL

**Staging only.** Files here are authored for hand-off to the owning
migration pipe — they are **not** self-serve applyable to live tenant
planes. See root [`CLAUDE.md`](../CLAUDE.md) Rules 1–2.

| Surface | Owner / pipe |
|---|---|
| `app_data.*` | **eq-shell** — `supabase/tenant-migrations/` via `tenant-migrate.yml` |
| `service.*` | **eq-solves-service** — its own `supabase/migrations/` |

Numbering is allocated from the **live ledger**
(`app_data._eq_migrations`), which this lineage shares with eq-shell.
Do not renumber or delete live-ledger rows to "clean up."

## When a migration is ready to land

1. Author the SQL here (or request the object via the owning repo).
2. Hand it to eq-shell's tenant-migrations lineage for governed apply.
3. The eq-shell migration runner is the **single** live ledger writer —
   do not hand-`INSERT` into `app_data._eq_migrations` on ehow/zaap.

## Staging provenance marker (local drafts only)

If a draft needs a ledger-shaped footer for review before hand-off, use:

```sql
INSERT INTO app_data._eq_migrations (name, checksum)
VALUES ('NNN_short_name', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
```

**Never insert `(name)` alone.** eq-shell's drift gate
(`scripts/check-tenant-drift.mjs`) hard-fails on any NULL-checksum ledger
row dated on/after 2026-07-03. The `'eq-intake-lineage'` marker is
greppable provenance for staging archaeology — live applies still go
through the eq-shell runner.

Context: eq-shell PR #612 (0157 quality-guardian adoption); the gate went
red on 2026-07-03 when `058` + `062` landed with NULL checksums
(backfilled the same day).
