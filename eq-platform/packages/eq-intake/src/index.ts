/**
 * @eq/intake — the standalone parser for EQ.
 *
 * Turns the shapes humans already have (CSV / XLSX / PDF / photos) into
 * rows ready for @eq/validation — AI learns each file's shape so nobody
 * retypes into the next system by hand.
 *
 * Public API:
 *   import { parseFile, parseCsv } from '@eq/intake';
 *
 *   const parsed = await parseCsv(file);
 *   // parsed.rows are Record<string, unknown>[] ready for validate()
 *
 * Readers shipped: CSV, XLSX, PDF, photo.
 * Orchestrator: parseFile() → classify → map (or signature-cache hit) → validate.
 */

export { parseCsv } from "./readers/csv.js";
export type {
  ParsedSheet,
  ParseCsvOptions,
  ParseMeta,
  CsvRow,
} from "./readers/csv.js";

export { parseXlsx } from "./readers/xlsx.js";
export type {
  ParsedWorkbook,
  ParsedXlsxSheet,
  ParseXlsxOptions,
  WorkbookMeta,
} from "./readers/xlsx.js";

export { classifySheet } from "./classify.js";
export type {
  ClassifyOptions,
  ClassifyResult,
  SchemaRegistry,
} from "./classify.js";

export { parsePdf } from "./readers/pdf.js";
export type {
  ParsedPdf,
  ParsedPdfSheet,
  ParsePdfOptions,
  PdfMeta,
} from "./readers/pdf.js";

export { parsePhoto } from "./readers/photo.js";
export type { ParsePhotoOptions } from "./readers/photo.js";

export { parseFile } from "./parse-file.js";
export type {
  ParseFileInput,
  ParseFileOptions,
  ParseFileResult,
  ParseFileMeta,
  FileFormat,
} from "./parse-file.js";

// ── Reconciliation engine ──────────────────────────────────────────────────
export { reconcileSheets, detectMatchKey } from "./reconcile.js";
export type {
  ReconcileResult,
  ReconcileRow,
  FieldConflict,
  Resolution,
} from "./reconcile.js";

export { fetchCanonicalRows, entityToTable } from "./fetch-canonical.js";
export type { CanonicalFetchClient, CanonicalEntity } from "./fetch-canonical.js";

export { archiveDuplicateRecord, isArchivableDuplicate } from "./archive-duplicate.js";
export type { ArchiveDuplicateResult } from "./archive-duplicate.js";

// ── Tidy Our Data ─────────────────────────────────────────────────────────
export { runTidyPass, commitTidyFixes, getFieldEnumValues, getFieldSuggestedValues, TIDY_ENTITY_TABLES } from "./tidy-pass.js";
export { runOrphanCheck } from "./orphan-check.js";
export type {
  TidyEntity,
  TidyFix,
  TidyFixType,
  GapItem,
  GapType,
  OrphanItem,
  OrphanType,
  ReviewFlag,
  TidyReport,
  TidyPassOpts,
  TidyCommitOpts,
  TidyCommitResult,
  OrphanCheckOpts,
  OrphanCheckResult,
} from "./tidy-types.js";

// ── Quality Guardian ───────────────────────────────────────────────────────
export { runLicenceExpiryCheck } from "./licence-expiry-check.js";
export type { LicenceExpiryAlertSummary } from "./licence-expiry-check.js";

export { readSiteAdvisory, adjudicateSiteAdvisory } from "./read-site-advisory.js";
export type {
  SiteAdvisoryItem,
  SiteAdvisorySummary,
  SiteVerdict,
  AdjudicateResult,
} from "./read-site-advisory.js";

export { readContactAdvisory, adjudicateContactAdvisory } from "./read-contact-advisory.js";
export type {
  ContactAdvisoryItem,
  ContactAdvisorySummary,
  ContactVerdict,
  ContactAdjudicateResult,
} from "./read-contact-advisory.js";

export { computeHealthScores } from "./health-score.js";
export type { HealthScore } from "./health-score.js";

export { computeComplianceMetrics } from "./compliance-metrics.js";
export type { ComplianceMetrics } from "./compliance-metrics.js";

export { FIELD_IMPORTANCE, getInspectedFields, getFlaggableFields, getFieldTier, isFieldBlank } from "./field-importance.js";
export type { FieldTier, FieldImportanceEntry, FieldImportanceOverride } from "./field-importance.js";

// ── AI data quality ────────────────────────────────────────────────────────
export {
  normaliseAbn,
  isValidAbn,
  normalisePhone,
  isValidAuPhone,
  isValidAuState,
  isValidAuPostcode,
  normaliseCompanyName,
  normalisePersonName,
} from "./normalize.js";

export { scoreRow, scoreRows } from "./confidence-score.js";
export type {
  RowConfidence,
  EntityConfidenceSummary,
} from "./confidence-score.js";

// dice/identityKeyFor/HIGH_SIM are the primitives, not just the entity-level
// detectAllDuplicates() — exported so other consumers of this package (e.g.
// eq-shell's own Contacts dedup) can reuse the same fuzzy-match algorithm
// instead of maintaining a second copy of it.
export { detectAllDuplicates, identityLabelFor, identityKeyFor, dice, HIGH_SIM, PK, matchAgainstLiveRecords } from "./duplicate-detect.js";
export type { DuplicateCluster, DuplicateReport, LiveIdentityMatch, LiveRowLookup } from "./duplicate-detect.js";

export { decayCheck } from "./decay-detect.js";
export type {
  StalenessLevel,
  StaleRecord,
  DecaySummary,
} from "./decay-detect.js";

export { makeEdgeFnCaller } from "./ai-client.js";
export type { EdgeFnCaller, EdgeFnResponse } from "./ai-client.js";

export { adjudicateDuplicateWithAI } from "./adjudicate-duplicate-ai.js";
export type { SiteAdjudicationInput, AiSiteVerdict } from "./adjudicate-duplicate-ai.js";

export { adjudicateQueueDuplicateWithAI } from "./adjudicate-queue-duplicate-ai.js";
export type {
  QueueDuplicateRecord,
  QueueDuplicateContext,
  AiQueueDuplicateVerdict,
} from "./adjudicate-queue-duplicate-ai.js";

export { adjudicateContactDuplicateWithAI } from "./adjudicate-duplicate-contact-ai.js";
export type { ContactAdjudicationInput, AiContactVerdict } from "./adjudicate-duplicate-contact-ai.js";

export { previewSiteMerge, executeSiteMerge, flagSitePairForMerge, getSiteDupeUsage } from "./merge-duplicate-sites.js";
export type {
  SiteMergeTableCount,
  SiteMergePreview,
  SiteMergeResult,
  SiteFlagPairResult,
  SiteDupeUsage,
} from "./merge-duplicate-sites.js";

export { previewContactMerge, executeContactMerge } from "./merge-duplicate-contacts.js";
export type {
  ContactMergeTableCount,
  ContactMergePreview,
  ContactMergeResult,
} from "./merge-duplicate-contacts.js";

export { suggestGaps } from "./gap-suggest.js";
export type { GapSuggestion, GapSuggestResult } from "./gap-suggest.js";

export { askCanonical, applyFilters } from "./ask-canonical.js";
export type {
  AskFilter,
  AskIntent,
  AskResult,
  FilterOp,
} from "./ask-canonical.js";

// ── Asset enrichment & deduplication ──────────────────────────────────────
export { enrichAssets } from "./enrich.js";
export type { EnrichAssetsOptions, EnrichAssetsRow } from "./enrich.js";

export { detectDuplicates, findExistingDuplicates } from "./dedup.js";
export type {
  DedupRow,
  DuplicateFinding,
  DuplicateReason,
  DupLookup,
  ExistingAssetKey,
  ExistingAssetMatch,
} from "./dedup.js";

// ── Skills (document-type extractors) ──────────────────────────────────────
export {
  parseCalibrationCerts,
  reconcileCalibrationCerts,
  matchCertToAssets,
  CALIBRATION_CERT_EXTRACT_SCHEMA,
} from "./skills/calibration-cert/index.js";
export type {
  CalibrationCertRecord,
  CalCertAssetCandidate,
  CalCertReconcileRow,
  CalCertMatch,
  CalCertMatchBasis,
  CalCertAction,
  CalCertResult,
  CanonicalAssetRef,
  ParseCalibrationCertsInput,
  ParseCalibrationCertsResult,
  CalCertFileSource,
} from "./skills/calibration-cert/index.js";
