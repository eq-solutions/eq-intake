# timesheet-reconcile

Read-only prototype. Extracts weekly timesheets from a payroll-portal PDF export and compares each line with a snapshot of what EQ Field already holds. It writes nothing to Field or any database, and is not exported from the package index.

## Run it

1. Build the snapshot: fill the placeholders in `scripts/timesheet-snapshot.sql` (names as printed on the PDFs, date range) and run it with a read-only role on the tenant plane. Save the one JSON result as `snapshot.json` outside the repo.
2. Reconcile:
   `INCLUDE_STATUSES="Pending Approval,Approved,Paid,Payment Authorised" tsx scripts/timesheet-reconcile-run.ts --snapshot snapshot.json --out report.json <pdf|dir>...`
   Optional env: `WEEK_ENDING=YYYY-MM-DD` limits to one week.
3. Report by who acts: `tsx scripts/timesheet-report.ts --in report.json --out report.md [--from YYYY-MM-DD]`.

Real names and hours appear only in those output files. Keep them out of the repo.

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

## Rulings (Royce, 2026-11-03)

- TAFE matches within 1 hour. Small job-hour gaps are not tolerated and stay flagged.
- When the PDF and Field leave types disagree, the approved Field request wins and the line is flagged for the approver.
- A NECA pay type matches a roster TRAINING entry when there is no timesheet row.
- Pending leave requests raise `pending-leave`.
- A line with no job note is flagged "confirm with the supervisor", never guessed.

## Open items (not decided here)

- Leave Without Pay has no pay-type rule: it shows as `unknown-pay-type`.
- Job codes are not validated against known codes.
- Status lifecycle seen: Not Opened, Pending Approval, Payment Authorised, Paid, Did Not Work. Which are reconciled is the `includeStatuses` choice.
- Field has almost no hours before about 31 Aug 2026, so earlier weeks show `missing-in-app`.
- No write path, review UI or AI fallback by decision.
