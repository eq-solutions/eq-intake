/**
 * Timesheet reconcile skill — read-only prototype.
 *
 * extract: payroll-portal PDF → ExtractedTimesheet[] (positional, unpdf)
 * reconcile: ExtractedTimesheet[] + FieldSnapshot + config → ReconcileReport
 *
 * Nothing here writes to any system. Not exported from the package index.
 */
export { extractTimesheets } from "./extract.js";
export { reconcile, normaliseName } from "./reconcile.js";
export { DEFAULT_CONFIG } from "./types.js";
export type * from "./types.js";
export { buildWritePlan, isEmptyPlan, IMPORTED_FROM } from "./writeplan.js";
export type { ExistingTimesheetRow, WritePlan, WritePlanOptions, PlannedInsert, PlannedUpdate, PlannedSkip } from "./writeplan.js";
