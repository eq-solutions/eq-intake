# Import capability vs top tools — 2026-11-05

Scope: tabular import only (Flatfile, OneSchema, CSVBox, Dromo as reference
points). Capture/OCR stays parked. Each lift records before/after and evidence.

## Lift 1 — CSV reader robustness

| Capability | Before | After | Evidence |
|---|---|---|---|
| Header row not on line 1 (title / blank rows) | Row 1 was always the header; a title row became the header and every real column was lost | Header auto-detected (modal-width heuristic, mirrors XLSX `detectHeaderRow`); rows above it returned verbatim in `meta.preamble`; `meta.headerRowIndex` reported; `headerRowIndex` override | `test/csv.test.ts` "header-row detection", fixture `test/fixtures/staff-title-rows.csv` |
| Non-UTF-8 files | Decoded as UTF-8: accented names became U+FFFD with no signal | Strict UTF-8, else Windows-1252; UTF-16 BOMs honoured; `meta.encoding` + `meta.encodingFallback` | "encoding detection", fixture `staff-cp1252.csv` (José, Müller, O’Brien, Nuñez) |
| Large files | Whole file decoded, then split into a second full line array; no limit | No second line array; `maxBytes` (100 MiB) / `maxLines` (1,000,000) reject with `CsvLimitError` — never truncate | "size caps" |

Honest limits: this is a cap, not streaming — parsed rows still live in memory.
Header detection scans the first 50 records; a single-column file or a file
with fewer than two records of the modal width keeps record 0 as the header.
Preamble assumes one title record per physical line.

Old-behaviour proof: with the previous `csv.ts` restored, 11 of the 22 tests in
`csv.test.ts` fail (all the new ones); with the fix, all pass.

Gate: `pnpm install`, `pnpm -r build`, `pnpm lint`, `pnpm -r test` green from `eq-platform/`.

## Lift 2 — Mapping memory (client side)

| Capability | Before | After | Evidence |
|---|---|---|---|
| Re-use a confirmed mapping for a same-shaped file | `computeSignatureHash` existed but nothing looked up or stored against it outside the eq-format-ui dev server's JSON files | `MappingMemory` interface + `InMemoryMappingMemory`; `lookupMapping` / `rememberMapping` keyed by tenant + entity + signature hash | `test/mapping-memory.test.ts` |
| Stale remembered mapping | n/a | A hit naming a column the file no longer has is a miss with `reason: "stale_columns"` and detail, never silently applied | same |
| Tenant isolation | n/a | Key includes `tenantId`; no cross-tenant or cross-entity hits | same |
| Durable store | none; `eq_intake_templates` absent on ehow and zaap (read-only SELECT, 2026-11-05) | Spec only: `docs/handoff-eq-intake-templates.md` for eq-shell's tenant-migrations pipe. No DDL applied, none in `sql/` | doc |

Limits: in-memory only, so nothing persists until eq-shell lands the table and
a Supabase-backed store is wired. The orchestrator does not call
`lookupMapping` yet; this lift delivers the interface and tested logic.
