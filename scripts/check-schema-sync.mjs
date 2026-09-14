#!/usr/bin/env node
/**
 * scripts/check-schema-sync.mjs — fail CI if a canonical schema that exists
 * in both schemas/ (root) and eq-platform/packages/eq-schemas/src/schemas/
 * (vendored, actually imported at runtime via @eq/schemas/schemas/*.json)
 * has silently drifted apart.
 *
 * The two directories are NOT a superset/subset of each other: root carries
 * 18 intake-only entities (ACB/NSX tests, defects, maintenance checks, ...)
 * and eq-platform carries 30 entities for other apps (quoting, labour hire,
 * leave, licences, ...). This only checks the filenames present in both —
 * currently 16. Neither directory is generated from the other; both are
 * hand-authored source of truth for their own package (see the header
 * comments in scripts/gen-types.mjs and eq-platform's own
 * packages/eq-schemas/scripts/generate.ts).
 *
 * Comparison is structural (parsed JSON), not textual — JSON key order
 * differing between the two copies is not drift.
 *
 * Known, deliberately-unresolved differences are listed in
 * scripts/schema-sync-exceptions.json, each with a required reason. Every
 * active exception still prints a warning on every run so it can't go
 * silently stale — it's a documented carve-out, not a blind spot.
 *
 * Usage: node scripts/check-schema-sync.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ROOT_SCHEMAS = join(REPO_ROOT, "schemas");
const VENDORED_SCHEMAS = join(REPO_ROOT, "eq-platform", "packages", "eq-schemas", "src", "schemas");
const EXCEPTIONS_PATH = join(__dirname, "schema-sync-exceptions.json");

async function loadSchemaNames(dir) {
  const all = await readdir(dir);
  return new Set(all.filter((f) => f.endsWith(".schema.json")));
}

function getContainer(obj, dotPath) {
  const parts = dotPath.split(".");
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return { target, last };
}

function deletePath(obj, dotPath) {
  const { target, last } = getContainer(obj, dotPath);
  if (target != null) delete target[last];
}

function hasPath(obj, dotPath) {
  const { target, last } = getContainer(obj, dotPath);
  return target != null && Object.prototype.hasOwnProperty.call(target, last);
}

// Structural diff so property reordering (harmless in JSON) never counts as
// drift — only real added/removed/changed values do.
function diff(a, b, path, out) {
  if (a === b) return;
  const aIsObj = a !== null && typeof a === "object";
  const bIsObj = b !== null && typeof b === "object";
  if (!aIsObj || !bIsObj) {
    out.push(`${path || "(root)"}: ${JSON.stringify(a)}  !=  ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: type mismatch (array vs object)`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
}

async function main() {
  const [rootNames, vendoredNames, exceptionsRaw] = await Promise.all([
    loadSchemaNames(ROOT_SCHEMAS),
    loadSchemaNames(VENDORED_SCHEMAS),
    readFile(EXCEPTIONS_PATH, "utf8"),
  ]);
  const exceptions = JSON.parse(exceptionsRaw);

  const shared = [...rootNames].filter((f) => vendoredNames.has(f)).sort();

  if (shared.length === 0) {
    console.error("[schema-sync] No shared *.schema.json filenames found between " + ROOT_SCHEMAS + " and " + VENDORED_SCHEMAS);
    process.exit(1);
  }

  let failed = false;
  let activeExceptions = 0;

  for (const file of shared) {
    const rootJson = JSON.parse(await readFile(join(ROOT_SCHEMAS, file), "utf8"));
    const vendoredJson = JSON.parse(await readFile(join(VENDORED_SCHEMAS, file), "utf8"));

    const fileExceptions = exceptions[file] ?? {};
    for (const [excPath, reason] of Object.entries(fileExceptions)) {
      if (!hasPath(rootJson, excPath) && !hasPath(vendoredJson, excPath)) {
        console.error(`[schema-sync] ✗ ${file}: exception path "${excPath}" doesn't exist on either side — stale entry in schema-sync-exceptions.json, remove it`);
        failed = true;
        continue;
      }
      deletePath(rootJson, excPath);
      deletePath(vendoredJson, excPath);
      activeExceptions++;
      console.log(`[schema-sync] ⚠ ${file}: ${excPath} excepted — ${reason}`);
    }

    const diffs = [];
    diff(rootJson, vendoredJson, "", diffs);

    if (diffs.length > 0) {
      failed = true;
      console.error(`\n[schema-sync] ✗ ${file} — schemas/ and eq-platform's vendored copy disagree:`);
      for (const d of diffs) console.error(`    ${d}`);
    } else {
      console.log(`[schema-sync] ✓ ${file}`);
    }
  }

  console.log(`\n[schema-sync] Checked ${shared.length} shared schema(s), ${activeExceptions} active exception(s).`);

  if (failed) {
    console.error(
      "\n[schema-sync] FAILED — schemas/*.schema.json and " +
        "eq-platform/packages/eq-schemas/src/schemas/*.schema.json must stay in sync " +
        "for every schema name present in both. Reconcile by hand — verify against the " +
        "live system before picking a side, don't assume either copy is correct (see " +
        "git log for schemas/*.schema.json for the pattern, and the fdf0055 -> 5a75a16 " +
        "contact.schema.json saga for what happens when you don't) — or add a justified " +
        "entry to scripts/schema-sync-exceptions.json.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[schema-sync] FAILED");
  console.error(err);
  process.exit(1);
});
