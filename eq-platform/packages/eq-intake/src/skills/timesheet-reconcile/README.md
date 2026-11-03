# timesheet-reconcile

Extracts weekly timesheets from a payroll-portal PDF export and compares each line with a snapshot of what EQ Field already holds. The reconcile and the write-plan builder are pure: they read data you pass in and write nothing to Field or any database. Not exported from the package index.

## Run it

1. Build the snapshot: fill the placeholders in `scripts/timesheet-snapshot.sql` (names as printed on the PDFs, date range) and run it with a read-only role on the tenant plane. Save the one JSON result as `snapshot.json` outside the repo.
2. Reconcile:
   `INCLUDE_STATUSES="Pending Approval,Approved,Paid,Payment Authorised" tsx scripts/timesheet-reconcile-run.ts --snapshot snapshot.json --out report.json <pdf|dir>...`
   Optional env: `WEEK_ENDING=YYYY-MM-DD` limits to one week.
3. Report by who acts: `tsx scripts/timesheet-report.ts --in report.json --out report.md [--from YYYY-MM-DD]`.

Real names and hours appear only in those output files. Keep them out of the repo.

## Write plan (phase 2, pure)

`buildWritePlan(report, people, existingRows, { intakeId })` in `writeplan.ts` returns what a separate, approved writer could insert or update. It has no database access and applies nothing.

1. Existing rows: run `scripts/timesheet-existing.sql` (SELECT only, `app_data.timesheets`, every status) and save the JSON outside the repo.
2. Plan: `tsx scripts/timesheet-plan.ts --in report.json --snapshot snapshot.json --existing existing.json --out plan.json [--intake-id uuid] [--only-status "Pending Approval,Approved"]`.

Rules:
- Only job-code lines are written. TAFE, leave and NECA lines are checked, never written. A job line with no job code is skipped and listed.
- New rows get `status: "submitted"`, never `approved`.
- An existing row (matched on staff_id, date, task) is updated only while its status is `draft` or `submitted`. `approved`, `paid` and `rejected` rows are skipped and listed.
- Never delete. Field rows the PDF does not account for are listed as `fieldOnly`.
- Idempotent on the unique key (staff_id, date, task): apply the plan, re-plan the same input, and there are no inserts or updates (`isEmptyPlan`).
- A person who cannot be matched to Field goes in `blocked`; only that person's lines stop.
- A job line is not inserted beside a Field row on the same day that the PDF does not account for (another job, say); it is skipped with the reason, for a supervisor.
- Every planned row carries `importedFrom: "payroll-pdf"` and the batch `intakeId` (a uuid you pass in).

## Verdicts

| Verdict | Meaning |
|---|---|
| `match` | PDF line agrees with Field (hours within tolerance, or leave/TAFE/NECA accounted for). |
| `missing-in-app` | Field holds nothing for that day. Not listed in the report (count only). |
| `hours-differ` | Same job/code/TAFE/leave found, hours differ. |
| `conflict` | Field holds something else that day, or the line has no job note. |
| `pending-leave` | Leave request exists but is still pending. Needs an approver. |
| `unknown-pay-type` | No `payTypeRules` entry matches. |
| `app-only` | Field hours the document does not account for. |

## Who acts (report groups)

- **Supervisor**: no job note ("confirm with the supervisor", never guessed); job-code mismatches; hours differences of any size (including `app-only`).
- **Approver**: leave-type / TAFE clashes; pending leave.
- **Admin**: unknown pay types; people not in Field; Field hours with no document; documents skipped (with reason).
- **Hours summary**: person-days where PDF and Field totals differ, biggest gap first.

Each group is sorted by size of difference.

## Config (`ReconcileConfig`, defaults in `types.ts`)

| Lever | Default | Purpose |
|---|---|---|
| `payTypeRules` | base hourly = job; college/tafe/block release = roster TAFE; annual leave = annual; sick/personal = sick; rdo = rdo; neca = code `NECA` | Maps a printed pay type to a comparison. |
| `jobCodePattern` | first run of 4-6 digits in the note | Extracts the job code. |
| `hoursTolerance` | 0.01 | Job/leave/code hours must match within this. |
| `tafeTaskValues` | `["tafe"]` | Roster task / leave type values meaning TAFE. |
| `includeStatuses` | pending approval, approved, submitted | Documents reconciled. Others are listed as skipped. The runner env `INCLUDE_STATUSES` overrides. |
| `approvedLeaveStatuses` | `["approved"]` | Leave requests that are authoritative. |
| `pendingLeaveStatuses` | `["pending"]` | Raise `pending-leave`. |
| `tafeSignatures` | 7:30am-4:00pm, 30 min break | Identifies TAFE keyed as Base Hourly with no note, only if the roster shows TAFE. |
| `tafeHoursTolerance` | 1 | TAFE hours match within this (the portal records real sign-in/out). |
| `rosterMatchesCode` | `{ NECA: ["training"] }` | A roster entry that satisfies a code pay type with no timesheet row. |
| `noNoteOnTafeDay` | `"tafe"` | A job line with no job note on a roster TAFE day counts as TAFE and gets a light `flag` ("looks like a TAFE day"): a `match`, never a conflict. `"conflict"` restores the old ambiguous conflict. If the app holds real job hours that day it stays a conflict either way. |
| `leaveTypeClash` | `"pdf-wins"` | PDF and Field disagree on leave type and no approved request covers the day (e.g. PDF Annual Leave, Field roster/timesheet RDO): the line matches with an `info` note and no flag. `"flag"` raises a conflict. Roster rows are never touched or back-filled. |
| `approvedRequestWins` | `true` | An approved leave request of a different type covering the day still beats the PDF and is flagged for the approver. Set `false` to let the PDF win there too (via `leaveTypeClash`). |

## Rulings (Royce, 2026-11-03)

- TAFE matches within 1 hour. Small job-hour gaps are not tolerated and stay flagged.
- When the PDF and Field leave types disagree and no approved request covers the day, the PDF wins with no flag, only an info line in the report (`leaveTypeClash`). An approved request of a different type still wins and is flagged (`approvedRequestWins`) - that is the earlier ruling, kept for that case; confirm if the new ruling should cover it too.
- A job line with no job note on a roster TAFE day counts as TAFE with a light "looks like a TAFE day" flag (`noNoteOnTafeDay`).
- A NECA pay type matches a roster TRAINING entry when there is no timesheet row.
- Pending leave requests raise `pending-leave`.
- A line with no job note is flagged "confirm with the supervisor", never guessed.

## Open items (not decided here)

- Leave Without Pay has no pay-type rule: it shows as `unknown-pay-type`.
- Job codes are not validated against known codes.
- Status lifecycle seen: Not Opened, Pending Approval, Payment Authorised, Paid, Did Not Work. Which are reconciled is the `includeStatuses` choice.
- Field has almost no hours before about 31 Aug 2026, so earlier weeks show `missing-in-app`.
- No review UI or AI fallback by decision. There is no writer: the write plan below is a pure list, applied by nothing.
