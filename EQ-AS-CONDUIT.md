# EQ as Conduit — what we're actually building

This is the source-of-truth document for what EQ is and why it exists. Every other doc in this bundle should be readable through this lens.

Companion read: **`HOW-WE-WORK-WITH-AI.md`** — the working principles for AI sessions on this project. Both docs together are the framing layer; everything else is downstream.

---

## The problem, in plain words

Trade subbies in Australia move data around for a living and nobody talks about it. The boys on site fill out paper. The office types into whatever job-management system they've landed on, or a spreadsheet. The bookkeeper pushes things into whatever accounting platform runs payroll. The clients — data centres, hospital networks, councils, principal contractors — each have their own portal, their own induction system, their own reporting format, their own forms.

Between every layer there is a human retyping things.

The apprentice signs onto site at 6:30am. They get inducted using the principal contractor's portal — which is different from the one they used yesterday at a different site for the same client. They fill out a prestart on a paper form. Take a photo. Send it to the office WhatsApp group. Someone in the office retypes it into SimPRO. The SWMS they signed gets scanned and emailed to the client's compliance officer who uploads it into yet another portal. End of week the timesheet comes off a different paper, gets typed into payroll, gets reconciled against SimPRO job costing manually because the integration broke six months ago and nobody fixed it.

Every step of that is a place where data dies, gets duplicated, gets entered wrong, or just gets forgotten. Every step costs hours per week per person. None of it is the actual job — the actual job is electrical, mechanical, fire, hydraulic. The data movement is overhead nobody asked for.

Software vendors don't fix this because their incentive is to keep your data inside their walls. No job-management system wants to be easy to leave. No accounting platform wants to talk to your client's procurement portal. The principal contractor's induction system doesn't care that you've done the same induction 30 times this year.

So tradies absorb the cost. And the cost compounds — every new client portal, every new compliance requirement, every new layer of admin lands on the same tired bookkeeper who's already drowning.

---

## What EQ is

**EQ is the layer between the systems that don't talk to each other.**

It isn't built around any one system tradies happen to use. It's built around the fact that none of them talk to each other — and AI is what makes closing that gap cheap enough to do for every trade business, not just the ones big enough to pay for a bespoke integration. It is not a replacement for your job-management system. It is not a competitor to your accounting platform. It is not a new operating system for trade businesses. It sits between the tools tradies are already using and removes the human-retyping step.

Two doors in. A third door later when it earns its slot.

- **EQ Cards** — the gateway. The boys on site capture data once on a phone. Inductions, prestarts, SWMS, JSAs, toolbox talks, incidents, ITPs. Structured. The licence-photo OCR (mobile ML Kit on-device + Claude Vision via a Supabase Edge Function on web) lives inside Cards today; generalising it to other inputs is what becomes EQ Capture later. Standalone-useful — a sparkie can use it once for an induction, save fifteen minutes, never see another thing about EQ. The data still lands in the canonical layer in the background. Already shipping in pause-and-polish mode while the spine is built.

- **EQ Format** — the universal sheet wrangler, both directions. Cleanup-in: someone has knocked together a half-baked spreadsheet — a dog-shit tagging register, a messy SimPRO export, a client's asset list pasted from PDF — and EQ Format walks them through the gaps while the memory is fresh, then turns it into canonical records. Reshape-out: take canonical data and emit it back as a sheet shaped the way someone else wants it — Equinix's audit format, a payslip-shape for staff, a customer report. Bulk migration of large historical sheets is the same engine in batch mode. Not built yet — depends on the canonical schemas, the validation engine, and the AI mapping layer landing first. See `EQ-FORMAT.md`.

- **EQ Capture** (built, deliberately cold) — the OCR engine already runs inside Cards (mobile ML Kit + Claude Vision via a Supabase Edge Function for web). A standalone surface for forwarded supplier emails / paper across a desk / PDFs the bookkeeper drags in was built end-to-end as a Maximo PDF skill (`@eq/intake/skills/maximo-pdf-wo`) on 2026-05-21 and parked the same day. Measured cost (~$0.05–0.30 per PDF) and latency (~28–80s per PDF) don't justify the effort for the document volumes we see, and Netlify's 26-second sync function cap is a hard production blocker on top of that. Built if a recurring third-party document pain shows up that Cards can't own; not a roadmap item. Don't propose unparking without a measured latency/cost step-change or a real recurring document workflow.

One canonical layer in the middle that knows what every entity actually is — staff, sites, assets, SWMS, incidents, expenses, quotes, variations.

Every door out:
- **Into whatever job-management system you run** — its format, its fields, its API. EQ's AI does the mapping so nobody has to hand-build an integration per client.
- **Into whatever your bookkeeper uses for accounting** — timesheets, expenses, invoices, shaped the way that platform expects them.
- **Into whatever portal each client requires** — every principal contractor's compliance system is bespoke. EQ reads the shape it wants and reshapes data to fit, not the other way around.
- **Into compliance bundles** — audit packs, insurance renewal evidence, principal contractor documentation.

None of these doors are hardcoded integrations with a fixed vendor list. The point isn't "EQ talks to SimPRO." It's that EQ talks to whatever you're already using, because AI can learn a target shape instead of needing a human to hand-code it.

That's it. That's the whole product. The thing in the middle that means the apprentice's prestart photo at 6:30am ends up in the right places automatically by the time the office opens.

---

## Why we're building it

I'm a tradie who became an operations manager. I've lived this. I've watched bookkeepers cry over spreadsheets at 8pm. I've watched apprentices do the same induction four times in a week. I've watched job managers retype timesheets that had already been written down twice.

This isn't a business opportunity I spotted. It's a daily annoyance I want to remove — from my own operations first, and from similar operations as it scales.

EQ is being built because **I need it and it must be done right**. The starting point is my work at SKS (NSW). The architecture is the product — built correctly once, not incrementally justified by customer count. When it's working right for SKS, it works for the next similar operation without a rebuild.

Nobody else is building this because their financial interests are aligned with keeping the gap open. We don't have that conflict — we sit between all the systems, not inside any of them.

If it generates revenue eventually, good. That's how it sustains itself. But the reason it gets built is to remove a specific, identifiable, daily pain from real operations I run.

---

## What this means for how we build

**Every product decision answers to the pain, not to the spreadsheet.** When we're deciding whether a feature ships, the question is "does this remove a real moment of someone retyping something?" If yes, build it. If we can't describe the moment, don't build it.

**SKS (NSW) is where this lives.** Not a proving ground — the primary home. The 50+ field staff, the data centre and healthcare projects, the Equinix audits, the SimPRO exports, the bookkeeper at 8pm Friday — that's the operation EQ is being built for. When it works right here, it works for the next similar operation. The standing rules about generic placeholders and never touching SKS live data unless explicitly told to are about treating production operations with respect.

**We don't compete with anyone.** Every system a trade business already runs is good at being that system. The principal contractor's portal is what it is. EQ doesn't try to do their jobs — it just connects them so the tradies in the middle don't have to be the connection themselves.

**Free where it matters.** EQ Cards for inductions should be free. Site inductions are a daily indignity that costs the boys hours a week. There's no excuse to gate that behind a paywall. It's free because charging for it would be tone-deaf to the actual problem — not as a marketing play.

**Integration depth is the only thing that matters.** A single import is interesting. A subbie whose paper SWMS becomes a structured record that lands in their job-management system, gets exported in the principal contractor's format, gets attached to their insurance renewal pack, and gets matched to the right invoice line in their accounting platform — that's the product. That depth takes time. We build it integration by integration, real customer by real customer, real pain by real pain.

**Tradies first, software second.** The schemas, the validation engine, the AI mapping, the migrations — all of that is plumbing. The product is what an apprentice experiences at 6:30am on a Tuesday and what the bookkeeper experiences at 7pm on a Friday. Plumbing that doesn't change those two moments doesn't matter.

**Every row in deserves a row out.** EQ Intake exists to stop the human-retyping step where information falls between systems. When EQ itself silently drops rows — quietly skipping anything it can't fit — it becomes the gap it was built to close. A bookkeeper trusting an EQ output to be complete is the worst-case audience for a silent drop. If a row can't be committed, the row needs to be visible to the operator with a reason: rejected pile, "review these" view, count + cause in the log. The default assumption when working on any intake / rollup / reshape-out path is: every row in deserves a row out, even if that row is `(rejected, reason)`. Drop counters that nobody reads are not enough — the SimPRO Equinix rollup lost 72 sites this way before anyone noticed.

---

## What we're explicitly not doing

- Not building another job-management system. The world doesn't need another one — it needs the ones already out there to talk to each other.
- Not asking anyone to switch off anything they currently use.
- Not gating compliance and safety features (inductions, SWMS, prestarts) behind paywalls. People die when this stuff goes wrong; we are not going to be the reason a corner gets cut.
- Not pretending this is a unique innovation. The need is obvious to anyone who's done this work. We're just the ones building it.
- Not building for hypothetical customers. Every feature traces to a specific moment in real operations at SKS NSW. If we can't name the moment it removes from real work, the feature waits.
- Not extracting maximum value from each customer. The pricing should match the value delivered, not what the market will bear. Subbies operate on thin margins; software costs already eat into them. EQ shouldn't make that worse.

---

## The honest read on capacity and timeline

I have a full-time job. I'm building this in evenings and weekends. Emma is involved but also has her own work. There is no team yet, no funding, no urgency from anyone but me.

That means:
- Phase 1 will probably take longer than 7 weeks. That's fine.
- Some features will ship rough before they ship polished. That's fine if the rough version still removes pain.
- We say no to a lot. Better to fix one thing well than ten things badly.
- The roadmap is a guide, not a contract. Real customer pain reorders priorities. Listening matters more than hitting dates.

If this becomes something bigger eventually, that decision happens later. For now: build the thing, give it to people who need it, fix what doesn't work, repeat.

---

## How to read the rest of this bundle

Every other doc — the schemas, the Cowork brief, the validation engine spec, the marketing pages — should be readable through this frame. If anything in those docs sounds like SaaS-positioning theatre or business-school language, it's wrong and should be rewritten. The goal is always the same: remove a specific, real, named pain from a specific, real person's day.

If you're reading this in a future Cowork session and the docs have drifted from this framing, that's a signal to stop and re-anchor. The plumbing should always serve the people, not the other way around.
