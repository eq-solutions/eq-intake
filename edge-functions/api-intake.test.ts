// api-intake (Tier 1 row I13) tests: sign-in check, rate limit, dry run, audit entry.
// Run: deno test -A --node-modules-dir=auto edge-functions/api-intake.test.ts
// Loads the real api-intake/index.ts with Deno.serve and fetch stubbed, so no
// database, sign-in service or network is touched. All data is made up.
import { assert, assertEquals } from "jsr:@std/assert@1";

type Handler = (req: Request) => Promise<Response> | Response;

const URL_ = "https://ehow.example.test";
const ANON = "anon-test-key";
const SERVICE = "service-test-secret";
const USER_JWT = "aaa.bbb.ccc";
const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

function setEnv() {
  Deno.env.set("SUPABASE_URL", URL_);
  Deno.env.set("SUPABASE_ANON_KEY", ANON);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
}

async function load(): Promise<Handler> {
  setEnv(); // the handler reads env once, at import time
  let captured: Handler | undefined;
  const realServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => { captured = h; return { shutdown() {} }; };
  try {
    await import(`./api-intake/index.ts?${crypto.randomUUID()}`);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  assert(captured, "handler not registered");
  return captured;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call { url: string; rpc?: string; body?: Record<string, unknown> }

/** Stand-in network. `user` = what the sign-in check returns; `rpc` = per-function replies. */
function stub(opts: {
  user?: { user_metadata?: Record<string, unknown> } | null;
  rpc?: Record<string, () => Response>;
}) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = { url };
    if (init?.body && typeof init.body === "string") {
      try { call.body = JSON.parse(init.body); } catch { /* not json */ }
    }
    calls.push(call);
    if (url.includes("/auth/v1/user")) {
      return opts.user ? json({ id: "u1", aud: "authenticated", ...opts.user }) : json({ message: "bad jwt" }, 401);
    }
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      call.rpc = m[1];
      const r = opts.rpc?.[m[1]];
      if (r) return r();
    }
    return json(null);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const rpcCalls = (c: Call[], name?: string) => c.filter((x) => x.rpc && (!name || x.rpc === name));

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://fn.example.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const authed = { authorization: `Bearer ${USER_JWT}` };
const ROWS = [{ name: "Test Customer A" }, { name: "Test Customer B" }];
const GOOD_BODY = { entity: "customer", rows: ROWS, source: "unit-test" };
const COMMIT_OK = {
  committed_count: 2, flagged_count: 0, rejected_count: 0,
  flagged_rows: [], rejected_rows: [], intake_id: "33333333-3333-3333-3333-333333333333",
};
const okRpc = () => ({
  eq_check_intake_rate_limit: () => json(true),
  eq_commit_batch: () => json([COMMIT_OK]),
  eq_increment_intake_rate_limit: () => json(null),
});

// -- Sign-in check ------------------------------------------------------------

Deno.test("api-intake: no Authorization header -> 401, nothing called", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    assertEquals((await h(post(GOOD_BODY))).status, 401);
    assertEquals(f.calls.length, 0);
  } finally { f.restore(); }
});

Deno.test("api-intake: header that is not a Bearer token -> 401, nothing called", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    assertEquals((await h(post(GOOD_BODY, { authorization: "Basic abc" }))).status, 401);
    assertEquals(f.calls.length, 0);
  } finally { f.restore(); }
});

Deno.test("api-intake: key rejected by the sign-in service -> 401, nothing written", async () => {
  const h = await load();
  const f = stub({ user: null, rpc: okRpc() });
  try {
    assertEquals((await h(post(GOOD_BODY, authed))).status, 401);
    assertEquals(rpcCalls(f.calls).length, 0);
  } finally { f.restore(); }
});

Deno.test("api-intake: signed-in user with no tenant cannot pick one in the body -> 400, nothing written", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: {} }, rpc: okRpc() });
  try {
    const res = await h(post({ ...GOOD_BODY, tenant_id: OTHER_TENANT }, authed));
    assertEquals(res.status, 400);
    assertEquals(rpcCalls(f.calls).length, 0);
  } finally { f.restore(); }
});

Deno.test("api-intake: valid key uses its own tenant, ignores a different tenant in the body", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    const res = await h(post({ ...GOOD_BODY, tenant_id: OTHER_TENANT }, authed));
    assertEquals(res.status, 200);
    assertEquals(rpcCalls(f.calls, "eq_commit_batch")[0].body?.p_tenant_id, TENANT);
  } finally { f.restore(); }
});

Deno.test("api-intake: service-role secret may supply tenant_id in the body", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: {} }, rpc: okRpc() });
  try {
    const res = await h(post({ ...GOOD_BODY, tenant_id: OTHER_TENANT }, { authorization: `Bearer ${SERVICE}` }));
    assertEquals(res.status, 200);
    assertEquals(rpcCalls(f.calls, "eq_commit_batch")[0].body?.p_tenant_id, OTHER_TENANT);
  } finally { f.restore(); }
});

// -- Rate limit ---------------------------------------------------------------

Deno.test("api-intake: rate limit says no -> 429, nothing committed, counter not bumped", async () => {
  const h = await load();
  const f = stub({
    user: { user_metadata: { tenant_id: TENANT } },
    rpc: { ...okRpc(), eq_check_intake_rate_limit: () => json(false) },
  });
  try {
    assertEquals((await h(post(GOOD_BODY, authed))).status, 429);
    assertEquals(rpcCalls(f.calls, "eq_commit_batch").length, 0);
    assertEquals(rpcCalls(f.calls, "eq_increment_intake_rate_limit").length, 0);
  } finally { f.restore(); }
});

Deno.test("api-intake: rate limit is checked for the caller's tenant at 50 calls per 60 minutes", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    await h(post(GOOD_BODY, authed));
    const chk = rpcCalls(f.calls, "eq_check_intake_rate_limit")[0];
    assertEquals(chk.body, { p_tenant_id: TENANT, p_window_minutes: 60, p_max_calls: 50 });
  } finally { f.restore(); }
});

Deno.test("api-intake: a real commit bumps the rate-limit counter once for that tenant", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    assertEquals((await h(post(GOOD_BODY, authed))).status, 200);
    const inc = rpcCalls(f.calls, "eq_increment_intake_rate_limit");
    assertEquals(inc.length, 1);
    assertEquals(inc[0].body, { p_tenant_id: TENANT });
  } finally { f.restore(); }
});

// -- Dry run ------------------------------------------------------------------

Deno.test("api-intake: dry_run writes nothing, skips rate limit, reports what would be saved", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    const res = await h(post({ ...GOOD_BODY, dry_run: true }, authed));
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.dry_run, true);
    assertEquals(out.committed_count, ROWS.length);
    assertEquals(out.intake_id, null);
    assertEquals(rpcCalls(f.calls).length, 0); // no commit, no rate-limit check, no counter bump
  } finally { f.restore(); }
});

Deno.test("api-intake: dry_run only counts when exactly true (the string 'true' is a real run)", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    const res = await h(post({ ...GOOD_BODY, dry_run: "true" }, authed));
    assertEquals((await res.json()).dry_run, false);
    assertEquals(rpcCalls(f.calls, "eq_commit_batch").length, 1);
  } finally { f.restore(); }
});

Deno.test("api-intake: dry_run still refuses a bad key", async () => {
  const h = await load();
  const f = stub({ user: null, rpc: okRpc() });
  try {
    assertEquals((await h(post({ ...GOOD_BODY, dry_run: true }, authed))).status, 401);
    assertEquals(rpcCalls(f.calls).length, 0);
  } finally { f.restore(); }
});

// -- Audit entry --------------------------------------------------------------
// The handler does not write the audit row itself. It hands the source tag to
// eq_commit_batch, which writes intake_events, and returns that row's id.

Deno.test("api-intake: commit is tagged api:<source> for the audit log, and the audit id comes back", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    const res = await h(post(GOOD_BODY, authed));
    assertEquals(res.status, 200);
    const commit = rpcCalls(f.calls, "eq_commit_batch")[0];
    assertEquals(commit.body?.p_source, "api:unit-test");
    assertEquals(commit.body?.p_entity, "customer");
    assertEquals(commit.body?.p_rows, ROWS);
    assertEquals((await res.json()).intake_id, COMMIT_OK.intake_id);
  } finally { f.restore(); }
});

Deno.test("api-intake: no source given -> audit tag defaults to api:api", async () => {
  const h = await load();
  const f = stub({ user: { user_metadata: { tenant_id: TENANT } }, rpc: okRpc() });
  try {
    await h(post({ entity: "customer", rows: ROWS }, authed));
    assertEquals(rpcCalls(f.calls, "eq_commit_batch")[0].body?.p_source, "api:api");
  } finally { f.restore(); }
});

Deno.test("api-intake: commit failure -> 500 and the rate-limit counter is not bumped", async () => {
  const h = await load();
  const f = stub({
    user: { user_metadata: { tenant_id: TENANT } },
    rpc: { ...okRpc(), eq_commit_batch: () => json({ message: "boom" }, 500) },
  });
  try {
    assertEquals((await h(post(GOOD_BODY, authed))).status, 500);
    assertEquals(rpcCalls(f.calls, "eq_increment_intake_rate_limit").length, 0);
  } finally { f.restore(); }
});
