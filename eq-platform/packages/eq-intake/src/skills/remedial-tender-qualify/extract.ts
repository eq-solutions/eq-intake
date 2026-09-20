/**
 * Extraction layer — turns a tender bundle (contract + spec + photos) into
 * one merged raw extraction record via vision.
 *
 * ============================================================================
 * CRITICAL: this module is deliberately NOT wired to a synchronous Netlify
 * function anywhere in this skill, and must never be. The sibling skill
 * `maximo-pdf-wo` was built end-to-end and then shelved for exactly this
 * reason (see EQ-INTAKE-ARCHITECTURE.md "EQ Capture"): measured vision cost
 * was $0.05-0.30/doc and latency was 28-80s/doc, against Netlify's hard
 * 26-second synchronous function cap. This pack extracts from MORE documents
 * per run (contract + spec + N photos, not one PDF) than maximo-pdf-wo did,
 * so it hits the same wall at least as badly. Whoever wires this into a real
 * HTTP endpoint MUST use a background function (the existing
 * provision-tenant-background.ts naming pattern in eq-shell gets Netlify's
 * extended background-function execution window) or client-side/edge
 * extraction the way Cards' own OCR pipeline works — never a plain
 * synchronous handler that happens to work on small test files and then
 * times out in production on a real multi-document bundle.
 * ============================================================================
 *
 * Like calibration-cert, there is deliberately no text fast-path: contracts
 * and specs are frequently scanned/image-only, and a scope photo obviously
 * has no text layer at all — so every file always routes to vision when an
 * AIProvider is supplied, and emits a `vision_unavailable` warning per file
 * when it isn't, rather than guessing from an unreliable text extraction.
 */
import type { AIProvider } from "@eq/ai";
import { TENDER_QUALIFICATION_EXTRACT_SCHEMA } from "./schema.js";
import { EMPTY_EXTRACT_RAW } from "./types.js";
import type {
  SkillFileInput,
  SkillWarning,
  SourceFileRef,
  TenderExtractRaw,
} from "./types.js";

export interface ExtractTenderBundleResult {
  merged: TenderExtractRaw;
  /** Per-field confidence (0.0-1.0) from whichever file's value was adopted. Absent key = field never populated. */
  fieldConfidence: Partial<Record<keyof TenderExtractRaw, number>>;
  sources: SourceFileRef[];
  warnings: SkillWarning[];
}

/** Files are merged contract-first, then spec, then photos, then anything unclassified — so commercial/legal fields prefer the contract's own wording over a photo caption or a spec's incidental mention. */
const KIND_PRIORITY: Record<NonNullable<SkillFileInput["kind"]> | "unclassified", number> = {
  contract: 0,
  spec: 1,
  photo: 2,
  other: 3,
  unclassified: 4,
};

/** Extract + merge a whole tender bundle via vision. Every input file is accounted for in `sources`, whether or not it yielded anything (no silent drops). */
export async function extractTenderBundle(
  files: SkillFileInput[],
  ai: AIProvider | undefined,
): Promise<ExtractTenderBundleResult> {
  const warnings: SkillWarning[] = [];
  const sources: SourceFileRef[] = [];
  const perFile: Array<{ kind: SkillFileInput["kind"]; raw: TenderExtractRaw; confidence: Record<string, number> }> = [];

  for (const file of files) {
    sources.push({
      fileName: file.fileName ?? "<unnamed>",
      sha256: null,
      sizeBytes: byteLength(file.bytes),
      kind: file.kind ?? null,
    });

    if (!ai) {
      warnings.push({
        code: "vision_unavailable",
        message: `'${file.fileName ?? "<unnamed>"}' needs vision extraction but no AIProvider was supplied. Pass opts.ai to enable it.`,
      });
      continue;
    }

    const fileBase64 = toBase64(file.bytes);
    const mediaType = guessMediaType(file.fileName);

    const extracted = await ai.extract({
      targetSchema: TENDER_QUALIFICATION_EXTRACT_SCHEMA,
      fileBase64,
      mediaType,
      documentTypeHint:
        "One document from a remedial-building tender bundle (contract, specification, or a site/scope photo). " +
        "Return null for anything not clearly evidenced — never guess a client's history or a business's own capability.",
    });

    const raw = { ...EMPTY_EXTRACT_RAW, ...(extracted.extracted as Partial<TenderExtractRaw>) };
    perFile.push({ kind: file.kind, raw, confidence: extracted.fieldConfidence ?? {} });

    for (const [field, conf] of Object.entries(extracted.fieldConfidence ?? {})) {
      if (typeof conf === "number" && conf < 0.6) {
        warnings.push({
          code: "vision_low_confidence",
          message: `'${field}' extracted at low confidence (${Math.round(conf * 100)}%) from '${file.fileName ?? "<unnamed>"}'.`,
          context: { field, confidence: conf, file_name: file.fileName },
        });
      }
    }
  }

  if (ai && perFile.length === 0 && files.length > 0) {
    warnings.push({
      code: "no_fields_extracted",
      message: "Every file failed to extract — no vision results at all.",
    });
  }

  const ordered = [...perFile].sort((a, b) => priorityOf(a.kind) - priorityOf(b.kind));
  const merged: TenderExtractRaw = { ...EMPTY_EXTRACT_RAW };
  const fieldConfidence: Partial<Record<keyof TenderExtractRaw, number>> = {};

  for (const field of Object.keys(EMPTY_EXTRACT_RAW) as Array<keyof TenderExtractRaw>) {
    for (const entry of ordered) {
      const value = entry.raw[field];
      if (value !== null && value !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[field] = value;
        const conf = entry.confidence[field];
        if (typeof conf === "number") fieldConfidence[field] = conf;
        break;
      }
    }
  }

  return { merged, fieldConfidence, sources, warnings };
}

function priorityOf(kind: SkillFileInput["kind"]): number {
  return KIND_PRIORITY[kind ?? "unclassified"];
}

function byteLength(bytes: Buffer | Uint8Array | ArrayBuffer): number {
  if (bytes instanceof ArrayBuffer) return bytes.byteLength;
  return (bytes as Uint8Array).byteLength ?? 0;
}

function toBase64(bytes: Buffer | Uint8Array | ArrayBuffer): string {
  const u8 =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes as ArrayBufferLike);
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]!);
  return btoa(binary);
}

function guessMediaType(fileName: string | undefined): string {
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}
