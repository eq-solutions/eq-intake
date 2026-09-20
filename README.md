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

Reference docs, read on demand:

- **[`EQ-FORMAT.md`](EQ-FORMAT.md)** — The reshape-out package (3
  SimPRO-quote profiles built today) plus the aspirational cleanup-in
  vision.
- **[`EQ-CARDS-INTAKE-BRIDGE.md`](EQ-CARDS-INTAKE-BRIDGE.md)** — Path A
  decision for migrating Cards onto canonical when the trigger fires.
- **[`PHASE-2-3-BACKLOG.md`](PHASE-2-3-BACKLOG.md)** — Deferred items
  parked for later. Treat as a graveyard, not a queue.

Live planning docs (replace each other quarterly):

- **[`PLAN-2026-05-24.md`](PLAN-2026-05-24.md)** — Current 90-day plan.
- **[`CONDUIT-AUDIT-2026-05-22.md`](CONDUIT-AUDIT-2026-05-22.md)** —
  Findings the plan was built on. Critical silent-drops to fix, drift,
  latent risks.

If you want to know what's running this week, read `git log`. If you
want to know what's running this quarter, read the live plan.

## Get it running

```powershell
cd C:\Projects\eq-intake\eq-platform
pnpm install                # codegen fires automatically via prepare hook
pnpm -r build               # all packages
pnpm -r test                # unit + sample-fixture validation tests
pnpm schemas:lint           # validate every schema against draft 2020-12
```

The `.env` lives at `eq-platform/.env` (gitignored). See `.env.example`
for the shape. Optional integration tests against the real Anthropic API
are gated on `ANTHROPIC_API_KEY` and cost ~half a cent per run.

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
| `schemas/` | Canonical JSON Schemas (source of truth, root copy) |
| `types/` | TS types generated from `schemas/` via `scripts/gen-types.mjs` |
| `samples/` | Real and synthetic fixtures used by the sample-validation harness |
| `test-fixtures/` | Synthetic edge-case fixtures for the coercion + validation tests |
| `sql/` | Canonical migrations (001–035; applied to the live `sks-canonical`) |
| `edge-functions/` | Supabase Edge Functions (`api-intake`, `approve-worker-assignment`) |
| `prompts/` | AI prompt templates (column mapping, vision extraction, continuation playbooks) |
| `demos/` | Standalone demos — engine smoke tests + the Intake one-screen prototype |
| `eq-platform/` | pnpm workspace — apps (`eq-shell`), packages, scripts |
| `_archive/` | Superseded planning + status docs, kept for archaeology only |

The `eq-platform` workspace ships seven packages (`@eq/schemas`,
`@eq/validation`, `@eq/intake`, `@eq/intake-demo`, `@eq/format-ui`,
`@eq/ai`, `@eq/confirm-ui`) plus the `eq-shell` app. See each package's
own README for current state — those decay slower than this one would
if it tried to describe them.

## Changelog

- **v4 (2026-05-24):** Mission revision. EQ is built for Royce's SKS NSW
  operations, not for external beta testers. PLAN-2026-05-22 superseded by
  PLAN-2026-05-24. Updated live planning pointer.
- **v3 (2026-05-22):** Slimmed against the audit + cull. Dropped stale
  "What's built" + Phase 1 ship criteria + NFR table.
- v1–v2.2 — see `_archive/` for the original Phase 1 build bundle README.
