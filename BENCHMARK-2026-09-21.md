# EQ Intake — industry benchmark (out of 50)

**Date:** 2026-09-21 (updated same day after L1)  
**Comparator:** a well-run mid-size TypeScript product engineering org  
(not FAANG perfection, not early-startup chaos)  
**Scope:** this repo (`eq-intake`) — packages, schemas, SQL staging, edge
functions, docs, CI. Sibling repos (eq-shell, Cards, eq-solves-service) only
count where this tree owns the contract.

**Session prompt to raise the score:**
[`prompts/06-raise-industry-benchmark.md`](prompts/06-raise-industry-benchmark.md)

---

## Scorecard

| # | Dimension | Before | After | Notes |
|---|---|---:|---:|---|
| 1 | Product / domain clarity & framing | 4.5 | **4.5** | Unchanged |
| 2 | Architecture & modularity | 3.5 | **3.5** | Dual schemas still open (L2) |
| 3 | Schema / API contract discipline | 4.0 | **4.0** | Unchanged |
| 4 | Testing culture | 3.5 | **3.5** | Coverage floor still open (L3) |
| 5 | CI/CD & quality gates | 3.0 | **4.0** | **L1:** Biome lint in `ci.yml` (`pnpm lint`) |
| 6 | Documentation & onboarding | 4.5 | **4.5** | README documents `pnpm lint` |
| 7 | Observability & operational safety | 3.5 | **3.5** | Unchanged |
| 8 | Security & secrets hygiene | 3.5 | **3.5** | Dependabot/CodeQL still open (L4) |
| 9 | Developer experience | 3.5 | **4.0** | **L1:** one-command lint; format check still ratchet |
| 10 | Continuous improvement culture | 4.5 | **4.5** | Unchanged |
| | **Total** | **38** | **39.5 / 50** | |

### Band

| Band | Meaning |
|---|---|
| 45–50 | Industry-leading for a mid-size product org |
| **38–44** | **Strong — above peer average; clear, fixable gaps** ← here (39.5) |
| 30–37 | Competent / uneven |
| &lt;30 | Needs structural remediation |

---

## L1 evidence (2026-09-21)

| Claim | Evidence |
|---|---|
| Toolchain chosen | **Biome 1.9.4** (one tool; lint gate now, format later) — `eq-platform/biome.json` |
| Local command | `pnpm lint` → `biome lint packages --diagnostic-level=error` — `eq-platform/package.json` |
| CI enforces | `.github/workflows/ci.yml` step **Lint (Biome)** before build |
| Gate is real | Census was 9 errors @ error-level; all fixed in this PR (progressbar a11y, implicit any, ZWJ regex, decorative SVGs, …). `pnpm lint` exits 0 on clean tree. |
| Scoped | `packages/**` only; ignores `dist/`, `src/generated/` |
| Style noise dialled | `noNonNullAssertion`, `useLiteralKeys`, `noExplicitAny` off for first land — ratchet later, don’t pretend we fixed 900 style nits |
| Format | Configured (spaces/2) but **not** a CI fail yet — next ratchet after lint stays green |

Score move rules applied: dim 5 +1.0 (first lint CI gate), dim 9 +0.5 (DX lint command; format not gated → not a full +1.0).

---

## Dimension detail (post-L1)

### 5. CI/CD & quality gates — 4.0
Build / typecheck / test / drift / sync / **lint**. Still missing: format
check, Dependabot/Renovate, CodeQL or audit gate, coverage threshold.

### 9. Developer experience — 4.0
`pnpm lint` documented in README. Format auto-fix available via
`pnpm lint:fix` but not required. Dual package managers + dual schemas remain.

---

## Highest-leverage lifts remaining

| Priority | Gap | Target dimension | Est. gain |
|---|---|---|---:|
| 1 | ~~ESLint/Biome as CI gate~~ **done (lint)** | 5, 9 | — |
| 1b | Biome **format** as CI ratchet | 5, 9 | +0.5 |
| 2 | One schema source of truth (or generate one tree) | 2, 3, 9 | +1.0 to +1.5 |
| 3 | Coverage thresholds on hot packages in CI | 4, 5 | +0.5 to +1.0 |
| 4 | Dependabot/Renovate + CodeQL (or npm audit gate) | 5, 8 | +0.5 to +1.0 |
| 5 | Edge-function test matrix in CI | 4, 7 | +0.5 to +1.0 |
| 6 | Wire designed audit/health to real telemetry | 7 | +0.5 |
| 7 | Thin ADR index for locked decisions | 10, 6 | +0.5 |

Path to **42–45**: L2 + L3 + L4 (or format ratchet + L3 + L4).

---

## What already beats industry average (don’t dilute)

- Conduit framing + vocabulary discipline
- “Every row in deserves a row out” as an enforceable rule
- Schema lint + codegen drift + dual-tree sync gates
- Live-plane steward hard rules after a real incident
- Session prompts that name person/moment before scope
- **Biome lint as a failing CI gate** (as of this update)

Any “raise the score” session must keep those — industry points for
tooling must not buy SaaS-theatre docs or silent-drop regressions.
