#!/usr/bin/env node
/**
 * scripts/audit-live-functions.mjs — generate the query that answers
 * "does this function/table actually exist on a real tenant plane", instead
 * of re-deriving it by hand.
 *
 * Why this exists: 2026-09-19, one session hit three separate cases of a
 * function this repo's sql/*.sql claims to define not actually existing on
 * ehow or zaap (eq_create_intake_event/eq_finish_intake_event — dropped
 * fleet-wide 2026-05-24, fixed in PR #142/#143; the eq_intake_rollback
 * family — orphaned on jvkn only; eq_intake_find_template_by_signature and
 * its table — never shipped anywhere). Each one took a hand-written
 * pg_proc query to confirm. This repo's own CLAUDE.md Rule 2 already says
 * the sql/ folder is "staging... NOT self-serve applyable to live planes" —
 * this script makes that fact checkable in one command instead of trusting
 * it as a warning label nobody re-verifies.
 *
 * This does NOT connect to a database itself — eq-solves-intake has no
 * established credential story for reaching every tenant's own dedicated
 * Supabase project (each tenant's service-role key lives encrypted in
 * jvkn's shell_control.tenant_routing, deliberately not casually readable).
 * Wiring that up is a real decision (new secrets, which projects, CI or
 * on-demand) that deserves its own explicit go, not something to improvise
 * here. What this script CAN do safely: extract every claimed name from
 * sql/*.sql (pure local file read) and print one ready-to-run query per
 * target project — paste it into the Supabase MCP's execute_sql, the
 * dashboard's SQL editor, or `supabase db execute`.
 *
 * Usage:
 *   node scripts/audit-live-functions.mjs                 # known tenant planes (ehow, zaap)
 *   node scripts/audit-live-functions.mjs <project_ref>    # any other project (e.g. a new tenant)
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, "..", "sql");

// The two tenant planes this repo's own CLAUDE.md documents as live —
// "ehow (ehowgjardagevnrluult, SKS) or zaap (zaapmfdkgedqupfjtchl, EQ)".
// A self-provisioned tenant (e.g. madagins) has its own project, found via
// jvkn's shell_control.tenants/tenant_routing, not enumerable from here —
// pass its ref as a CLI arg to check it too.
const KNOWN_TENANT_PLANES = [
  { name: "ehow (SKS)", ref: "ehowgjardagevnrluult" },
  { name: "zaap (EQ)", ref: "zaapmfdkgedqupfjtchl" },
];

const FUNCTION_RE = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
// Captures an optional schema (group 1) and the table name (group 2). Most
// sql/*.sql CREATE TABLEs carry no schema prefix at all — they rely on each
// migration's own `set search_path = app_data, shell_control, ...`, so the
// prefix isn't in the text to capture. Verified live 2026-09-19 (migration
// 014's own comment + reading 001_intake_spine.sql directly): these five are
// actually shell_control.*, not app_data.* — everything else unqualified
// really is app_data.*. Don't extend this list by guessing; check the
// source file's own search_path / a migration's explicit comment first —
// guessing schema wrong here means the audit reports a false "missing".
const KNOWN_SHELL_CONTROL_TABLES = new Set([
  "eq_intake_templates", "eq_intake_events", "eq_intake_row_audit",
  "eq_export_events", "eq_export_profiles",
]);
const TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;

async function extractClaimed() {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql"));
  const functions = new Set();
  const tables = new Map(); // "schema.name" -> {schema, name}
  for (const file of files) {
    const text = await readFile(join(SQL_DIR, file), "utf8");
    for (const match of text.matchAll(FUNCTION_RE)) functions.add(match[1]);
    for (const match of text.matchAll(TABLE_RE)) {
      const name = match[2];
      const schema = match[1] ?? (KNOWN_SHELL_CONTROL_TABLES.has(name) ? "shell_control" : "app_data");
      tables.set(`${schema}.${name}`, { schema, name });
    }
  }
  return {
    functions: [...functions].sort(),
    tables: [...tables.values()].sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)),
  };
}

function buildQuery(functions, tables) {
  const fnValues = functions.map((n) => `  ('${n}')`).join(",\n");
  const tblValues = tables.map((t) => `  ('${t.schema}', '${t.name}')`).join(",\n");
  return `-- Paste into Supabase MCP execute_sql (or the dashboard SQL editor) for the target project.
with claimed_fn(name) as (values
${fnValues}
),
claimed_tbl(schema, name) as (values
${tblValues}
)
select 'function' as kind, c.name, null as schema, (p.proname is not null) as exists_live
from claimed_fn c
left join pg_proc p on p.proname = c.name
union all
select 'table' as kind, t.name, t.schema, (to_regclass(t.schema || '.' || t.name) is not null) as exists_live
from claimed_tbl t
order by exists_live, kind, name;`;
}

async function main() {
  const extraRefs = process.argv.slice(2).map((ref) => ({ name: ref, ref }));
  const targets = extraRefs.length > 0 ? extraRefs : KNOWN_TENANT_PLANES;

  const { functions, tables } = await extractClaimed();
  console.log(
    `[audit-live-functions] ${functions.length} function name(s) + ${tables.length} table name(s) claimed across sql/*.sql\n`,
  );

  const query = buildQuery(functions, tables);

  for (const t of targets) {
    console.log(`\n${"=".repeat(70)}\n${t.name} — project_id: ${t.ref}\n${"=".repeat(70)}`);
    console.log(query);
  }

  console.log(
    `\n[audit-live-functions] ${targets.length} target project(s) above (functions + tables). ` +
      `Run each query, then update eq-context memory / this repo's own docs ` +
      `if anything claimed here isn't actually live — don't let the next ` +
      `session rediscover it by hand.`,
  );
}

main().catch((err) => {
  console.error("[audit-live-functions] FAILED");
  console.error(err);
  process.exit(1);
});
