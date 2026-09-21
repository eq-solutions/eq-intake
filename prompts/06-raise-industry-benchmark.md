# Raise industry benchmark — EQ Intake

**Use this prompt when:** the goal is to raise
[`BENCHMARK-2026-09-21.md`](../BENCHMARK-2026-09-21.md) from **39.5/50** toward
**45/50** (industry-leading for a mid-size TypeScript product org).

**Not for:** inventing new product doors, unparking Capture/OCR, live-plane
DDL, or rewriting the conduit frame. Product improvements belong in
`prompts/05-continue-improve-intake.md`. This prompt is **engineering-standard
lifts** that protect the conduit.

**Authored:** 2026-09-21 · baseline was 38/50; **L1 (Biome lint CI) landed → 39.5/50**.

---

## 0. Two-sentence job

You are raising EQ Intake’s engineering bar to match (then beat) a well-run
mid-size TypeScript org — without diluting the conduit mission. Ship the
highest-leverage quality-gate improvements, measure the new score honestly,
and leave the product frame untouched.

## 1. Re-anchor (out loud, before tooling)

> EQ sits between systems trade subbies already use. AI learns shapes so
> humans aren’t the glue. Engineering standards exist so that bridge doesn’t
> silently drop rows, drift schemas, or land secrets in git.

If you start talking “enterprise platform maturity” or “SOC2 theatre,” stop.
We want **gates that catch real failure modes** Royce already paid for once
(silent drops, DDL drift, schema divergence).

## 2. Read first

```
1. BENCHMARK-2026-09-21.md          ← scorecard + lift table
2. EQ-AS-CONDUIT.md
3. HOW-WE-WORK-WITH-AI.md           ← esp. rule 11 (no silent drops)
4. CLAUDE.md                       ← live-plane hard limits
5. .github/workflows/ci.yml        ← what already gates
6. scripts/check-schema-sync.mjs   ← dual-tree reality
7. prompts/05-continue-improve-intake.md  ← product work stays there
8. git log --oneline -20
```

## 3. North-star success criteria

A session succeeds only if **all** hold:

1. **Measurable score move** — you update `BENCHMARK-2026-09-21.md` (or a
   dated successor) with before/after scores and evidence paths. No vibes-only
   “we’re more mature now.”
2. **CI enforces the new bar** — if you claim a gate, it fails a PR that
   violates it (red on purpose in a proof, or a committed failing fixture
   flipped to green).
3. **No product-frame dilution** — no SaaS vocabulary, no paywalling safety,
   no silent-drop regressions.
4. **No live-plane schema freestyle** — lint/CI/tooling only; DDL still goes
   through owning lineages (`CLAUDE.md`).
5. **One primary lift fully done** — prefer finishing ESLint-in-CI over
   half-doing lint + Dependabot + coverage.

## 4. Prioritised lifts (pick with Royce)

```
Pri   Lift                                              Dims     Est. pts   Risk
────  ────────────────────────────────────────────────  ───────  ───────── ────
★★★   L1. ESLint (+ format) as CI gate                  5, 9     +1.5–2.0   ★★
         DONE 2026-09-21: Biome lint in CI (39.5/50).
         Remaining ratchet: enable format check in CI
         once `biome check` is clean (or scoped).

★★★   L2. Schema single-source plan → first cut         2, 3, 9  +1.0–1.5   ★★★
         Options (ask Royce):
           a) Root schemas/ generates into @eq/schemas
           b) @eq/schemas is sole SoT; root becomes
              generated or deleted for shared names
           c) Keep two trees but automate sync-write
              (not just sync-check)
         Ship the decision as a short ADR + the first
         mechanical step (one shared file generated).
         Full tree collapse can span sessions.

★★    L3. Coverage thresholds on hot packages           4, 5     +0.5–1.0   ★★
         Gate @eq/validation + @eq/intake first
         (coerce/parse/commit paths). Start with a
         floor near current measured %, then raise.
         No vanity 95% claim without a number.

★★    L4. Supply-chain automation                       5, 8     +0.5–1.0   ★
         Dependabot or Renovate for pnpm + Actions.
         CodeQL or `pnpm audit --prod` CI gate with
         documented allowlist. Keep pnpm.overrides.

★★    L5. Edge-function test matrix                     4, 7     +0.5–1.0   ★★
         Deno tests or contract tests for api-intake
         auth paths + at least one parser skill
         surface. Must run in CI (even if job is
         separate).

★     L6. Telemetry wiring design → stub                7        +0.5       ★★
         Don’t boil the ocean. Propose Sentry (or
         equivalent) hook points at commit failure +
         edge 5xx. Implement only if Royce picks ops
         pain this week.

★     L7. ADR index                                     6, 10    +0.5       ★
         docs/decisions/0001–0003 for Door C, dual
         schema ownership, silent-drop rule. Link
         from README. No novel philosophy.
```

### Recommended opening

1. Re-anchor §1.
2. Confirm baseline still ~38 (quick skim of CI + dual schemas).
3. Ask Royce §8 — default recommendation: **L1 then L3** (fast CI muscle)
   or **L2** if schema pain is biting this week.

## 5. Hard limits

```
✗ No live DDL / _eq_migrations hand-writes / unauthorized DML
✗ No rewriting EQ-AS-CONDUIT into SaaS language to “look mature”
✗ No claiming coverage/security wins without a CI job that can fail
✗ No adding five tools in one PR — one primary lift
✗ No force-push; no secret real client data in fixtures
✗ No unparking Capture/OCR under the guise of “engineering excellence”
✗ Don’t break pnpm frozen-lockfile CI while adding lint
```

## 6. Decision protocol

```
Proceed without asking:
  • Read-only measurement (coverage %, lint error census)
  • Adding CI jobs that are advisory (continue-on-error) for one PR
    then ratcheting — only if labelled clearly as ratchet
  • ADR stubs that document already-locked decisions
  • Dependabot config with weekly schedule

PAUSE and ask:
  • ESLint vs Biome (or any format war)
  • Which schema tree dies / becomes generated (L2)
  • Coverage floor number that would fail main today
  • Enabling CodeQL on a private repo (org permission)
  • Any change that touches shared schema files’ ownership
```

## 7. Craft bar (how to score points honestly)

**Measure before you brag.**

```bash
# Examples — adapt to what you add
pnpm -r test
pnpm --filter @eq/validation test:coverage   # if present
# After lint lands:
pnpm lint
```

**Update the scorecard in the same PR** (or a follow-up dated
`BENCHMARK-YYYY-MM-DD.md` that supersedes the old pointer in README).

Scoring rules when you amend the benchmark:

- Move a dimension by **at most +1.0** per session unless Royce agrees the
  jump is obvious (e.g. first-ever lint CI gate can be +1.0 on dim 5).
- Every +0.5 needs an evidence path (workflow file, config, failing→passing
  check).
- If you regress silent-drop or steward rules, **cap total at previous
  score** regardless of tooling wins.

**Definition of done examples**

```
L1  ci.yml runs lint; a deliberate bad file fails CI in a proof commit
    (or documented ratchet with open issue). README “Get it running”
    mentions pnpm lint. Dim 5 ≥ 4.0, Dim 9 ≥ 4.0, total ≥ 40.

L2  ADR committed; one shared schema is generated from a single SoT;
    check-schema-sync still green (or replaced by generate-and-diff).
    Dim 3 ≥ 4.5 or Dim 2 ≥ 4.0.

L3  CI fails if @eq/validation or @eq/intake coverage < agreed floor.
    Floor and current % written in BENCHMARK doc.

L4  Dependabot/Renovate PR exists or config merged; audit job in CI.
    Dim 8 ≥ 4.0.

L5  At least one edge-function test job green on main path.
    Dim 4 ≥ 4.0.
```

## 8. Asking script (first message to Royce)

> Baseline is **39.5/50** (`BENCHMARK-2026-09-21.md`) after L1 Biome lint.
> Next biggest lifts:
> **L1b** format ratchet (~+0.5),
> **L2** schema single-source first cut (~+1.5),
> **L3** coverage floors on validation/intake (~+1),
> **L4** Dependabot + audit/CodeQL (~+1),
> **L5** edge-function tests (~+1).
> I recommend L2 or L3 this session unless format pain is biting — then L1b.
> Which lift?

Wait for the pick.

## 9. Anti-patterns (instant fail)

- Adding lint config that isn’t in CI
- “We’ll add coverage later” with no floor
- Collapsing schema trees by copy-paste without a generate path
- Rewriting docs to sound more enterprise
- Scoring yourself to 45 without evidence paths
- Mixing product features from prompt 05 into this PR

## 10. Now go

```
Step 0  Re-anchor §1.
Step 1  Read §2; skim BENCHMARK scorecard.
Step 2  Ask Royce §8.
Step 3  Execute one primary lift to §7 done.
Step 4  Update scorecard (+evidence). Commit. PR states before→after total.
```

Target band for the quarter: **42–45 / 50**. Elite framing is already paid
for — earn the missing points with gates that fail when the bridge would.
