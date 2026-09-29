import { createClient } from 'npm:@supabase/supabase-js@2'

// eq-canonical-internal — Cards worker pool
const CARDS_URL           = Deno.env.get('CARDS_SUPABASE_URL')!
const CARDS_SERVICE_ROLE  = Deno.env.get('CARDS_SERVICE_ROLE_KEY')!

// This employer's canonical Supabase (auto-provided by Supabase runtime)
const EMPLOYER_URL         = Deno.env.get('SUPABASE_URL')!
const EMPLOYER_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EMPLOYER_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Verify the caller is an authenticated employer user.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  const employerUserClient = createClient(EMPLOYER_URL, EMPLOYER_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await employerUserClient.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const appMeta = user.app_metadata as { tenant_id?: string } | undefined
  const tenantId = appMeta?.tenant_id
  if (!tenantId) return new Response('tenant_id missing from app_metadata', { status: 400 })

  // Parse request body.
  let body: { assignment_id?: string }
  try { body = await req.json() } catch { return new Response('Invalid JSON', { status: 400 }) }

  const { assignment_id } = body
  if (!assignment_id) return new Response('assignment_id required', { status: 400 })

  const cardsAdmin = createClient(CARDS_URL, CARDS_SERVICE_ROLE)

  // ── Step 1a: fetch + verify tenant ownership BEFORE any state change ─────
  // Approve-then-check is a TOCTOU: the approval fires before we confirm the
  // assignment belongs to this caller. Fetch first, verify, then approve.
  const { data: pendingAssignment, error: fetchError } = await cardsAdmin
    .from('worker_assignments')
    .select('tenant_id, worker_id')
    .eq('id', assignment_id)
    .single()

  if (fetchError || !pendingAssignment) {
    return Response.json({ error: 'assignment not found' }, { status: 404 })
  }

  if (pendingAssignment.tenant_id !== tenantId) {
    return new Response('assignment does not belong to this tenant', { status: 403 })
  }

  // ── Step 1b: approve (tenant ownership confirmed above) ──────────────────
  const { error: approveError } = await cardsAdmin
    .rpc('approve_worker_assignment', { p_assignment_id: assignment_id })

  if (approveError) {
    return Response.json({ error: approveError.message }, { status: 422 })
  }

  // ── Step 2: fetch worker data from the Cards pool ────────────────────────
  const [workerRes, credentialsRes, inductionsRes] = await Promise.all([
    cardsAdmin.from('workers').select('*').eq('id', pendingAssignment.worker_id).single(),
    cardsAdmin.from('worker_credentials').select('*').eq('worker_id', pendingAssignment.worker_id).eq('status', 'active'),
    cardsAdmin.from('worker_inductions').select('*').eq('worker_id', pendingAssignment.worker_id).eq('tenant_id', tenantId),
  ])

  if (workerRes.error || !workerRes.data) {
    return Response.json({ error: 'worker not found' }, { status: 500 })
  }

  const worker      = workerRes.data
  const credentials = credentialsRes.data ?? []
  const inductions  = inductionsRes.data ?? []

  // ── Step 3: upsert into employer canonical ───────────────────────────────
  // app_data is in the exposed-schemas list — use .schema('app_data') to
  // switch PostgREST away from the default public schema.
  // x-eq-source lets app_data.fn_audit (eq-shell migration 0364) attribute these
  // writes to intake rather than 'system'.
  const employerAdmin = createClient(EMPLOYER_URL, EMPLOYER_SERVICE_ROLE, {
    global: { headers: { 'x-eq-source': 'intake' } },
  })
  const appData = employerAdmin.schema('app_data')
  const now = new Date().toISOString()

  // onConflict('cards_worker_id') below relies on a unique constraint that is
  // NOT tenant-scoped (sql/shell/003_staff_cards_sync_fields.sql — unique on
  // cards_worker_id alone). Safe today only because each employer runs its
  // own physically-isolated canonical database (EMPLOYER_URL, above), so no
  // other tenant's row can exist here to collide with. Guard explicitly
  // anyway rather than depend on that holding forever — an upsert scoped
  // only by cards_worker_id would otherwise silently reassign an existing
  // tenant's staff row the moment this table is ever shared. (tenant-rule
  // audit, 2026-08-05)
  const { data: conflictingStaff } = await appData
    .from('staff')
    .select('staff_id, tenant_id')
    .eq('cards_worker_id', worker.id)
    .maybeSingle()

  if (conflictingStaff && conflictingStaff.tenant_id !== tenantId) {
    return Response.json(
      { error: 'cards_worker_id already claimed by a different tenant in this canonical' },
      { status: 409 },
    )
  }

  const { data: staff, error: staffError } = await appData
    .from('staff')
    .upsert(
      {
        cards_worker_id: worker.id,
        tenant_id:       tenantId,
        first_name:      worker.first_name,
        last_name:       worker.last_name,
        preferred_name:  worker.preferred_name ?? null,
        email:           worker.email,
        phone:           worker.phone,
        employment_type: 'labour_hire',
        active:          true,
        imported_from:   'eq-cards',
        imported_at:     now,
      },
      { onConflict: 'cards_worker_id' },
    )
    .select('staff_id')
    .single()

  if (staffError || !staff) {
    return Response.json({ error: staffError?.message ?? 'staff upsert failed' }, { status: 500 })
  }

  // ── Step 4: upsert licences (active credentials only) ───────────────────
  if (credentials.length > 0) {
    const licenceRows = credentials.map((c) => ({
      cards_credential_id: c.id,
      staff_id:            staff.staff_id,
      tenant_id:           tenantId,
      licence_type:        c.credential_type,
      licence_number:      c.licence_number ?? null,
      issuing_authority:   c.issuing_body,
      state:               c.state_territory ?? null,
      issue_date:          c.issue_date ?? null,
      expiry_date:         c.expiry_date ?? null,
      active:              true,
      imported_from:       'eq-cards',
      imported_at:         now,
      confirmed_by:        null,
      confirmed_at:        null,
    }))

    // Same cross-tenant guard as the staff upsert above — onConflict on
    // cards_credential_id alone is not tenant-scoped at the DB level either.
    // Skip (not fail) any row a different tenant already claims, rather than
    // let it silently overwrite that tenant's licence record.
    const { data: conflictingLicences } = await appData
      .from('licences')
      .select('cards_credential_id, tenant_id')
      .in('cards_credential_id', licenceRows.map((r) => r.cards_credential_id))

    const foreignLicenceIds = new Set(
      (conflictingLicences ?? [])
        .filter((l) => l.tenant_id !== tenantId)
        .map((l) => l.cards_credential_id),
    )

    if (foreignLicenceIds.size > 0) {
      console.error(
        `approve-worker-assignment: skipped ${foreignLicenceIds.size} licence row(s) already claimed by a different tenant`,
      )
    }

    const safeLicenceRows = licenceRows.filter((r) => !foreignLicenceIds.has(r.cards_credential_id))

    if (safeLicenceRows.length > 0) {
      const { error: licenceError } = await appData
        .from('licences')
        .upsert(safeLicenceRows, { onConflict: 'cards_credential_id' })

      if (licenceError) {
        return Response.json({ error: licenceError.message }, { status: 500 })
      }
    }
  }

  // Inductions are stored in the worker pool (scoped by tenant_id) — no sync
  // to employer canonical needed. Employer reads them via the Cards read-link.
  // If a future requirement needs them in the canonical, add upsert here.

  return Response.json({
    success:    true,
    staff_id:   staff.staff_id,
    licences:   credentials.length,
    inductions: inductions.length,
  })
})
