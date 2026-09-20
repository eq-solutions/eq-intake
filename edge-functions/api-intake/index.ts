/**
 * api-intake — POST /api/v1/intake/:entity
 *
 * Canonical intake HTTP endpoint. Receives JSON rows from external systems
 * (third-party integrations, automation scripts, future EQ surface bridging)
 * and routes them through the same validation + commit pipeline as the
 * browser Import UI.
 *
 * This is the fourth intake surface:
 *   1. Cards  — worker-first onboarding (Cards native)
 *   2. Import — drop a CSV/XLSX in the browser (CanonicalCommitSection)
 *   3. Capture — future mobile field capture
 *   4. API    — this endpoint (programmatic push from external systems)
 *
 * ── Auth ──────────────────────────────────────────────────────────────────────
 * Bearer JWT (Supabase anon or service-role). The JWT must carry
 * `user_metadata.tenant_id`. Service-role key bypasses RLS but still requires
 * tenant_id in the request body so the correct canonical tables are targeted.
 *
 * ── Request ────────────────────────────────────────────────────────────────────
 * POST /functions/v1/api-intake
 * Content-Type: application/json
 * Authorization: Bearer <jwt>
 *
 * Body:
 * {
 *   "entity": "customer" | "site" | "contact" | "staff" | "licence",
 *   "rows": [ { ... }, ... ],           // flat JSON objects, one per record
 *   "tenant_id": "uuid",               // required when using service-role key
 *   "source": "my-integration-name",   // optional, for intake_events audit log
 *   "dry_run": false                   // optional, default false
 * }
 *
 * ── Response ────────────────────────────────────────────────────────────────────
 * 200 OK on full or partial success:
 * {
 *   "committed_count": 47,
 *   "flagged_count": 2,
 *   "rejected_count": 1,
 *   "rejected_rows": [
 *     { "source_row_index": 12, "reasons": ["name: required — fill this in"] }
 *   ],
 *   "flagged_rows": [
 *     { "source_row_index": 5, "flags": ["..."] }
 *   ],
 *   "intake_id": "uuid",               // intake_events.id for this batch
 *   "dry_run": false
 * }
 *
 * 400 Bad Request — invalid entity, missing rows, malformed JSON
 * 401 Unauthorized — missing or invalid JWT
 * 422 Unprocessable — all rows rejected (committed_count == 0)
 * 429 Too Many Requests — rate limit exceeded (50 calls/60 min per tenant)
 * 500 Internal Server Error — RPC failure
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 * Uses eq_check_intake_rate_limit / eq_increment_intake_rate_limit
 * (added in sql/029). Default: 50 calls per 60-minute window per tenant.
 *
 * ── No AI mapping ─────────────────────────────────────────────────────────────
 * API callers are expected to send rows shaped like the canonical schema.
 * Unlike the Import UI (which infers a mapping from source column names),
 * the API assumes the caller knows the schema. Unrecognised keys are ignored.
 * Missing required fields cause row-level rejections.
 *
 * Integration builders: read the schema at
 *   https://github.com/eq-solutions/eq-intake/blob/main/schemas/<entity>.schema.json
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// ── Allowed entity types ──────────────────────────────────────────────────────

const ALLOWED_ENTITIES = new Set([
  'customer',
  'site',
  'contact',
  'staff',
  'licence',
])

// ── Rate limit config ─────────────────────────────────────────────────────────

const RATE_WINDOW_MINUTES = 60
const RATE_MAX_CALLS      = 50

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed — POST only')
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError(401, 'Missing Authorization header (Bearer token required)')
  }
  const jwt = authHeader.slice(7)

  // Build an authed client to validate the JWT and read tenant_id.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false },
  })

  const { data: { user }, error: authErr } = await userClient.auth.getUser()
  if (authErr || !user) {
    return jsonError(401, 'Invalid or expired token')
  }

  // ── Tenant ID ──────────────────────────────────────────────────────────────
  // JWT tenant_id lives at user_metadata.tenant_id (confirmed in canonical
  // layer gotchas memory). Service-role callers may pass it in body instead.
  const jwtTenantId = (user.user_metadata as Record<string, unknown>)?.tenant_id as string | undefined
  let tenantId = jwtTenantId

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'Request body must be valid JSON')
  }

  // Service-role callers may pass tenant_id in the body — but only the actual
  // service-role secret earns that trust. Previously this branch fired for
  // ANY authenticated caller whose JWT simply lacked user_metadata.tenant_id
  // (e.g. a freshly signed-up user never assigned to a tenant), letting them
  // commit rows under any tenant_id of their choosing. The RPC below can't
  // catch this either — api-intake always calls it via the service-role
  // client, so eq_commit_batch's own tenant-mismatch guard sees our identity,
  // never the original caller's. (tenant-rule audit, 2026-08-05)
  const isServiceRoleCaller = jwt === SUPABASE_SERVICE_ROLE
  if (!tenantId && isServiceRoleCaller && body.tenant_id) {
    tenantId = String(body.tenant_id)
  }

  if (!tenantId) {
    return jsonError(
      400,
      isServiceRoleCaller
        ? 'tenant_id is required in the request body for service-role calls'
        : 'tenant_id is required — your account has no tenant_id set'
    )
  }

  const entity  = String(body.entity ?? '')
  const rows    = body.rows
  const source  = String(body.source ?? 'api')
  const dryRun  = body.dry_run === true

  if (!ALLOWED_ENTITIES.has(entity)) {
    return jsonError(
      400,
      `Unknown entity "${entity}". Allowed values: ${[...ALLOWED_ENTITIES].join(', ')}`
    )
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return jsonError(400, '"rows" must be a non-empty array')
  }

  if (rows.length > 10_000) {
    return jsonError(
      400,
      `Too many rows in one request (${rows.length.toLocaleString()} sent, max 10,000). ` +
      'Split into smaller batches.'
    )
  }

  // ── Rate limit check ───────────────────────────────────────────────────────
  // Use service-role for the rate limit RPCs so RLS doesn't block them.
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  })

  if (!dryRun) {
    const { data: allowed, error: rateErr } = await adminClient.rpc(
      'eq_check_intake_rate_limit',
      {
        p_tenant_id:      tenantId,
        p_window_minutes: RATE_WINDOW_MINUTES,
        p_max_calls:      RATE_MAX_CALLS,
      }
    )

    if (rateErr) {
      console.error('[api-intake] rate limit check failed:', rateErr.message)
      // Fail open — don't block the caller over a monitoring error.
    } else if (allowed === false) {
      return jsonError(
        429,
        `Rate limit exceeded: ${RATE_MAX_CALLS} calls per ${RATE_WINDOW_MINUTES} minutes. ` +
        'Wait before retrying.'
      )
    }
  }

  // ── Commit via RPC ─────────────────────────────────────────────────────────
  // eq_commit_batch is the same RPC used by the browser Import UI. API rows
  // are passed through as-is — callers are expected to pre-shape rows to
  // match the canonical schema. Unrecognised keys are ignored by the RPC.

  let commitResult: CommitBatchResult | null = null

  if (!dryRun) {
    const { data, error: rpcErr } = await adminClient.rpc('eq_commit_batch', {
      p_entity:    entity,
      p_tenant_id: tenantId,
      p_rows:      rows,
      p_source:    `api:${source}`,
    })

    if (rpcErr) {
      console.error('[api-intake] eq_commit_batch failed:', rpcErr.message)
      return jsonError(500, `Commit failed: ${rpcErr.message}`)
    }

    commitResult = Array.isArray(data) ? data[0] : data as CommitBatchResult
  } else {
    // Dry run — return what would have been committed without writing anything.
    commitResult = {
      committed_count: rows.length,
      flagged_count:   0,
      rejected_count:  0,
      flagged_rows:    [],
      rejected_rows:   [],
      intake_id:       null,
    }
  }

  // ── Record rate limit increment ────────────────────────────────────────────
  if (!dryRun) {
    await adminClient.rpc('eq_increment_intake_rate_limit', {
      p_tenant_id: tenantId,
    })
  }

  // ── Build response ─────────────────────────────────────────────────────────
  const committedCount = commitResult?.committed_count ?? 0
  const rejectedCount  = commitResult?.rejected_count  ?? 0

  // 422 if nothing committed and at least one row was submitted
  const statusCode = (committedCount === 0 && rows.length > 0) ? 422 : 200

  // Humanise rejected row reasons for API consumers — the raw RPC output
  // uses field-level error codes that make sense internally but need
  // translation for external callers.
  const humanRejected = (commitResult?.rejected_rows ?? []).map((r: RpcRejectedRow) => ({
    source_row_index: r.source_row_index,
    reasons:          (r.reasons ?? []).map(humaniseReason),
  }))

  return new Response(
    JSON.stringify({
      committed_count: committedCount,
      flagged_count:   commitResult?.flagged_count  ?? 0,
      rejected_count:  rejectedCount,
      rejected_rows:   humanRejected,
      flagged_rows:    commitResult?.flagged_rows ?? [],
      intake_id:       commitResult?.intake_id ?? null,
      dry_run:         dryRun,
    }),
    {
      status: statusCode,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    }
  )
})

// ── Types ─────────────────────────────────────────────────────────────────────

interface CommitBatchResult {
  committed_count: number
  flagged_count:   number
  rejected_count:  number
  flagged_rows:    unknown[]
  rejected_rows:   RpcRejectedRow[]
  intake_id:       string | null
}

interface RpcRejectedRow {
  source_row_index: number
  reasons:          string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    }
  )
}

/**
 * Translate internal RPC error codes into plain-English strings for API
 * consumers. The same translation runs in commit-canonical.ts for the
 * browser UI — keep them in sync if error codes change.
 */
function humaniseReason(reason: string): string {
  if (reason.includes('required_field_missing') || reason.includes('required — fill this in')) {
    return reason
  }
  if (reason.includes('fk_no_match')) {
    return reason.replace('fk_no_match', 'linked record not found')
  }
  if (reason.includes('invalid_enum')) {
    return reason.replace('invalid_enum', 'value not in allowed list')
  }
  if (reason.includes('type_error')) {
    return reason.replace('type_error', 'wrong type')
  }
  if (reason.includes('cap_exceeded')) {
    return reason
  }
  return reason
}
