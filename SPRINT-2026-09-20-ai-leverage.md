# Sprint — Intake as a high-AI-leverage conduit
_2026-09-20. Read `EQ-AS-CONDUIT.md` first — this sprint exists to make one of its claims true in code, not just in the doc._

## The gap this closes

`EQ-AS-CONDUIT.md` and `README.md` now say EQ talks to whatever job-management
system or accounting platform you run "because AI can learn a target shape
instead of needing a human to hand-code it." Checked against live code, not
docs (Rule 0.5):

- **True for doors in.** `@eq/ai`'s `column-mapping.ts` prompt genuinely infers
  a mapping from any spreadsheet's columns to the canonical schema — confidence
  scores, FK resolution, `needs_clarification` for ambiguity. This is real AI
  leverage, already shipping.
- **False for doors out.** `@eq/format-ui` reshape-out is a hardcoded `Map` of
  three SimPRO-quote profiles (BOM, device-register, labour-summary). Its own
  doc is explicit: *"Not a generic ETL tool... adding a new input shape is a
  deliberate code change, not a config."* Every new export shape is half a
  day of hand-written code, the exact thing AI leverage was supposed to remove.
- **False suite-wide.** Per `eq-context/suite-state.md`'s Import/write-time
  tooling table, `@eq/intake`'s AI engine is real-used by exactly one surface
  (Shell's `/intake` + Equipment Certificate Import + Contacts dedup). Everyone
  else duplicated it by hand instead of consuming it: **Service** runs 4
  separate `exceljs` importers with its own Levenshtein matcher and no ABN
  validation; **Field** has a hand-rolled CSV parser, exact-match only, no
  build step; **Cards** has its own OCR pipeline (a documented swap was
  investigated and shelved — the needed Intake capability doesn't exist yet).

Three duplicated, non-AI implementations sitting next to a working AI engine
is the opposite of "AI is what makes closing that gap cheap enough to do for
every trade business." This sprint is about making the mechanism match the
message, for real operations at SKS — not a rewrite for its own sake.

**`PLAN-2026-05-24.md` is expired** (its own 90-day window ended 2026-08-22,
a month ago) and its C1/C2/C3 silent-drop bugs, canonical Supabase, commit
RPCs, and To Do redesign all appear shipped per recent commits and memory —
but a full reconciliation is its own job, out of scope here. Flagged as a
separate task below rather than done inline.

---

## Objective 1 — Reshape-out gets an AI-mapped path

**Named moment:** a new client portal shows up — NEXTDC, a new principal
contractor, whatever's next after Equinix — and today that means Royce (or
whoever's building it) hand-writes a new file under
`eq-platform/packages/eq-format-ui/src/derive/profiles/` and a registry
entry. Every one of those is a human doing the job AI is supposed to do.

**What changes:** reshape-out gains an AI-driven path that takes a target
shape (a sample export, a column list, a short description) and produces the
mapping the way `column-mapping.ts` already does for doors in — instead of a
human writing profile code per vendor. The hardcoded 3-profile registry
doesn't need to disappear day one; the new path sits alongside it and takes
over for the *next* profile instead of another hand-coded file.

**Validation:** can the next real export shape (Equinix → SimPRO, still the
named candidate per the old plan) go through the AI-mapped path instead of a
new hardcoded profile file, and match what a hand-written profile would have
produced?

---

## Objective 2 — One real consumer gets off its hand-rolled parser

**Named moment:** Service's bookkeeper-facing import is running 4 separate
`exceljs` importers with a bespoke Levenshtein matcher and no ABN validation
— meaning Service re-solves, worse, a problem `@eq/intake` already solved
once. This is the highest-value migration candidate: most duplicated effort,
most exposed to the row-quality bugs `@eq/intake` already fixed (FK
resolution, silent-drop prevention).

**What changes:** migrate Service's importers onto `@eq/intake`, per the
migration Service's own team already proposed in
`docs/architecture/2026-05-19-shell-intake-integration.md` (referenced in
`suite-state.md`, never executed). This sprint doesn't own that repo — it
produces the readiness on the `@eq/intake` side (packaging, API surface a
non-Shell consumer can actually call) and coordinates the swap.

**Validation:** does a real Service import run through `@eq/intake` and
produce equal-or-better row-level results (ABN validation, FK match rate,
zero silent drops) than the 4 existing `exceljs` importers?

---

## Objective 3 — Retire or reconcile the stale plan

Not a build objective — a hygiene one. `PLAN-2026-05-24.md` is 4 months past
its own window and README still points to it as "Current 90-day plan."
Verify what's actually done (git log + memory suggest: C1/C2/C3, canonical
Supabase, commit RPCs, To Do live-refresh, tender qualification are all
shipped) and either close it out with a changelog entry or fold the residue
into this sprint. **Spun out as a background task rather than done here** —
it's a real gap but not an AI-leverage question.

---

## Risks

- **R1 — AI-mapped reshape-out drifts into "the universal sheet wrangler"
  scope creep** that `EQ-FORMAT.md` deliberately killed once already ("not a
  generic ETL tool" was a considered retreat, not an oversight). Guard: the
  new path targets one new profile at a time, same as the hardcoded one did —
  it changes *who* writes the mapping (AI, not a human), not the scope of
  what's mapped.
- **R2 — Service migration becomes a cross-repo scope fight.** Service
  proposed this migration on its own doc over 4 months ago and it never
  happened — that's a signal something blocked it (ownership, API shape,
  priority) that a fresh attempt needs to surface early, not discover at
  week 3.
- **R3 — irreversible:** none. Both objectives are additive (new path beside
  the existing registry; migration is a swap behind Service's existing
  import UI). No schema, auth, or production-data changes implied.

---

## What's explicitly NOT in this sprint

- Cards' OCR pipeline / EQ Capture — deliberately parked per
  `EQ-AS-CONDUIT.md`, not reopened by this sprint.
- Field's CSV parser — real gap, but Field has no build step to consume an
  npm package today; that's an infra precondition, not this sprint's job.
- The cleanup-in / "universal sheet wrangler" vision in `EQ-FORMAT.md` —
  still aspirational, still waiting on a real recurring outside-SKS moment.
- Rewriting the 3 existing hardcoded profiles to be AI-driven retroactively —
  they work; only the *next* one needs to prove the new path.
