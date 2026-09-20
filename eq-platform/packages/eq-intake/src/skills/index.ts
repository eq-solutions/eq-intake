/**
 * Skills — higher-level document-type extractors.
 *
 * A "skill" knows what a particular document looks like (e.g. an IBM Maximo
 * WO PDF, a Jemena RCD report, a SimPRO contract export) and turns it into
 * canonical-shaped insert candidates. Skills compose the lower-level readers
 * (CSV / XLSX / PDF / vision) but add document-specific structure on top.
 *
 * Generic intake (drag-any-spreadsheet, run AI mapping) lives in
 * `parseFile()`. Skills are the named, opinionated counterpart — used when
 * the source is recognised and we already know the canonical shape it
 * targets.
 */
export {
  parseMaximoPdfWo,
  groupKeyFor,
  coerceMaximoDate,
  parseAssetCell,
  parseJobPlan,
  MAXIMO_WO_EXTRACT_SCHEMA,
} from "./maximo-pdf-wo/index.js";
export type {
  CheckAssetInsert,
  CheckAssetStatus,
  IrScanResult,
  MaintenanceCheckBundle,
  MaintenanceCheckInsert,
  MaintenanceCheckStatus,
  MaximoPdfWoResult,
  MaximoWoRecord,
  ParseMaximoPdfWoInput,
  PriorityEnum,
  SkillFileInput,
  SkillFileSource,
  SkillSourceTag,
  SkillWarning,
  SkillWarningCode,
  WorkType,
} from "./maximo-pdf-wo/index.js";

export {
  parseCalibrationCerts,
  reconcileCalibrationCerts,
  extractCertsFromPdf,
  matchCertToAssets,
  mapRecordToCandidate,
  coerceCertDate,
  mapResult,
  normaliseSerial,
  CALIBRATION_CERT_EXTRACT_SCHEMA,
} from "./calibration-cert/index.js";
export type {
  CalibrationCertRecord,
  CalCertAssetCandidate,
  CalCertResult,
  CalCertSourceTag,
  CalCertMatch,
  CalCertMatchBasis,
  CalCertAction,
  CalCertReconcileRow,
  CalCertWarningCode,
  CanonicalAssetRef,
  ParseCalibrationCertsInput,
  ParseCalibrationCertsResult,
  CalCertFileSource,
} from "./calibration-cert/index.js";

export {
  assembleQualification,
  evaluateQualification,
  extractTenderBundle,
  mapExtractedToAnswers,
  buildQualificationCandidate,
  QUALIFICATION_FACTORS,
  DEFAULT_QUALIFICATION_CONFIG,
  emptyQualificationAnswers,
  TENDER_QUALIFICATION_EXTRACT_SCHEMA,
} from "./remedial-tender-qualify/index.js";
export type {
  QualificationFactor,
  FactorVerdict,
  QualificationDecision,
  FactorAnswer,
  QualificationAnswers,
  QualificationConfig,
  FactorEvaluation,
  QualificationEvaluation,
  QualificationHeader,
  SourceFileRef as TenderQualifySourceFileRef,
  AssembleQualificationInput,
  AssembleQualificationResult,
  TenderQualificationCandidate,
} from "./remedial-tender-qualify/index.js";
