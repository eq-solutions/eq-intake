# ARMADA — pre-baked setup for eq-intake

This repo was **pre-baked** with [ARMADA](https://github.com/calumjs/ARMADA) (a fleet of Claude
Code skills by calumjs) instead of running `/armada:commission` interactively. Everything
`commission` would have produced is in place:

- `.armada/config.json` — repo-tuned config **(committed — this PR)**
- `.armada/SETUP-NOTES.md` — this file **(committed — this PR)**
- `.claude/skills/` — the fleet skills, placed **locally** in the main checkout
  (`C:\Projects\eq-intake\.claude\skills\`). They are **not** committed — kept local-only via
  `.git/info/exclude` (immediate, all worktrees) and `.gitignore` (`.claude/skills/`,
  `.claude/armada/`). This is correct: a vendored plugin doesn't belong in a production app repo.
  They're read from the local filesystem by any Claude Code session rooted at the repo root.
- `.claude/armada/scripts/` — the bundled scripts crows-nest's pipeline calls, also local-only.
- GitHub labels (`armada`, `armada:*`, `fleet-defect`) — created on `eq-solutions/eq-intake`.

> The skills/scripts live on the Beelink checkout only. If you work this repo from another machine,
> re-run the pre-bake there or install the plugin (below).

## Where to run the fleet

The vendored skills sit in the **main checkout** `.claude/`, not in an ephemeral
`*-wt` worktree. Start an ARMADA session rooted in `C:\Projects\eq-intake` so the skills resolve.

## autoMerge stays false (for now)

`autoMerge` is **`false`**. Unlike eq-service, this repo is **not** auto-deployed (no
`netlify.toml`/`vercel.json` at the root — eq-intake is the parse/emit *library*), so there's no
production-deploy rail risk. But keep `autoMerge: false` for the trial: the fleet opens and reviews
PRs but **stops at "awaiting human merge"** until you've watched one clean cycle land.

## Trial runbook (safe rollout)

Run these in a Claude Code session rooted in `C:\Projects\eq-intake`:

1. `/lighthouse` — surveys the repo and files **unarmed** issues (no trigger label, nothing builds).
2. Review the issues it files; pick one safe, self-contained one.
3. `gh issue edit <n> --add-label armada` — arms exactly that one issue.
4. Invoke `shipwright` on it — it builds in an isolated worktree and opens a PR, parked at
   "awaiting human."
5. `/muster <pr>` — runs the two-lens review and posts inline comments.
6. You review and merge by hand.

Do **not** arm `crows-nest`'s `/loop` until you've watched that single manual cycle land cleanly.

## Before you arm crows-nest's `/loop`

`crows-nest` (the autonomous scheduler) calls `${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs`
and `merge-gate.mjs`. `CLAUDE_PLUGIN_ROOT` is only set automatically by the **plugin installer** —
it is **not** set for this vendored drop-in. The manual trial cycle above needs none of these
scripts (charter / lighthouse / shipwright / muster are all path-clean), but the `/loop` does. Two
options when you get there:

- **Recommended — install the plugin** (`/plugin marketplace add calumjs/ARMADA` →
  `/plugin install armada@armada`). It supersedes this vendored copy, sets `CLAUDE_PLUGIN_ROOT`
  correctly, and gives you Calum's auto-updates + self-heal loop. Once installed you can delete the
  local `.claude/skills` / `.claude/armada` tree.
- **Or** export `CLAUDE_PLUGIN_ROOT` to the vendored dir before running the loop:
  `export CLAUDE_PLUGIN_ROOT="$(pwd)/.claude/armada"` (so its `scripts/` resolves).

## Repo-specific config choices

- **Gate = `pnpm -C eq-platform check`** (`schemas:lint && pnpm -r --if-present typecheck`).
  eq-intake has **no root `package.json`** — the workspace build lives in `eq-platform/`, so the
  fleet gate must `-C eq-platform` into it. Plain `npm run check` would fail at the repo root.
- **`test` omitted on purpose** — `pnpm -r test` is unit-level, but `test:integration` (`@eq/ai`)
  is a known-flaky integration suite; wiring tests as the gate before a clean cycle would make
  builds thrash. Add `"test": "pnpm -C eq-platform test"` once a clean cycle is observed and unit
  green is verified.
- **`run` empty** — eq-intake is a library with no dev server.
- **`armadaRepo: calumjs/ARMADA`** — self-raised fleet-defects file against Calum's repo, never this
  tracker.
- **`publicIntake.enabled: false`, `lighthouse.enabled: false`** — both opt-in; manual `/lighthouse`
  still works.
