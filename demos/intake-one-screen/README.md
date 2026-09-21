# EQ Intake — one screen (prototype)

Static HTML prototype of the **"Bring something in"** redesign. The
**shipped** module is `@eq/intake-demo` (`IntakeModule`) — use that for
real flows. This folder stays as a no-build sketch of the one-screen UX.

Spec: [`INTAKE-REDESIGN-SPEC.md`](../../INTAKE-REDESIGN-SPEC.md).
One screen: drop a file → we work out what it is → pick where it goes → done.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
npx http-server demos/intake-one-screen -p 4321
# then open http://localhost:4321
```

No build, no dependencies.

## What actually works (not faked)

- **Reads the file for real** — CSV parsed in the browser.
- **Works out what it is** — scores the columns against EQ's list types and
  shows _"Looks like Plant & equipment — 39 items"_. Three honest outcomes, each
  demonstrated by a sample card:
  - **confident** — `plants.csv`
  - **close call** — asks which: `staff-list.csv` (Staff or Contacts)
  - **unsure** — asks you to pick: `site-notes.pdf`
- **Into EQ** — maps the rows to canonical shape and previews exactly what lands
  (the plant register: 39 items, 27 overdue for calibration).
- **Out to Xero / MYOB / Outlook / SharePoint** — generates a real, downloadable
  CSV shaped for that system.
- **Never drops a row** — rows that need a human eye are saved _and flagged_
  ("3 need a quick look"), never hidden.

Click the three sample cards to walk each path.

## Honest scope

This is the screen plus the real parse / detect / map logic. **Into EQ
_previews_ what would be saved** — wiring it to actually write the logged-in
tenant's canonical layer (and surface on the live `core.eq.solutions` Plant &
equipment page) is the production step, and needs a deploy. The detection and
plant mapping mirror the canonical engine (`eq-intake` `classify.ts` + the
`plant-register` source adapter).
