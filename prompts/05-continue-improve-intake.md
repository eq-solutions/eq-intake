# Continue: improve EQ Intake (human ↔ systems bridge)

**Use this prompt when:** starting any session whose job is to make Intake
better — Bring Data In, confirm/map/validate/commit, reconcile, tidy / To Do,
rollup/export destinations, or silent-drop hardening. Not for Cards Flutter,
eq-shell host chrome, or steward DML on live planes unless explicitly scoped.

**Authored:** 2026-09-21 · after PR #150 (onboarding + operator-copy polish).
**Voice:** Royce’s conduit frame. Read `EQ-AS-CONDUIT.md` +
`HOW-WE-WORK-WITH-AI.md` before you invent scope.

---

## 0. Two-sentence job

You are improving **EQ Intake** — the AI-shaped layer that turns the files
and lists humans already have into rows that land in EQ **or** reshape out to
the next system, without anyone retyping. Ship one accountable improvement
that a named person feels on a named day; leave Capture/OCR parked unless a
measured recurring pain forces otherwise.

## 1. Re-anchor (do this out loud before proposing work)

Play back, in plain language Royce would recognise:

> EQ sits between the systems trade subbies are forced to use. AI learns each
> system’s shape so the apprentice / bookkeeper / PM isn’t the integration.
> We don’t replace SimPRO, Xero, or the principal’s portal — we stop humans
> being the glue.

If your playback uses SaaS theatre (`moat`, `GTM`, `platform play`,
`battle-tested`, anonymous `customers`), stop and re-read the conduit doc.

**Royce is the user.** SKS NSW ops are the home. Encode workflows he already
does by hand — don’t wait for a fictional “real user” to validate the frame.

## 2. Read these FIRST (in order)

```
1. EQ-AS-CONDUIT.md
2. HOW-WE-WORK-WITH-AI.md          ← especially rule 11 (no silent drops)
3. CLAUDE.md                       ← live planes: DML-only; no DDL; no ledger hand-writes
4. README.md                       ← layout truth (packages only; shell = eq-shell repo)
5. INTAKE-REDESIGN-SPEC.md         ← one-screen principles (plain English; two questions)
6. EQ-INTAKE-ARCHITECTURE.md       ← doors in / out; what’s deliberately cold
7. git log --oneline -30           ← what’s actually running this month
```

Package map (don’t reinvent ownership):

| Package | Owns |
|---|---|
| `@eq/intake` | Parse / classify / reconcile / tidy / skills → rows |
| `@eq/validation` | Coerce + validate + FK resolve |
| `@eq/ai` | Map / extract / enrich (shape learning) |
| `@eq/confirm-ui` | Confirm-flow state machine + mapping/flag UI |
| `@eq/intake-demo` | `IntakeModule` + playground (shell mounts this) |

**Do not redo PR #150.** Docs truth-pass and operator-copy (“what’s in EQ”,
“don’t retype”) already landed. This session is behavior, accountability,
or a real operator hole — not another wording pass.

## 3. North-star success criteria (session is a miss without these)

A session counts as successful only if **all** of the following hold:

1. **Named person + moment** — you can finish the sentence:
   *“When \_\_\_ does \_\_\_ on \_\_\_, this change removes \_\_\_.”*
2. **No new silent drops** — every path you touch returns an accountable
   outcome: committed · rejected-with-reason · parked-for-review ·
   explicitly-skipped-with-surface. Counters nobody reads don’t count.
3. **One hole closed end-to-end** — tests green; operator-visible result in
   `@eq/intake-demo` or a package API the shell already mounts.
4. **Honest confidence** — no “production-ready / battle-tested / ship-ready”
   language. Prefer: *starting point; real running will reveal flaws.*
5. **Live-plane safety** — no DDL, no `_eq_migrations` hand-writes, no
   unauthorized DML on ehow/zaap. Schema needs go through eq-shell /
   eq-solves-service lineages (`CLAUDE.md`).

## 4. Open debt — prioritised (pick with Royce, don’t invent a fifth door)

Update this table from `git log` + code if reality has moved. Star ratings
are effort/risk, not vanity.

```
Pri     What                                              Unlocks for whom/when              Effort  Risk
──────  ────────────────────────────────────────────────  ───────────────────────────────── ────── ────
★★★     A. Silent-drop audit on paths you will touch      Bookkeeper trust: every row        1–3h    ★
           (validate cap, commit FK miss, tidy skips,     accounted for (72-site lesson)
            rollup orphans). Fix or prove already fixed.
            Start: eq-validation validate.ts,
            commit-canonical.ts, tidy-pass.ts (assets),
            rollup template orphan paths.

★★★     B. Tidy / Overview honesty for assets             Ops sees “assets not scanned”      2–4h    ★★
           tidy-pass currently skips assets when schema   instead of a quiet hole
           missing — surface it; don’t pretend scanned.

★★      C. Bring Data In: redesign leftovers              One-screen completeness            2–6h    ★★
           (INTAKE-REDESIGN-SPEC open items):
           • re-import = update vs add (plain prompt)
           • Other… destination (wire or remove — no
             forever “coming soon” pill)
           Prefer ONE of these, fully done.

★★      D. Reconcile sharp edges                          Import conflicts without           2–4h    ★★
           Fuzzy “use source” must never silently         duplicate sites/contacts
           insert duplicates (ReconcileModule already
           blocks bulk — verify + test + copy).

★★      E. Destination depth on a real SKS pain           Friday reshape without retype      3–8h    ★★
           Pick ONE live destination Royce actually
           uses this month (Equinix portal / SharePoint
           site register / Xero contacts). Harden
           mapping + fixtures + “row out” accounting.
           Don’t add a new destination for sport.

★       F. Dual-schema shared-file hygiene                Stops packages lying to each       1–3h    ★
           Shared names already CI-gated; if a shared     other about field shape
           file must change, change BOTH trees in one
           PR. Do not “merge the trees” in this session
           unless Royce explicitly asks.

COLD    G. Capture / Maximo PDF / vision extract          Only if a recurring document       —       ★★★★
           endpoint                                       pain is named + cost/latency
           Parked for cost/latency + Netlify 26s.         step-change is real. Default: NO.

OUT     H. Staff “Ask Claude” merge in RemediationQueue   Field-owned tables — half-wiring   —       ★★★★
           Don’t. Scope lives in Field / eq-shell.        here creates a second brain.
```

### Recommended opening move

1. Re-anchor (§1) + skim §2 docs.
2. Run a **silent-drop reconnaissance** on the surface you might touch
   (grep for early `return` / `continue` / `skip` without a reason bucket).
3. Ask Royce the §8 question — don’t pick A–E for him unless he said
   “just keep going on the highest trust risk.”

## 5. Hard limits (do NOT cross without explicit per-action OK)

```
✗ No DDL / ALTER / CREATE / DROP / RLS / GRANT on live tenant planes
✗ No hand-INSERT into app_data._eq_migrations (eq-shell runner owns the ledger)
✗ No unauthorized DML on ehow (SKS) or zaap (EQ) — SELECT-only without approval
✗ No real client names / ABNs / mobiles in fixtures — generic placeholders only
✗ No force-push; no merge-to-main without Royce OK when auto-deploy is wired
✗ No unparking Capture/OCR/Maximo skill without a named recurring pain + numbers
✗ No paywalling safety-critical flows (inductions, SWMS, prestarts, JSAs, incidents)
✗ No cross-repo schema ownership fights — one object, one lineage
✗ No “Other…” that is only a disabled pill — wire it or delete the promise
```

## 6. Decision protocol

```
Proceed without asking when:
  • Read-only investigation, tests, fixtures with placeholders
  • Fixing a proven silent-drop (reject-with-reason) on a path already in scope
  • Copy that makes accountability visible (reasons, counts) — not vibe polish
  • Dual-tree schema edit for an already-shared filename (both sides + sync CI)

PAUSE and ask when:
  • New destination / new entity / required-field or enum change
  • Anything that writes to live tenant data
  • Unparking Capture / new Edge Function / Netlify timeout-sensitive path
  • Touching Field-owned staff merge / Cards Flutter
  • “Should we delete this feature or finish it?” calls (Other…, parked skills)
  • Ambiguous re-import semantics (update vs add) before coding
```

When asking: one clear question, recommended option first, short options,
plain language. No multi-page essays.

## 7. How to work (craft bar)

**Design the accountability shape first.** Before code:

```ts
type IntakeOutcome =
  | { status: "committed"; id: string }
  | { status: "rejected"; reason: string; row: unknown }
  | { status: "parked"; reason: string; row: unknown }
  | { status: "skipped"; reason: string }; // must be visible to the operator
```

If a branch can’t produce one of these, it isn’t done.

**Prefer depth over doors.** One destination Royce trusts beats three demos
he won’t use. One silent-drop closed beats a new AI flourish.

**Technology invisible to the operator.** Detect, coerce, match — quietly.
Surfaces speak in “your list / what’s in EQ / needs a look,” never
“canonical entity / schema / RPC” in UI copy (PR #150 set that bar — keep it).

**Tests as the receipt.** Every accountability fix gets a fixture that would
have failed before (overflow rows, FK miss, orphan contact, tidy skip).
Name the test after the person-moment when you can:
`doesNotSilentlyDropFkMisses` > `handlesEdgeCase`.

**Commits.** Small, reversible, descriptive. PR body states person/moment,
what was accountable before/after, and what you deliberately left cold.

## 8. The asking script (first message to Royce after re-anchor)

> I’ve re-anchored on the conduit brief. Intake’s highest-leverage work now
> is trust and depth, not more doors:
> **A** silent-drop audit/fix on a live path,
> **B** tidy honesty for assets,
> **C** one Bring-Data-In redesign leftover (re-import or Other…),
> **D** reconcile duplicate sharp edge,
> **E** harden one destination you actually use this month.
> Capture/OCR stays cold unless you name a recurring document pain.
> Which person/moment do you want less painful next?

Then wait. Do not start a multi-hour build before he picks.

## 9. Definition of done (per pick)

```
A  Silent-drop:    For the path touched, a test proves overflow/FK-miss/orphan
                   /skip emits a reason bucket; UI or API summary shows the count.
                   No continue/return that discards a row without recording it.

B  Tidy assets:    Overview/tidy either scans assets or shows “not scanned yet”
                   with why. Zero quiet skips.

C  Redesign item:  Spec open question closed in code + test + plain-English UI.
                   No disabled “coming soon” left behind for that item.

D  Reconcile:      Fuzzy match cannot insert a duplicate via “use source”;
                   tests cover the blocked path; operator copy matches behavior.

E  Destination:    Real sample (placeholders) → mapped file Royce would paste;
                   every input row accounted in the result summary.

F  Schema hygiene: Both trees updated; check-schema-sync green; no drive-by
                   tree merge.
```

## 10. Anti-patterns (instant fail)

- Rewriting README / briefing / tenancy docs again without a behavior change
- Adding a sixth destination pill “for completeness”
- Unparking Maximo/Capture because “AI should do more OCR”
- Renaming variables to “EQ” while leaving a silent `continue`
- Hand-applying SQL on ehow/zaap “just this once”
- Scope that can’t name a person and a day
- Confidence theatre in the PR description

## 11. Now go

```
Step 0  Re-anchor out loud (§1).
Step 1  Read §2 docs; skim git log -30.
Step 2  Silent-drop recon on the candidate surface (don’t “fix” yet).
Step 3  Ask Royce §8. Stop until he picks.
Step 4  Execute one pick to §9 done. Hard limits §5. Decision protocol §6.
Step 5  Tests + PR: person/moment, before/after accountability, left cold.
```

That’s it. Don’t rebuild context, don’t open a new door for sport — pick
the pain, make every row accountable, ship the depth.
