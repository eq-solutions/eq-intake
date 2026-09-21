# EQ Tenancy Model

> **Read `EQ-AS-CONDUIT.md` first.** That's the why. This doc is the
> tenancy and deployment shape — how EQ modules plug in to each other
> per customer.

Decision logged 2026-05-18 after the post-rollup-shipped strategy
review. Foundational — every Supabase / deployment / schema-migration
decision from here on answers to this doc.

---

## The model in one diagram

```
┌───────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE — ONE shared project (eq-canonical)                  │
│  ref: jvknxcmbtrfnxfrwfimn                                          │
│  ⚠ NAME TRAP: the control plane is "eq-canonical" — NOT             │
│    "eq-canonical-internal". The "-internal" project is a tenant     │
│    data plane despite its name. Confirmed by live audit 2026-05-31. │
│                                                                     │
│  Live auth + JWT minting:                                           │
│    custom_access_token_hook · sessions · mint/revoke · 8 users      │
│  Tenant routing — shell_control.tenants · tenant_routing            │
│    (which tenants exist → which Supabase holds each one's data)     │
│  Cards backend — eq_cards_* RPCs · cards_field_approvals            │
│                                                                     │
│  This is where login happens and where each tenant request is       │
│  routed to its data-plane Supabase.                                 │
└───────────────┬─────────────────────────────────────────────────────┘
                │  routes a logged-in user to their tenant's data plane
                │  (and, in the intended worker model, a worker is
                │   PROJECTED into that tenant's canonical as a staff row)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│         ONE canonical Supabase project — PER TENANT             │
│         (e.g. sks-canonical · ehowgjardagevnrluult)             │
│                                                                 │
│  Platform tables:                                               │
│    eq_schema_registry · eq_intake_events · eq_intake_row_audit  │
│    eq_intake_templates · eq_export_events · eq_export_profiles  │
│                                                                 │
│  Canonical entity tables (generated from @eq/schemas):          │
│    staff · customer · contact · site · asset · swms ·           │
│    prestart · jsa · toolbox_talk · incident · itp · schedule    │
│                                                                 │
│  Supabase Auth (per-tenant user pool)                           │
│  RLS — but enforcing role-within-tenant, not cross-tenant       │
└──────────┬───────────────┬───────────────┬──────────────┬───────┘
           │               │               │              │
           ▼               ▼               ▼              ▼
      EQ Field        EQ Service       EQ Intake     EQ Quotes
      (mobile)        (work orders)    (in/out)      (quoting)
      ────────        ────────         ────────      ────────
      Each module = a frontend app (Vite/React/Netlify).
      ALL point at the SAME tenant's Supabase.
      Each module owns a SURFACE, not data.
      All share @eq/schemas + @eq/validation + @eq/confirm-ui.
```

**Two layers, two jobs.** The **control plane** (`eq-canonical` /
`jvknxcmbtrfnxfrwfimn`) is one shared project that holds *auth + routing*:
who you are (login, JWT minting) and which tenant Supabase your request is
sent to (`shell_control.tenants` / `tenant_routing`). It also currently
hosts the **Cards backend** (`eq_cards_*` RPCs). The **per-tenant data
plane** is one project per customer that holds *their data*
(`sks-canonical` = SKS; `eq-canonical-internal` = the EQ-Solutions tenant).

**Each customer (SKS, future customers) gets their own Supabase project.**
That project is THEIR canonical layer. Every EQ module they use points at it.

## The control plane (worker pool + tenant registry)

> Decision confirmed 2026-05-31. Earlier versions of this doc described
> only the per-tenant layer; the control plane was implicit. It is now
> explicit because EQ Cards onboards *people*, and a person is not the
> same thing as an employee of a tenant.

**Identity is global; employment is per-tenant.** A sparkie who does one
induction through EQ Cards exists in the system whether or not anyone has
hired them. In the *intended* model that person lives in a **worker pool**.
The pool tables exist today on `eq-canonical-internal` (`zaapmfdkgedqupfjtchl`)
— note that's a tenant data plane, not the control plane (see "Project roles —
AUDITED" below; pool placement is an open item):

- `workers` — the person (one row, one identity)
- `worker_credentials` — licences / tickets / cards
- `worker_inductions` — inductions completed
- `worker_assignments` — which tenants/sites they're engaged on

When a tenant engages a worker, that worker is **projected into the
tenant's canonical as a `staff` row** (`role = self`). The pool stays the
source of truth for the person; the `staff` row is the tenant's view of
their employment. One worker → N possible tenant `staff` projections, no
re-import. This is what makes EQ's promise work: capture once in Cards,
exist everywhere, no consent flow or token exchange between EQ surfaces.

**Why the pool isn't just another per-tenant table.** A worker can move
between subbies, do inductions for clients they don't work for yet, and
carry their licence wallet across engagements. Pinning identity inside a
single tenant's database would lose that — and would force a re-import
every time the same person turns up at a second EQ customer.

### Current live state (audited 2026-05-31)

Superseded framing removed. For the verified state of all three projects,
see **"Project roles — AUDITED & CORRECTED 2026-05-31"** immediately below.
Short version: the tenant registry *does* exist (`shell_control.tenants` on
the control plane `eq-canonical`), the worker-pool tables sit on
`eq-canonical-internal`'s data plane (empty), and that project's `app_data`
canonical holds *demo* tenant data — it's a tenant store, not control-plane
cruft.

### Project roles — AUDITED & CORRECTED 2026-05-31

> **This block is authoritative and supersedes any earlier role labels in
> this section.** An earlier 2026-05-31 pass had the control plane and tenant
> roles *inverted* (it called `eq-canonical-internal` the control plane). A
> live read-only audit of all three projects corrected it. The mistake came
> from the misleading name — see the NAME TRAP note below.

| Project | Ref | **Real role (audited)** | Evidence |
|---|---|---|---|
| **`eq-canonical`** | `jvknxcmbtrfnxfrwfimn` | **Control plane** — live auth, tenant routing, Cards backend. | 8 auth users · 339 minted logins · `shell_control.tenants`(4) + `tenant_routing`(2) · `custom_access_token_hook` · `eq_cards_*` RPCs · `cards_field_approvals`. |
| **`eq-canonical-internal`** | `zaapmfdkgedqupfjtchl` | **EQ-Solutions tenant data plane** (currently seeded with *demo* data). | 0 auth users · `app_data` canonical with 50 customers / 30 sites / 26 staff / 500 schedule rows · full intake engine · worker-pool tables (empty). |
| **`sks-canonical`** | `ehowgjardagevnrluult` | **SKS production tenant data plane.** | 0 auth users · `app_data` with 125 customers / 331 contacts / 50 staff / 4,808 assets / 713 test results. |

**⚠ NAME TRAP.** `eq-canonical-internal` *sounds* like the control plane but
is a tenant data store. `eq-canonical` (no suffix) is the actual control
plane. The Supabase project names can't be cheaply renamed, so the names stay
and the docs carry this warning. Don't relabel on a hunch — re-read this
table.

**Decision (2026-05-31): adopt reality.** No data moves, no auth migration,
no project rename. The system is already wired this way; we document the true
roles rather than fight them. The only way to make the *names* match the
*jobs* would be to migrate live auth + routing off `eq-canonical` — costly
and not worth it for tidiness.

**Open items flagged by the audit (not yet resolved):**
- The **worker-pool tables** physically sit on `eq-canonical-internal` (a
  tenant data plane), not on the control plane — at odds with the "identity
  is global, lives on the control plane" intent below. Where the pool *should*
  live is unsettled.
- The Cards app currently writes to `eq-canonical`'s `public.profiles` /
  `licences` (via `eq_cards_*` RPCs), **not** to the worker pool at all. The
  worker-first projection model below is intended design, not as-built.

## Why per-tenant Supabase (not one shared DB with RLS)

EQ knows everything about a customer's operations — staff, customers,
contacts, sites, induction records, SWMS, prestarts, schedules. That's
payroll-adjacent, compliance-adjacent, lawsuit-adjacent data. The
default has to be the strongest isolation Supabase offers.

| Concern                | Per-tenant Supabase           | Shared DB + RLS                     |
|------------------------|-------------------------------|-------------------------------------|
| Data isolation         | **Physical** — different DB   | Logical — one RLS bug = leak        |
| Compliance story       | "Your data, your database"    | "Trust our RLS policies"            |
| Blast radius of a bug  | One customer                  | All customers                       |
| Cost                   | $25/mo per customer (Pro tier)| Cheaper                             |
| Onboarding ops         | Per-customer project creation | Insert a `tenant_id` row            |
| Cross-tenant analytics | Impossible (intentional)      | Easy                                |

For EQ at trade-subbie scale (one customer, then a friend's business,
then a handful more), per-tenant economics work fine. When customer
count reaches 20+ and manual provisioning becomes the bottleneck, we
automate via Supabase Management API. Not before.

We're explicitly NOT a SaaS platform aggregating data across customers.
We're a conduit each customer owns end-to-end. The architecture should
reflect that.

## Bundle / deployment shape — EQ Shell + lazy-loaded modules

**Decision logged 2026-05-18 (revised from the original "Netlify per
module" sketch):** EQ ships as a single **shell app** per tenant, with
modules lazy-loaded into routes inside the shell. One URL per tenant,
one login, modules turn on/off via per-tenant env-var config.

```
                   ┌──────────────────────────────────┐
                   │  EQ Shell    (sks.eq.solutions)  │
                   │  ────────                        │
                   │  • Auth (one Supabase session)   │
                   │  • Navigation                    │
                   │  • Tenant config:                │
                   │      VITE_TENANT=sks             │
                   │      VITE_ENABLED_MODULES=       │
                   │        cards,intake,quotes,field │
                   └────┬──────┬──────┬──────┬────────┘
                        │      │      │      │
                  ┌─────┘      │      │      └─────┐
                  ▼            ▼      ▼            ▼
              [Cards]      [Intake] [Quotes]   [Service]
              lazy-loaded routes inside the shell
              each module is its own buildable React package
              (eq-platform/packages/eq-<module>/)
              the shell mounts them via React Router lazy
```

Why this over standalone-per-module:
- **One login per tenant.** SKS users sign into the shell once,
  navigate freely between modules in the same session. Standalone
  would mean re-login per module or a fragile SSO setup.
- **Scales for multi-tenant.** Tenant Y wants only Cards + Intake?
  Same shell repo, different `VITE_ENABLED_MODULES`. No N-Netlify-
  projects-per-tenant ops overhead.
- **Failure isolation kept** via lazy loading — a broken module
  doesn't block load of other modules' routes.
- **Modules stay independently developable.** Each lives in its own
  package with its own build, tests, types. The shell just imports +
  mounts them.
- **Per-tenant branding** via shell config — SKS gets dark blue +
  purple, future tenants get their own palette by env var.

For SKS today:
- Deploy ONE shell at (say) `sks.eq.solutions`
- `VITE_TENANT=sks`, `VITE_ENABLED_MODULES=intake` (then add quotes /
  field / cards as those modules come online)
- Auth via Supabase (the same Supabase project that becomes the SKS
  canonical when the master plan resumes)

For tenant Y later: clone deploy, new env vars, new Supabase. One
build artefact, N tenant deployments.

Module addition flow: build the new module as a package, export its
mountable component + route from its package barrel, register it in
the shell's module registry, done. No shell-internal changes per
module beyond a one-line registration.

## The current EQ apps + their tenancy status (as of 2026-05-18)

| App              | State                               | Supabase                     |
|------------------|-------------------------------------|------------------------------|
| EQ Field DEMO    | Active R&D, features forging ahead  | Field demo Supabase          |
| SKS Field LIVE   | Live, 50+ staff weekly              | **SKS Field LIVE Supabase**  |
| EQ Service       | Built for SKS, live within weeks    | (currently EQ-service Supabase) |
| EQ Intake        | Built for SKS, in active dev        | **No Supabase yet**          |
| EQ Quotes        | Built for SKS                       | No Supabase yet              |
| EQ Cards         | Live (pause-and-polish)             | EQ Cards Supabase            |

**The current state is fragmented** — multiple Supabase projects, no
single SKS canonical. The path forward is to consolidate.

## Current implementation status (2026-05-18; layout note 2026-09-21)

What's BUILT and working (counts decay — trust package source + `git log`):
- `@eq/schemas` — canonical JSON Schemas with `x-eq-source-aliases` for
  SimPRO/MYOB/Xero and related sources (see README schema-ownership note)
- `@eq/schemas` SQL codegen — emits `CREATE TABLE` per entity with FKs,
  RLS-enabled, indexes. Run via `pnpm --filter @eq/schemas generate:sql`.
- Migration sequencer (`pnpm db:apply` from repo root) — produces a
  single SQL file at `eq-platform/.generated/all-migrations.sql` for
  hand-off to the owning migration pipe (eq-shell), not freestyle live DDL
- **eq-shell** (separate repo) — Vite + React + Router host with Supabase
  Auth, lazy-loaded modules, per-tenant config. Removed from this tree in
  #51; do not look for `apps/eq-shell/` here.
- `@eq/intake-demo` — Intake module exposing `IntakeModule` for mount
  in the shell, plus standalone dev playground at `localhost:5174`

What's READY to wire (waiting on Royce — Option C, two-Supabase plan):
- Provision `eq-demo-canonical` Supabase project (Sydney region) — proving
  ground for the shell + commit RPC + intake flow. ~5 min.
- Provision / operate `sks-canonical` (`ehow…`) — live SKS tenant plane
  (older plan text said `sks-canonical-eq`; that name is retired).
- Drop demo credentials in `.env.local` of the **eq-shell** app for local
  dev. SKS credentials go into SKS Netlify env vars only.
- Hand generated SQL to eq-shell's tenant-migrations lineage (see
  `CLAUDE.md` / `sql/README.md`) — do not hand-apply DDL on live planes.
- Add first user via Supabase dashboard (one per project).

What I'll do once demo credentials arrive (~30-45 min):
- Wire `IntakeModule`'s commit fn to call real `eq_intake_commit_batch` RPC
- Add "commit canonical + download CSV" to the bundle flow
- Smoke-test end-to-end against `eq-demo-canonical`
- Hand to Royce for live testing on demo first, then SKS once proven

What's DEFERRED:
- Phase 3 — SKS Field LIVE migration onto canonical (after Intake/Quotes
  are stable in production use)
- Phase 4 — Cards bridge (per EQ-CARDS-INTAKE-BRIDGE.md)
- EQ Quotes module proper (currently a placeholder stub in the shell)
- EQ Service module wiring to canonical
- Microsoft Graph integration for direct SharePoint write
- Automated tenant provisioning via Supabase Management API (current is
  manual; automate when customer count grows past ~20)

## SKS-specific path (Option B — committed 2026-05-18)

After reviewing the trade-offs, the decision is **Option B — fresh SKS
canonical, migrate Field LIVE later** (NOT the "extend Field LIVE as
canonical" option, which was Royce's initial instinct but carried real
risk of breaking the live system during active dev).

### Demo-first split (Option C, committed 2026-05-18)

Layered on top of Option B: provision `eq-demo-canonical` alongside
`sks-canonical-eq` from day one. Demo is where shell + commit RPC + intake
flow get proven against real-shaped data; SKS is where Royce + the
bookkeeper run live work once demo is solid. Same migration SQL runs
against both. Local Vite always points at demo so iteration never
touches SKS.

Matches the existing pattern from global CLAUDE.md: `eq-solves-field`
(demo branch) + `sks-nsw-labour` (main) are two Netlify sites against
two backends. EQ Shell follows the same shape.

### Phase 1 — Build the canonical (next session)

1. Provision new Supabase project `sks-canonical-eq` (region: Sydney /
   ap-southeast-2). Royce creates, drops credentials in
   `eq-platform/.env.local`.
2. SQL codegen from `@eq/schemas` produces `CREATE TABLE` per entity.
3. Apply in order:
   - Per-entity canonical tables (codegen output)
   - `001_intake_spine.sql`
   - `002_intake_module_columns.sql` (adds imported_at/imported_from/
     intake_id/tenant_id to each entity)
   - `003_schema_version_columns.sql`
   - Seed `eq_schema_registry` with the JSON schemas
4. Promote demo's `customer` / `contact` / `site` schemas (currently
   in `eq-intake-demo/src/simpro-schemas.ts`) to real `@eq/schemas`
   entries with cross-field rules + source-aliases + descriptions.
5. Wire EQ Intake's commit fn to call `eq_intake_commit_batch` against
   `sks-canonical-eq` instead of console.log.
6. End-to-end test: drop a SimPRO export → canonical rows land in
   Supabase → verify via dashboard query.

### Phase 2 — Build EQ Service + EQ Quotes against the canonical

Both modules read/write SKS canonical from day one. No separate
Supabase for either.

### Phase 3 — Field LIVE cutover (after Phase 1 + 2 stable)

Planned event, not an emergency. Approximate steps:
- Map Field LIVE's existing schema to canonical schema (column rename
  + data transform plan)
- Build a one-time migration script (Field LIVE → SKS canonical)
- Stage on a Field-LIVE backup first
- Out-of-hours cutover window
- Field's frontend repointed to SKS canonical Supabase URL
- Old Field-only Supabase deprecated after a verification window

### Phase 4 — EQ Cards cutover (later, per EQ-CARDS-INTAKE-BRIDGE.md)

Path A from the bridge doc, in its current (worker-first) form: Cards
writes people into the **worker pool on the control plane**, and engaged
workers are projected into a tenant's canonical as `staff` rows. This is
NOT a straight copy of Cards `profiles` into a tenant's `staff` table —
the person lands in the global pool first. Cards runs on its own Supabase
(`hshvnjzczdytfiklhojz`) until cutover. See EQ-CARDS-INTAKE-BRIDGE.md for
the full mapping.

## What this means for future tenants

When the next customer signs up (let's call them Tenant Y):

1. Provision `tenant-y-canonical-eq` Supabase project (manual today,
   API-driven once we hit ~20 tenants)
2. Apply the same migrations (one command via the sequencer)
3. Deploy each EQ module to tenant-y subdomains (or one shared
   deployment with runtime tenant switching — TBD when relevant)
4. Set env vars per deployment to point at tenant-y's Supabase
5. Onboard tenant-y's users via Supabase Auth in that project

No code change. New Supabase + new deployments. The canonical schema
is the same, the data is theirs, the isolation is physical.

## What's NOT in scope yet

- **Microsoft Graph / direct SharePoint write-back.** The export side
  produces CSVs that paste manually for now. Real Graph integration
  happens when a customer hits that workflow weekly+.
- **Cross-module SSO.** Each module currently signs in independently
  via Supabase Auth. Single sign-on across Field / Service / Intake
  is a polish item.
- **Per-tenant branding.** Each tenant could theoretically have
  custom Sky / Deep colours per their company — out of scope until
  a customer asks for it.
- **Cross-tenant admin / billing.** No central "Royce's admin
  dashboard" listing all customers' usage. Each tenant is independent.
  When this becomes useful, it's a separate app reading metrics from
  each Supabase via service-role credentials.

## Where this doc lives in the bundle

- `EQ-AS-CONDUIT.md` — the why
- `HOW-WE-WORK-WITH-AI.md` — the working principles
- `EQ-INTAKE-ARCHITECTURE.md` — the technical shape of the intake stack
- **`EQ-TENANCY-MODEL.md`** ← this doc — the tenancy + deployment shape
- `EQ-CARDS-INTAKE-BRIDGE.md` — Cards-specific migration to canonical
- `EQ-FORMAT.md` — the bidirectional sheet wrangler

If the tenancy decisions drift from this doc, the doc wins. Update
this doc to match new decisions; don't drift silently.
