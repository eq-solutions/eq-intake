# EQ Intake

The layer between the systems trade subbies are forced to use that don't
talk to each other. Not a replacement for the job-management system you
run. Not a competitor to your accounting platform. AI does the work of
learning each system's shape, so the connection doesn't need a human to
hand-build it. The thing in the middle that means apprentices don't do
the same induction four times a week and bookkeepers don't retype
timesheets at 8pm Friday.

The why lives in [`EQ-AS-CONDUIT.md`](EQ-AS-CONDUIT.md) — read it first.
Every other doc in this repo should be readable through that lens.

## Read these in order

1. **[`EQ-AS-CONDUIT.md`](EQ-AS-CONDUIT.md)** — Why this exists. The
   pain it removes. Source of truth for framing. If any other doc
   contradicts it, the framing wins.
2. **[`HOW-WE-WORK-WITH-AI.md`](HOW-WE-WORK-WITH-AI.md)** — Working
   principles for AI sessions on this project. The lesson from drifting
   off-frame early in the build and the rules that keep that from
   happening again. Open this any time a session has scope to touch
   architecture, planning, or strategy docs.
3. **[`EQ-BRIEFING.md`](EQ-BRIEFING.md)** — Cold-start primer. What
   EQ is at the module level, repo layout, working-with-Royce rules,
   shape of what's running today.
4. **[`EQ-TENANCY-MODEL.md`](EQ-TENANCY-MODEL.md)** — Per-tenant
   Supabase decision. Every deployment + schema-migration decision
   answers to this doc.
5. **[`EQ-INTAKE-ARCHITECTURE.md`](EQ-INTAKE-ARCHITECTURE.md)** —
   Technical shape: canonical layer in the middle, doors in, doors out.
6. **[`CLAUDE.md`](CLAUDE.md)** — Live-plane steward rules (DML-only;
   no DDL; no hand-writes to `_eq_migrations`).

Reference docs, read on demand:

- **[`EQ-FORMAT.md`](EQ-FORMAT.md)** — The reshape-out package (3
  SimPRO-quote profiles built today) plus the aspirational cleanup-in
  vision.
- **[`EQ-CARDS-INTAKE-BRIDGE.md`](EQ-CARDS-INTAKE-BRIDGE.md)** — Path A
  decision for migrating Cards onto canonical when the trigger fires.
- **[`PHASE-2-3-BACKLOG.md`](PHASE-2-3-BACKLOG.md)** — Deferred items
  parked for later. Treat as a graveyard, not a queue.
- **[`prompts/05-continue-improve-intake.md`](prompts/05-continue-improve-intake.md)**
  — Session prompt to keep improving Intake (trust, depth, no silent
  drops). Paste it to start the next intake session.
- **[`BENCHMARK-2026-09-21.md`](BENCHMARK-2026-09-21.md)** — Industry
  scorecard (**38/50**). Raise it with
  [`prompts/06-raise-industry-benchmark.md`](prompts/06-raise-industry-benchmark.md).

Historical planning (archaeology — not the live queue):

- **[`PLAN-2026-05-24.md`](PLAN-2026-05-24.md)** — May 2026 90-day plan
  (superseded by `git log` + open PRs for "what's next").
- **[`CONDUIT-AUDIT-2026-05-22.md`](CONDUIT-AUDIT-2026-05-22.md)** —
  Findings that plan was built on.

If you want to know what's running this week, read `git log`. If you
want the product why, read the conduit doc.

## Get it running

```bash
cd eq-platform
pnpm install                # codegen fires automatically via prepare hook
pnpm -r build               # all packages
pnpm -r test                # unit + sample-fixture validation tests
pnpm schemas:lint           # validate every schema against draft 2020-12
```

Copy [`eq-platform/.env.example`](eq-platform/.env.example) to
`eq-platform/.env` (gitignored) and fill in only what you need.
Optional integration tests against the real Anthropic API are gated on
`ANTHROPIC_API_KEY` and cost ~half a cent per run.

Playgrounds (from `eq-platform/`):

```bash
pnpm --filter @eq/intake-demo dev   # localhost:5174 — drop a sheet, map, validate
pnpm --filter @eq/format-ui dev    # reshape / validate CSV with AI mapping
```

## Schema ownership (two trees, one sync gate)

Neither tree is generated from the other. Both are hand-authored:

| Tree | Role |
|---|---|
| `schemas/` | Root copy — intake/service-heavy entities + `scripts/gen-types.mjs` |
| `eq-platform/packages/eq-schemas/src/schemas/` | Runtime `@eq/schemas` — what packages import |

Shared filenames must match structurally. CI runs
`node scripts/check-schema-sync.mjs` (carve-outs only via
`scripts/schema-sync-exceptions.json`).

## Standing rules

- **Generic placeholders only** in any output — never real client names
  in test fixtures or demo data.
- **EQ targets ALL trade subbies**, not just electrical.
- **Supabase: SELECT only without approval.** Never touch SKS live data
  unless explicitly instructed.
- **All Netlify / Cloudflare Pages apps need `_headers`** with security
  headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  HSTS).
- **Never push to demo branch without explicit instruction.**
- **Auth changes require chat review before deployment.**
- **Inductions, SWMS, prestarts, JSAs and other safety-critical features
  are never gated behind paywalls.** People die when corners get cut on
  this. We are not the reason a corner gets cut.
- **No "production-ready" / "battle-tested" / "ship-ready" language**
  for code that hasn't run with real users. Use "starting point, real
  running will reveal flaws."
- **Every row in deserves a row out.** No silent drops on intake,
  rollup, or reshape-out paths.

## What's in this repo

| Path | Purpose |
|---|---|
| `schemas/` | Root canonical JSON Schemas (see Schema ownership above) |
| `types/` | TS types generated from `schemas/` via `scripts/gen-types.mjs` |
| `samples/` | Real and synthetic fixtures used by the sample-validation harness |
| `test-fixtures/` | Synthetic edge-case fixtures for the coercion + validation tests |
| `sql/` | Tenant-plane SQL **staging** (numbered from the live ledger; hand to eq-shell's tenant-migrations pipe — not freestyle DDL on live) |
| `edge-functions/` | Supabase Edge Functions (`api-intake`, `approve-worker-assignment`, `eq-ai-assist`, `parse-maximo-pdf-wo`, `parse-rcd-switchboard-schedule`) |
| `supabase/functions/quality-guardian/` | Nightly data-quality Edge Function |
| `prompts/` | AI prompt templates (column mapping, vision extraction, continuation playbooks) |
| `demos/` | Standalone demos — engine smoke tests + the Intake one-screen prototype |
| `eq-platform/` | pnpm workspace — packages only (`@eq/schemas`, `@eq/validation`, `@eq/intake`, `@eq/ai`, `@eq/confirm-ui`, `@eq/intake-demo`, `@eq/format-ui`). The shell UI lives in the separate **eq-shell** repo. |
| `_archive/` | Superseded planning + status docs, kept for archaeology only |

## Changelog

- **v5 (2026-09-21):** Onboarding polish — accurate layout (no in-repo
  eq-shell), schema-ownership note, `.env.example`, sql staging language,
  historical plan labels.
- **v4 (2026-05-24):** Mission revision. EQ is built for Royce's SKS NSW
  operations, not for external beta testers. PLAN-2026-05-22 superseded by
  PLAN-2026-05-24. Updated live planning pointer.
- **v3 (2026-05-22):** Slimmed against the audit + cull. Dropped stale
  "What's built" + Phase 1 ship criteria + NFR table.
- v1–v2.2 — see `_archive/` for the original Phase 1 build bundle README.
