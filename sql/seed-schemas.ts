/**
 * Seed eq_schema_registry from the canonical schema files.
 *
 * Run from the eq-solves-intake repo root:
 *   pnpm tsx sql/seed-schemas.ts
 *
 * NOTE (2026-09-15): the above doesn't actually work today — this file
 * imports @supabase/supabase-js, but no package.json in eq-platform's
 * workspace declares it as a dependency, and eq-solves-intake has no root
 * package.json/node_modules of its own either. The SCHEMA_DIR path below is
 * correct for this file's current location; the missing-dependency problem
 * is separate and unresolved. See eq-platform/scripts/db-apply.ts for the
 * currently-wired alternative (generates SQL to paste into the Supabase SQL
 * editor rather than writing via the JS client directly).
 *
 * Reads every *.schema.json from eq-platform/packages/eq-schemas/src/schemas/,
 * then upserts into eq_schema_registry, marking the latest version of each
 * entity as is_current.
 *
 * Idempotent: re-running with the same versions is a no-op. Bumping a schema's
 * version inserts a new row and flips the old is_current to false (via trigger).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// CONFIG — env vars expected
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  process.exit(1);
}

// ============================================================================
// LOAD SCHEMAS
// ============================================================================
const SCHEMA_DIR = join(__dirname, '..', 'eq-platform', 'packages', 'eq-schemas', 'src', 'schemas');
const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));

if (files.length === 0) {
  console.error(`No schema files found in ${SCHEMA_DIR}`);
  process.exit(1);
}

console.log(`Found ${files.length} schema files`);

interface SchemaShape {
  $id: string;
  title: string;
  description: string;
  ['x-eq-entity']: string;
  ['x-eq-module']: string;
  ['x-eq-version']: string;
  [k: string]: unknown;
}

const schemas: SchemaShape[] = files.map((file) => {
  const path = join(SCHEMA_DIR, file);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (!json['x-eq-entity'] || !json['x-eq-version'] || !json['x-eq-module']) {
    throw new Error(`${file}: missing x-eq-entity, x-eq-module, or x-eq-version`);
  }
  return json;
});

// ============================================================================
// UPSERT INTO REGISTRY
// ============================================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

(async () => {
  for (const schema of schemas) {
    const entity = schema['x-eq-entity'];
    const module = schema['x-eq-module'];
    const version = schema['x-eq-version'];

    const { data: existing, error: selErr } = await supabase
      .from('eq_schema_registry')
      .select('schema_id, is_current')
      .eq('entity', entity)
      .eq('version', version)
      .maybeSingle();

    if (selErr) {
      console.error(`✗ ${entity}@${version}: select failed`, selErr);
      continue;
    }

    if (existing) {
      console.log(`· ${entity}@${version} already present (skipping)`);
      continue;
    }

    const { error: insErr } = await supabase.from('eq_schema_registry').insert({
      entity,
      module,
      version,
      schema_json: schema,
      is_current: true,                   // trigger will flip earlier versions
      description: schema.description ?? schema.title ?? null,
    });

    if (insErr) {
      console.error(`✗ ${entity}@${version}: insert failed`, insErr);
    } else {
      console.log(`✓ ${entity}@${version} inserted as current`);
    }
  }

  console.log('Done.');
})();
