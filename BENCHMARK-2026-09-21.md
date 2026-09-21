# EQ Intake — industry benchmark (out of 50)

**Date:** 2026-09-21  
**Comparator:** a well-run mid-size TypeScript product engineering org  
(not FAANG perfection, not early-startup chaos)  
**Scope:** this repo (`eq-intake`) — packages, schemas, SQL staging, edge
functions, docs, CI. Sibling repos (eq-shell, Cards, eq-solves-service) only
count where this tree owns the contract.

**Session prompt to raise the score:**
[`prompts/06-raise-industry-benchmark.md`](prompts/06-raise-industry-benchmark.md)

---

## Scorecard

| # | Dimension | Score | Notes |
|---|---|---:|---|
| 1 | Product / domain clarity & framing | **4.5** | Conduit frame + anti-drift rules are elite; root MD sprawl is the tax |
| 2 | Architecture & modularity | **3.5** | Clean package graph; dual schemas + SQL-outside-pipe + edge fns beside packages |
| 3 | Schema / API contract discipline | **4.0** | JSON Schema → codegen + lint + drift + sync gates; hand-maintaining two trees |
| 4 | Testing culture | **3.5** | Solid Vitest + fixtures; no coverage gate; edge functions thinly tested |
| 5 | CI/CD & quality gates | **3.0** | Build/typecheck/test/drift/sync are real; no lint/format, Dependabot, CodeQL |
| 6 | Documentation & onboarding | **4.5** | Ordered reading list, `.env.example`, steward rules; historical docs crowd |
| 7 | Observability & operational safety | **3.5** | Live-plane rules, RLS smoke, audit/rate-limit SQL; prod telemetry still thin |
| 8 | Security & secrets hygiene | **3.5** | Gitignore + env template + RPC tenant guards; no automated SCA/secrets scan |
| 9 | Developer experience | **3.5** | pnpm + codegen + demos; dual package managers + no shared lint/format |
| 10 | Continuous improvement culture | **4.5** | Incident→rules→prompts is rare and excellent; formal ADR tree missing |
| | **Total** | **38 / 50** | |

### Band

| Band | Meaning |
|---|---|
| 45–50 | Industry-leading for a mid-size product org |
| **38–44** | **Strong — above peer average; clear, fixable gaps** ← here |
| 30–37 | Competent / uneven |
| &lt;30 | Needs structural remediation |

---

## Dimension detail

### 1. Product / domain clarity — 4.5
`EQ-AS-CONDUIT.md` + `HOW-WE-WORK-WITH-AI.md` + README standing rules make
“for whom and when” enforceable. Most orgs never write this down.

### 2. Architecture & modularity — 3.5
`@eq/schemas` → `@eq/validation` → `@eq/intake` / `@eq/ai` / UIs is coherent.
Drag: dual schema trees, `sql/` as staging vs apply pipe, Deno edge functions
outside the pnpm matrix.

### 3. Schema / API contract discipline — 4.0
Draft 2020-12 schemas, Ajv lint, `ci:drift`, `check-schema-sync.mjs` — serious.
Still two hand-authored sources of truth for overlapping entities.

### 4. Testing — 3.5
~63 Vitest files, messy fixtures, sample harness, gated Anthropic integration
tests. Coverage optional on validation only; edge functions largely untested
in CI.

### 5. CI/CD & quality gates — 3.0
`.github/workflows/ci.yml` does the spine work. Missing: ESLint/Biome,
Prettier/format check, Dependabot/Renovate, CodeQL or equivalent, coverage
threshold.

### 6. Documentation & onboarding — 4.5
Cold-start briefing, env template, SQL ownership, continuation prompts.
Planning archaeology at root slows new humans.

### 7. Observability & operational safety — 3.5
`CLAUDE.md` DML-only rules, RLS scripts, rate limits, audit SQL,
quality-guardian. Production error tracking / product analytics not wired as
a first-class gate in this repo.

### 8. Security & secrets hygiene — 3.5
Defensive `.gitignore` (incl. customer exports), `.env.example`, SECDEF
tenant guards, pnpm overrides. No Dependabot/CodeQL/secret-scan workflow.

### 9. Developer experience — 3.5
One-command install + codegen, Vite playgrounds. Friction: root npm + pnpm
workspace, dual schemas, no lint/format pre-commit story.

### 10. Continuous improvement culture — 4.5
Silent-drop rule, steward DDL incident → process, dry-runs, numbered prompts
(`05-continue-improve-intake`). Decisions live in product docs, not a formal
`docs/decisions/` ADR tree.

---

## Highest-leverage lifts (expected point gain)

| Priority | Gap | Target dimension | Est. gain |
|---|---|---|---:|
| 1 | ESLint (+ format) as CI gate | 5, 9 | +1.5 to +2.0 |
| 2 | One schema source of truth (or generate one tree) | 2, 3, 9 | +1.0 to +1.5 |
| 3 | Coverage thresholds on hot packages in CI | 4, 5 | +0.5 to +1.0 |
| 4 | Dependabot/Renovate + CodeQL (or npm audit gate) | 5, 8 | +0.5 to +1.0 |
| 5 | Edge-function test matrix in CI | 4, 7 | +0.5 to +1.0 |
| 6 | Wire designed audit/health to real telemetry | 7 | +0.5 |
| 7 | Thin ADR index for locked decisions | 10, 6 | +0.5 |

Hitting 1–4 cleanly moves the repo into the **42–45** band without
rewriting the product.

---

## What already beats industry average (don’t dilute)

- Conduit framing + vocabulary discipline
- “Every row in deserves a row out” as an enforceable rule
- Schema lint + codegen drift + dual-tree sync gates
- Live-plane steward hard rules after a real incident
- Session prompts that name person/moment before scope

Any “raise the score” session must keep those — industry points for
tooling must not buy SaaS-theatre docs or silent-drop regressions.
