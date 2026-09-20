# EQ Intake — Architecture (v2)

**Read `EQ-AS-CONDUIT.md` first.** That doc explains what we're building and why. This one is the technical shape.

---

## The shape

```
                 ┌───────────────────────────┐   ┌──────────────────────────────┐
                 │  EQ Cards (mobile)        │   │  EQ Format (desktop)         │
                 │  inductions, prestarts    │   │  reshape-out: SimPRO quote   │
                 │  SWMS, JSAs, toolbox      │   │  CSV -> BOM / device-reg /   │
                 │  incidents, ITPs          │   │  labour-summary              │
                 └─────────────┬─────────────┘   └──────────────┬───────────────┘
                               │                                 │
                               ▼                                 ▼
              ┌──────────────────────────────────────────────┐
              │   Canonical schema spine                     │
              │   • One canonical shape per entity           │
              │   • Validation engine                        │
              │   • Multi-tenant                             │
              │   • Audit trail per row, rollback per import │
              │   • Schema versioning                        │
              └──────┬───────────┬─────────┬─────────┬───────┘
                     │           │         │         │
        ┌────────────┘           │         │         └────────────┐
        ▼                        ▼         ▼                      ▼
   ┌─────────┐            ┌──────────┐ ┌─────────┐         ┌──────────────┐
   │ Job-mgt │            │Accounting│ │ Client  │         │  Compliance  │
   │ system  │            │ platform │ │ portals │         │  bundles     │
   │(whatever│            │(whatever │ │(whatever│         │              │
   │ you run)│            │ you run) │ │ each one│         │ Audit packs  │
   │         │            │          │ │ demands)│         │ Insurance    │
   │  AI maps│            │  AI maps │ │  AI maps│         │  evidence    │
   │  the    │            │  the     │ │  the    │         │ Principal    │
   │  shape  │            │  shape   │ │  shape  │         │  contractor  │
   └─────────┘            └──────────┘ └─────────┘         └──────────────┘
```

Two doors in today. **EQ Capture** (vision — paper, PDFs, photos, forwarded emails) was built end-to-end as a Maximo PDF skill and then deliberately parked cold on cost/latency grounds — a third door for later, not part of the shape above, until a real recurring document pain justifies it. See `EQ-AS-CONDUIT.md` and the EQ Capture section below.

**Doors in. Canonical layer in the middle. Every door out.** AI is what maps each door's shape to the canonical schema and back — no per-vendor integration hand-built for each one. That's the whole shape.

---

## Why a canonical layer

Without one: N input systems × M output systems = N×M point-to-point integrations, each one bespoke, each one breaking when one side changes.

With one: each input system has one job (turn its data into the canonical shape). Each output system has one job (turn the canonical shape into its format). N + M integrations instead of N×M. A new client portal added later means one new export profile, not a refactor.

The canonical layer is the only piece that needs to know about every kind of data flowing through. Everything else is replaceable.

---

## What lives in the spine

A small set of canonical entities — the ones that show up in every trade business regardless of which job-management system they use:

- **Staff** — employees, subbies, labour-hire, casuals, apprentices
- **Sites** — wherever work happens
- **Assets** — anything serviceable (switchboards, UPS, generators, fire pumps, AHUs, etc)
- **Schedule assignments** — staff × site × date × hours
- **SWMS** — Safe Work Method Statements
- **Prestarts** — daily site/plant checks
- **JSAs** — Job Safety Analyses
- **Toolbox talks** — recorded site briefings
- **Incidents** — injury, near-miss, hazard, environmental, property
- **ITPs** — Inspection & Test Plans

Each one defined as a JSON Schema with:
- The canonical fields and types
- Known column-name aliases from common source systems (so AI mapping has hints)
- Coercion rules (AU dates, E.164 phones, currency strings, AU states, Y/N booleans)
- Foreign-key references to other canonical entities
- Cross-field validity rules (end after start, charge >= cost, induction-required-implies-induction-url)

These ten cover the working week of every electrical, mechanical, fire, hydraulic, civil, and data subbie I've worked with. They'll get extended as real use surfaces gaps. Quotes / variations / expenses / service jobs are scaffolded for Phase 2-3 when the immediate intake/output pain is solved first.

---

## How data gets in

### EQ Cards

The mobile surface. Forms render directly from the canonical schema — same fields, same validation, same shape regardless of which client's site the apprentice is on. GPS-stamped. Signature-captured. Offline-queued.

The first wedge here is **inductions**. Every data centre, every hospital, every commercial site has its own induction system. Every subbie does the same induction with slightly different forms 30+ times a year. EQ Cards lets the boys do the induction once in EQ, then exports it in whichever format the next site demands.

After inductions: prestarts, SWMS, JSAs, toolbox talks, incidents, ITPs. All structured. All landing in the same canonical layer.

### EQ Format

The desktop surface — today, reshape-out only. Ships as `@eq/format-ui` with three profiles, all sharing one input shape (a SimPRO quote CSV): **BOM** (procurement bill of materials), **device-register** (addressable-device commissioning register), **labour-summary** (per-section labour hours). The profile registry is a hardcoded map — adding a fourth profile is a deliberate file + registry entry, not a config toggle, and that's the brake on N×M scope creep. A separate desktop path, `@eq/intake-demo`, takes a SimPRO bundle and emits five destination shapes (SharePoint rollup, Quotes-by-site, Xero/MYOB imports, Outlook contacts) without an interactive cleanup step — the drag-and-drop bulk-migration fallback.

The **cleanup-in** direction — walk someone through fixing a half-baked spreadsheet interactively, on the spot, then commit it to canonical — is aspirational, not built. "EQ Import" was retired as a separate named door; if cleanup-in ever ships, bulk/batch mode is the natural sibling to the interactive mode, not a third thing. See `EQ-FORMAT.md` for the full build-vs-vision breakdown.

### EQ Capture (built, deliberately cold — not a door today)

The vision surface. Photos of paper SWMS. PDF supplier invoices. Forwarded emails. Handwritten prestart sheets. Vision AI extracts the structured data and routes it to the right canonical entity, preserving the raw text for audit.

**Status as of 2026-05-22:** built end-to-end as the `maximo-pdf-wo` skill (`@eq/intake/skills/maximo-pdf-wo`) plus a wired eq-service integration (parked on branch `claude/wonderful-shannon-9a41a5`), then deliberately shelved. Measured cost was $0.05–0.30 per PDF and latency was 28–80 seconds per PDF on Claude Sonnet 4.5; Netlify's 26-second sync function cap was a hard production blocker on top. For the volume of third-party documents we actually see (Maximo WOs from Equinix maybe a handful of times a month), saving a few minutes of retype at that cost and wait isn't a workflow win.

The OCR engine still runs inside Cards (mobile ML Kit + Claude Vision via Supabase Edge Function). Cards owns the high-leverage intake stories. The standalone Capture surface stays cold until either vision cost/latency drops by an order of magnitude or a real recurring document pain surfaces that Cards can't own — a third door, added later, when it earns its slot.

---

## How data gets out

The mirror image. Each output target gets an export profile that knows how to translate canonical entities into the target's format.

### Job-management systems

Whatever job-management system a subbie runs. Each has its own API, its own field names, its own quirks. EQ doesn't replace these — it feeds them. AI maps canonical data onto the target's shape instead of a human hand-coding a bespoke integration per vendor. A SWMS captured on EQ Cards lands in that system with the right asset attached, the right job number, the right format it expects.

### Accounting systems

Whatever accounting platform the bookkeeper uses. Timesheets, expenses, supplier invoices flow from canonical into whatever format the accountant uses. Cost rates are sensitive — masked by default for non-admin roles.

### Client portals

This is where every subbie bleeds the most. Equinix's compliance portal wants induction records in their format. NEXTDC wants SWMS in their template. The hospital network has its own incident reporting system. The council has another one. Each principal contractor adds another.

Each one becomes an EQ Export profile. Set it up once, the data flows in the right format from then on. The deeper a customer wires their client portals into EQ, the less retyping happens, the more EQ becomes structurally important to their business.

### Compliance bundles

Audit packs, insurance renewal evidence, principal contractor documentation. Generated from the canonical layer on demand. The audit trail is real because every row knows which import it came from and which version of the schema produced it.

---

## What's underneath

### Multi-tenant isolation

Every row carries a `tenant_id`. Supabase Row Level Security enforces isolation in the database itself, not just at the application layer. JWT claim drives the policy. Cross-tenant queries are not possible by design.

### Audit and rollback

Every intake operation creates an `eq_intake_events` row. Every source row creates an `eq_intake_row_audit` entry — committed, flagged, or rejected. Every canonical row tagged with the intake_id that produced it.

If an import goes wrong, `eq_intake_rollback(intake_id)` deletes everything that import created and marks the audit rows accordingly. No partial-state cleanup, no manual SQL.

This matters because real-world imports go wrong. Bookkeepers will upload the wrong file. AI mapping will guess wrong on a low-confidence column. Without a clean rollback path, every mistake becomes a data-recovery support ticket.

### Schema versioning

Every canonical table has a `schema_version` column. Every imported row tags which version produced it. The `eq_schema_registry` is the source of truth — exactly one version per entity is `is_current = true` at any time.

Adding new fields is a backward-compatible minor bump (1.0.0 → 1.1.0). Renaming or removing fields is a major bump that requires migration scripts and a dual-write window. The `validate()` orchestrator refuses to run against a non-current schema unless explicitly opted in (historical re-validation jobs only).

### AI layer (vendor-agnostic)

Two operations: `map(input)` for column mapping, `extract(input)` for vision capture. Defined as an interface; AnthropicProvider is the only implementation in v1. The layer captures metrics on every call (tokens, latency, cost, success/failure) so we can see what AI actually costs per import once real usage hits.

If a customer eventually needs local-model inference for data residency reasons, that's a new provider implementation, not a rewrite.

### Signature-hash caching

Before invoking AI, the orchestrator hashes the columns + sample value patterns of the incoming file. If the hash matches a previously-confirmed mapping, the AI call is skipped entirely and the cached mapping applies. Routine imports of the same shape cost nothing in AI tokens after the first time.

### Validation engine

A shared TypeScript package. Schema-driven. Coerces (AU dates, Excel serials, E.164 phones, AU states, Y/N booleans, currency strings), validates (type, format, enum, pattern, range, length), resolves foreign keys (exact + fuzzy via Jaro-Winkler), evaluates cross-field rules (safe AST walker, no `eval`).

10,000 rows × 50 fields validate in under 2 seconds on a single thread. The engine is the same on every intake path — Cards, Import, Capture all run through it.

---

## What this gets us

The plumbing serves a small set of moments:

**6:30am Tuesday.** Apprentice arrives on a data centre site they've never been to. EQ Cards has their existing induction record. They tap "share with this site," it exports in the principal contractor's format, the gate gets approval in 30 seconds. They're on the tools.

**7pm Friday.** Bookkeeper opens the laptop. The week's timesheets are already structured (came in via EQ Cards from the boys' phones). They drag last week's supplier invoices folder onto EQ Capture. Five minutes later everything's in their accounting platform with the right job costing attached.

**Renewal time.** Insurance broker asks for evidence of safety procedures. EQ generates the bundle in 30 seconds — every SWMS, every toolbox talk, every incident from the last 12 months, structured, dated, signed.

**Quarterly client review.** Equinix asks for compliance evidence in their format. EQ exports it directly in the format they want. No Excel manipulation, no PDF generation, no retype.

Each of those moments is currently a long, painful, error-prone manual process. The whole architecture exists to make those moments invisible.

---

## What we explicitly haven't built

- A new job-management system. Plenty of good ones already exist.
- A new accounting platform. Same.
- A new field-services scheduling tool. Plenty of those exist.
- A new compliance management system. Same.
- A new "platform" that demands switching off anything.

We sit between these things. We don't replace any of them.

---

## What's deferred

- **Quotes / variations / service jobs / expenses** as full canonical entities (Phase 2-3). The schemas exist as stubs. Working through staff/sites/assets/SWMS first because that's where SKS bleeds the most.
- **Webhook/API intake** (Phase 4). For customers whose existing systems can push canonical-shaped data directly. Not v1 because it muddies the "three doors in" framing and isn't a near-term pain for the people we're building this for.
- **Email-in capture** (Phase 5). Forwarded supplier PDFs to a tenant-specific inbox, auto-routed. Magical but not v1.
- **Custom export profile builder** (Phase 4). Users define their own client-portal export formats with AI assistance.

The full deferred list is in `PHASE-2-3-BACKLOG.md`.

---

## Open questions

1. **Which job-management system gets the first deep integration?** Depends on what subbie conversations surface. SimPRO has the largest AU share but AroFlo has strong vertical penetration in some areas. ServiceM8 dominates the small-team end. Pick the one with the most pain we can fix first.
2. **Xero/MYOB write-back from day 1, or read-only first?** Write-back is harder; read-only gets us the audit/reporting wins faster. Probably read-only first, write-back when a real customer asks for it.
3. **R2 retention default.** 7 years matches AU records-of-work obligations. 30 years is overkill unless the customer specifically needs it. Default 7, opt-in to 30.

---

## How this compares to the rest of the docs

- **`EQ-AS-CONDUIT.md`** — the why. Read first.
- **`EQ-FORMAT.md`** — the reshape-out package. 3 profiles built; cleanup-in is aspirational.
- **`PHASE-2-3-BACKLOG.md`** — everything deferred. Treat as graveyard, not queue.
- **`PLAN-2026-05-24.md`** — current 90-day plan. What's running and what's cold.

If anything in those docs drifts from the framing in `EQ-AS-CONDUIT.md`, the framing wins. Update the doc.
