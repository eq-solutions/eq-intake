/**
 * Package barrel — exposes the mountable Intake module + its supporting
 * pieces so the EQ Shell (or any other host React app) can mount Intake
 * as a lazy-loaded route.
 *
 * The demo's standalone `App.tsx` still works (run `pnpm dev` to get
 * the same playground at localhost:5174). That's for development. The
 * production deployment lives inside the shell, which imports from
 * here.
 */

// The Intake module entry-point. Mount this at /intake inside any host app.
export { IntakeModule } from "./module/IntakeModule.js";
export type { IntakeModuleProps } from "./module/IntakeModule.js";

// Mapping memory — pass IntakeModuleProps.mappingMemory to remember confirmed
// column mappings per file shape. Types re-exported so a host (EQ Shell) can
// implement the store without importing @eq/intake directly.
export type {
  MappingMemory,
  MappingMemoryKey,
  StoredMapping,
  ColumnMappingRecord,
} from "@eq/intake";

// Stage-aware commit plug-point — a host that has its own staging/review-
// queue endpoint (e.g. EQ Shell's /intake-stage) supplies this via
// IntakeModuleProps.stageCommit so the module's "Into EQ" commit routes
// flagged/conflicting rows through it instead of writing straight to the
// canonical table.
export type { StageCommitFn, StageCommitResult } from "./canonical/commit-canonical.js";

// Lower-level pieces, re-exported in case a host wants to compose its own
// arrangement (e.g. embed just the bundle flow without the tabs).
export { RollupDropZone } from "./rollup/RollupDropZone.js";
export { renderTemplate, renderToCsv } from "./rollup/template.js";
export type {
  DestinationTemplate,
  TemplateColumn,
  TemplateRenderResult,
  TemplateRenderOptions,
} from "./rollup/template.js";
export { BUILTIN_TEMPLATES, buildUserTemplate } from "./rollup/templates.js";

// Schemas — useful for host apps wiring their own classifier registry.
export { CUSTOMER_SCHEMA, CONTACT_SCHEMA, SITE_SCHEMA } from "./simpro-schemas.js";

// AI picker — host can override if they want their own provider.
export { pickAi } from "./ai-picker.js";
export type { PickedAi } from "./ai-picker.js";
