// SEC-109 caller-check tests for the two Anthropic-spending parsers.
// Run: deno test -A --node-modules-dir=auto edge-functions/sec109-gate.test.ts
// Loads each real index.ts with Deno.serve and fetch stubbed, so nothing
// leaves the machine and no Anthropic call is possible.
import { assert, assertEquals } from "jsr:@std/assert@1";

type Handler = (req: Request) => Promise<Response> | Response;

const FAKE_JWT = "aaa.bbb.ccc";
const URL_ = "https://ehow.example.test";

async function load(slug: string): Promise<Handler> {
  let captured: Handler | undefined;
  const realServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => { captured = h; return { shutdown() {} }; };
  try {
    await import(`./${slug}/index.ts?${crypto.randomUUID()}`);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  assert(captured, "handler not registered");
  return captured;
}

function stubEnv(env: Record<string, string>) {
  const keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "ANTHROPIC_API_KEY"];
  for (const k of keys) { if (k in env) Deno.env.set(k, env[k]); else Deno.env.delete(k); }
}

function stubFetch(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(reply());
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function req(headers: Record<string, string> = {}) {
  // Valid multipart-less POST: if the gate passes, the handler answers 400 (no files) without calling Anthropic.
  return new Request("https://fn.example.test/", { method: "POST", headers, body: new FormData() });
}

for (const slug of ["parse-maximo-pdf-wo", "parse-rcd-switchboard-schedule"]) {
  const GOOD = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: "anon", ANTHROPIC_API_KEY: "sk-test" };

  Deno.test(`${slug}: no Authorization header -> 401, nothing fetched`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json([{ user_id: "u" }]));
    try {
      assertEquals((await h(req())).status, 401);
      assertEquals(f.calls.length, 0);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: malformed bearer -> 401, nothing fetched`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json([{ user_id: "u" }]));
    try {
      assertEquals((await h(req({ authorization: "Bearer not-a-jwt" }))).status, 401);
      assertEquals(f.calls.length, 0);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: token rejected by PostgREST (bad signature / other tenant project) -> 401`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json({ message: "JWT invalid" }, 401));
    try {
      assertEquals((await h(req({ authorization: `Bearer ${FAKE_JWT}` }))).status, 401);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: anon-role token sees no rows -> 401`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json([]));
    try {
      assertEquals((await h(req({ authorization: `Bearer ${FAKE_JWT}` }))).status, 401);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: PostgREST unreachable -> 401 (fails closed)`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => { throw new Error("network down"); });
    try {
      assertEquals((await h(req({ authorization: `Bearer ${FAKE_JWT}` }))).status, 401);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: SUPABASE_URL / ANON_KEY missing -> 401 (fails closed)`, async () => {
    const h = await load(slug); stubEnv({ ANTHROPIC_API_KEY: "sk-test" });
    const f = stubFetch(() => json([{ user_id: "u" }]));
    try {
      assertEquals((await h(req({ authorization: `Bearer ${FAKE_JWT}` }))).status, 401);
      assertEquals(f.calls.length, 0);
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: valid caller passes the gate, asks PostgREST with its own token, never reaches Anthropic`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json([{ user_id: "u" }]));
    try {
      const res = await h(req({ authorization: `Bearer ${FAKE_JWT}` }));
      assertEquals(res.status, 400); // gate passed; handler rejects the empty upload
      assertEquals(f.calls.length, 1);
      assert(f.calls[0].url.startsWith(`${URL_}/rest/v1/tenant_members`));
      // deno-lint-ignore no-explicit-any
      const sent = f.calls[0].init!.headers as any;
      assertEquals(sent.Authorization, `Bearer ${FAKE_JWT}`);
      assertEquals(sent["Accept-Profile"], "service");
      assert(!f.calls.some((c) => c.url.includes("api.anthropic.com")));
    } finally { f.restore(); }
  });

  Deno.test(`${slug}: CORS grants only the Service and Shell origins`, async () => {
    const h = await load(slug); stubEnv(GOOD);
    const f = stubFetch(() => json([]));
    try {
      const evil = await h(new Request("https://fn.example.test/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
      assertEquals(evil.headers.get("access-control-allow-origin"), null);
      const ok = await h(new Request("https://fn.example.test/", { method: "OPTIONS", headers: { origin: "https://service.eq.solutions" } }));
      assertEquals(ok.headers.get("access-control-allow-origin"), "https://service.eq.solutions");
      const denied = await h(req({ origin: "https://evil.example" }));
      assertEquals(denied.status, 401);
      assertEquals(denied.headers.get("access-control-allow-origin"), null);
    } finally { f.restore(); }
  });
}
