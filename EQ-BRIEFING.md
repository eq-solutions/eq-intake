# EQ — Project Briefing

> **For anyone (or any AI session) joining this project cold.** Read this
> first. The deeper docs are linked at the end.
>
> Last updated 2026-05-31.

---

## What EQ is

EQ is the layer between the systems trade subbies already use — whatever
job-management system, whatever accounting platform, whatever
principal-contractor portal. AI does the work of learning each one's
shape, so nobody has to hand-build the connection. It removes the
human-retyping step between them.

It is **not** a SaaS platform aggregating customer data. It is **not** a
replacement for any existing tool. Each customer's EQ instance sits
between *their* systems and stays out of every other customer's data.

**For whom and when:** the apprentice doing the same induction four
times this week. The bookkeeper retyping timesheets at 8pm Friday. The
PM photographing a SWMS and emailing it to a compliance officer who
uploads it into yet another portal. Every feature must trace to a
specific person and a specific moment.

**Read `EQ-AS-CONDUIT.md` for the full why.** Vocabulary check —
words that signal drift: "SaaS", "platform play", "TAM", "moat",
"customers" used generically, "scaling", "battle-tested". Avoid them.
Use "the boys", "the bookkeeper", "the moment of retyping".

---

## EQ as a set of modules

EQ ships as one **shell app per tenant**, with modules lazy-loaded
inside it:

```
                   ┌──────────────────────────────────┐
                   │  EQ Shell    (sks.eq.solutions)  │
                   │  ────────                        │
                   │  • Auth (one Supabase session)   │
                   │  • Per-tenant config (modules    │
                   │    enabled, brand palette)       │
                   └────┬──────┬──────┬──────┬────────┘
                        │      │      │      │
                  ┌─────┘      │      │      └─────┐
                  ▼            ▼      ▼            ▼
              [Cards]      [Intake] [Quotes]   [Service]
              lazy-loaded routes — each module is its own
              buildable React package
```

Modules:
- **EQ Cards** — mobile capture (inductions, prestarts, SWMS). Lives in a
  separate repo (`C:\Projects\eq-cards`). Onboards a *person* (licence
  wallet, inductions). **As-built (audited 2026-05-31):** the Cards backend
  RPCs (`eq_cards_*`) and captured data (profiles/licences) live on the
  **control plane `eq-canonical`** (`jvknxcmbtrfnxfrwfimn`) — *not* the
  worker pool, and *not* the `hshvnjzczdytfiklhojz` project older docs cite
  (verify which Supabase the Flutter app actually points at before relying
  on either). The *intended* model is worker-first (a person lands in a
  global worker pool, projected into a tenant on engagement) — that's design,
  not current reality. See the bridge doc + `EQ-TENANCY-MODEL.md`.
- **EQ Field** — scheduling / staff. SKS Field LIVE is in production on
  its own Supabase. Phase 3: migrates onto canonical.
- **EQ Service** — work-order management. Built for SKS, going live in
  weeks. Will read/write canonical from day one.
- **EQ Intake** — multi-source intake + reshape-out (SimPRO bundle →
  Xero / MYOB / Outlook / SharePoint / custom-template). Built in this
  repo. Running against real SimPRO exports; canonical wiring pending
  the Supabase provisioning step. Honest qualifier: starting point,
  real running will reveal flaws.
- **EQ Quotes** — quoting tool for SKS. Stub placeholder today; reads
  customer/site/contact from canonical when built.

---

## Tenancy model — control plane + per-tenant Supabase

Two layers (refined 2026-05-31 — earlier versions of this doc described
only the per-tenant layer):

**1. Control plane — one shared project: `eq-canonical`**
(`jvknxcmbtrfnxfrwfimn`). Holds *auth + routing*, not customer data: live
login + JWT minting, the tenant registry/router (`shell_control.tenants` /
`tenant_routing` — which tenants exist and which Supabase holds each one's
data), and currently the **Cards backend** (`eq_cards_*` RPCs). This is where
you log in and get routed to your tenant. **⚠ Name trap:** the control plane
is `eq-canonical`, NOT `eq-canonical-internal` — the `-internal` project is a
*tenant data store* despite its name. (Verified by live audit 2026-05-31; an
earlier doc pass had these two inverted.)

**2. Per-tenant data plane — one Supabase project per customer.** Physical
data isolation, not RLS-shared. **`sks-canonical`** (`ehowgjardagevnrluult`)
is the SKS tenant (real data); **`eq-canonical-internal`**
(`zaapmfdkgedqupfjtchl`) is the EQ-Solutions tenant (seeded with demo data
today). EQ Quotes reads customers/sites/contacts from the relevant tenant
plane. See `EQ-TENANCY-MODEL.md` → "Project roles — AUDITED & CORRECTED
2026-05-31" for the full picture and open items. Decision logged 2026-05-18 after walking
through trade-offs. When a tenant engages a worker, that worker is
**projected** into the tenant's canonical as a `staff` row (`role = self`).
One worker → N tenant projections, no re-import — that's how "capture once
in Cards, exist everywhere" works.

Why per-tenant won:
- EQ touches payroll / compliance / sensitive operational data — physical
  isolation is the cleanest compliance story
- Blast radius of any future bug is one customer, not all
- $25/mo per tenant at Supabase Pro is rounding error at trade-subbie scale
- When customer count reaches ~20+, automate provisioning via the
  Supabase Management API

For SKS specifically:
- Supabase project name: **`sks-canonical-eq`** (Sydney region)
- This becomes SKS's canonical layer — every SKS EQ module reads/writes
  to it (Field, Service, Intake, Quotes, Cards eventually)
- Field LIVE + Cards stay on their existing Supabases until planned
  cutovers later (Phase 3 + 4)

For future tenants: same shell repo, new Netlify site, different env
vars (`VITE_SUPABASE_URL` etc.), new tenant-prefixed Supabase project.

**Read `EQ-TENANCY-MODEL.md` for the full architecture + the SKS Phase
1-4 path.**

---

## Repo layout

```
C:\Projects\eq-intake\           ← THIS REPO (intake + shell)
├── EQ-AS-CONDUIT.md             — the why (read first)
├── HOW-WE-WORK-WITH-AI.md       — working principles
├── EQ-INTAKE-ARCHITECTURE.md    — technical shape of the intake stack
├── EQ-TENANCY-MODEL.md          — per-tenant + shell pattern
├── EQ-FORMAT.md                 — reshape-out profiles (3 built) + aspirational cleanup-in
├── EQ-CARDS-INTAKE-BRIDGE.md    — Cards migration plan
├── EQ-BRIEFING.md               — this file
├── sql/                         — base migrations 001-012 (paste-ready, not yet applied)
├── demos/                       — standalone Node scripts
│   └── simpro-customer-rollup/  — the SimPRO→SharePoint CSV joiner
└── eq-platform/                 — pnpm workspace
    ├── apps/
    │   └── eq-shell/            — the per-tenant shell app
    │       └── DEPLOY.md        — step-by-step deploy guide
    ├── packages/
    │   ├── eq-schemas/          — JSON Schemas + TS/Zod/SQL codegen
    │   ├── eq-validation/       — coercers + validator orchestrator
    │   ├── eq-ai/               — vendor-agnostic AI provider
    │   ├── eq-intake/           — parsers (CSV/XLSX/PDF/photo)
    │   ├── eq-format-ui/        — SimPRO-quote reshape-out profiles
    │   ├── eq-confirm-ui/       — single-file confirm flow components
    │   └── eq-intake-demo/      — Intake module + standalone playground
    └── scripts/
        └── db-apply.ts          — migration sequencer

C:\Projects\eq-cards\             ← separate repo (EQ Cards)
```

---

## Current state — read `git log` for the week, this for the shape

A snapshot decays in days. Specific claims like "12 schemas" or "293 tests passing" stop being true the moment the next commit lands. So this section captures the *shape*, not the *count* — `git log` and the package source are authoritative for what's running today.

**Shape of what's running:**
- A growing set of canonical JSON Schemas in `schemas/` (and a copy in `eq-platform/packages/eq-schemas/src/schemas/` that's mid-sync — see memory `project_eq_platform_schema_drift_pending`). 42 entities across staff / site / asset / customer / contact / service / safety / tests as of the S3 seed (2026-05-24).
- SQL codegen + a migration sequencer producing a single SQL file paste-ready for any Supabase project.
- `@eq/shell` with Supabase Auth + lazy module routing + SKS palette.
- `@eq/intake-demo` (the Intake module) — running and exercised against real SimPRO exports. Mounts in shell at `/intake`. Supports SimPRO bundle drop → five destination templates (SharePoint rollup / Quotes-by-site / Xero ContactsImport / MYOB Card File / Outlook contacts).
- `@eq/format-ui` — three SimPRO-quote reshape-out profiles (BOM, device-register, labour-summary). See `EQ-FORMAT.md`.
- `/api/admin/export` live on eq-solves-service.netlify.app, returning canonical-shape JSON for the entities currently wired (memory `project_admin_export_endpoint` has the live list).
- Cards licence-canonical entity work landed 2026-05-20 to 21 (Cards Unit 2.A) — see commits `06fdcbd`, `ac4ccc6`, the PR #5 merge.
- Maximo PDF skill (`@eq/intake/skills/maximo-pdf-wo`) shipped and deliberately parked — see memory `project_maximo_pdf_wo_skill` for the cost/latency reasoning.

These are *starting points, not finished things*. Real running will reveal flaws. No "production-ready" claims for any of it.

**Canonical Supabase: provisioned and live.** `sks-canonical` (`ehowgjardagevnrluult`, Sydney) is the SKS production tenant data plane — populated (125 customers, 331 contacts, 50 staff, 4,808 assets, PPM tables + RPCs) and migrations 001–035 applied. Auth + tenant routing live on the control plane `eq-canonical` (see the tenancy doc's "Project roles — AUDITED" table). Field LIVE + Cards still sit on their own Supabases until their planned cutovers.

**Where to look for what's next:** `PLAN-2026-05-24.md` carries the live 90-day plan. The short version: fix the C1-C2-C3 silent drops, build the Equinix → SimPRO reshape profile, wire Cards onto canonical, and ship the Intake one-screen redesign (see `INTAKE-REDESIGN-SPEC.md` + `demos/intake-one-screen/`). See the full 12-week sequence there.

---

## How to work with Royce

Per `HOW-WE-WORK-WITH-AI.md` + his global `~/.claude/CLAUDE.md`:

- **Direct, concise, no preamble.** Deliver first, explain briefly after.
- **Every question to him must have pre-populated answer options.** Use
  the AskUserQuestion tool. Recommended option first with
  `(Recommended)` suffix. Always include a free-text fallback option.
  Even for binary yes/no.
- **Explain before you ask.** Write a short briefing in chat before the
  AskUserQuestion call — what the question means, what's true today,
  what each option implies, what you recommend and why.
- **Never deploy without explicit instruction.** No `git push`. No
  Netlify deploys. No Supabase project creation. Those are Royce's
  steps.
- **Auth changes require explicit approval before any deployment.**
- **Never touch SKS Field LIVE Supabase or EQ Cards Supabase** unless
  the task explicitly says so. They're in production.
- **Lowercase file names, package names in backticks.**
- **Reference "the boys", "the bookkeeper", "6:30am on Tuesday"** —
  not "users" or "stakeholders" or "customers".
- **Plus Jakarta Sans font, EQ palette** (Sky `#3DA8D8`, Deep `#2986B4`,
  Ice `#EAF5FB`, Ink `#1A1A2E`). SKS palette (dark blue `#1F335C`,
  purple `#7C77B9`) when in SKS-branded surfaces.
- **No gradients, no shadows.** Linear/Notion aesthetic.
- **Honest qualifiers:** "this is a starting point. Real running will
  reveal flaws." NEVER "production-ready", "battle-tested", "ship-ready"
  unless real users have actually run it.

---

## When stuck

- Read `git log` for recent work — SESSION-LOG.md is archived (`_archive/`)
- Read `EQ-AS-CONDUIT.md` if framing feels off
- Check `~/.claude/projects/C--Projects-eq-intake/memory/` for
  auto-memory entries Royce has accumulated
- Ask Royce with pre-populated options
