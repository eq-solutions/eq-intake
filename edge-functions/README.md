# Edge functions: what's deployed where

This repo holds the only source for four Edge Functions that run on **ehow**
(`ehowgjardagevnrluult`, sks-canonical). The R2 backups cover ehow's database,
auth, storage, cron and Vault names, but **not Edge Functions**. If ehow has
to be rebuilt in a new project, these four must be redeployed from here.

Last checked against live ehow on 2026-10-16. For each function, the
deployed `index.ts` matched `origin/main` byte for byte. The one exception is
`quality-guardian`, where the deployed copy only lacks the final newline.

| Function | Source | `verify_jwt` | Live version | Reads from `Deno.env` | Called by |
|---|---|---|---|---|---|
| `eq-ai-assist` | `edge-functions/eq-ai-assist/index.ts` | **true** | v12 | `ANTHROPIC_API_KEY` | eq-shell (Intake screen), through `@eq/intake`'s `ai-client.ts` calling `supabase.functions.invoke('eq-ai-assist')` |
| `quality-guardian` | `supabase/functions/quality-guardian/index.ts` | **true** | v11 | `SUPABASE_URL` (Supabase injects it) | pg_cron job `quality-guardian-nightly` on ehow (`sql/060_quality_guardian_cron_sks.sql`) |
| `parse-maximo-pdf-wo` | `edge-functions/parse-maximo-pdf-wo/index.ts` | **false** | v14 | `ANTHROPIC_API_KEY` | eq-service Maximo PDF import, via Netlify env `MAXIMO_PDF_PARSE_ENDPOINT_URL` |
| `parse-rcd-switchboard-schedule` | `edge-functions/parse-rcd-switchboard-schedule/index.ts` | **false** | v2 | `ANTHROPIC_API_KEY` | eq-service RCD "Create check" photo upload, via Netlify env `RCD_SCHEDULE_PARSE_ENDPOINT_URL` |

`verify_jwt` isn't recorded anywhere in code: there's no `config.toml`. Set it
by hand on every deploy, using the values in the table. The two parsers need
it **off** because ehow's Functions gateway rejects the legacy-format
service-role JWT. The header comment in each file explains why.

`api-intake` and `approve-worker-assignment` also live in this folder, but
they aren't deployed on ehow.

## Rebuilding into a new project

1. Set the `ANTHROPIC_API_KEY` secret on the new project, in the dashboard
   under Edge Functions → Secrets. Three of the four functions refuse to run
   without it.
2. Deploy each function from the path in the table above, with its
   `verify_jwt` value. So far every deploy has gone through the Supabase MCP
   `deploy_edge_function`, with Royce's explicit go each time. No CI deploy
   path exists.
3. `quality-guardian` also needs:
   - the service-role RPCs from `sql/059` (they come back with the restored
     database), and
   - the Vault secret `edge_service_role_key`. A restore brings back the
     secret's name, but you have to write its value again with
     `vault.update_secret` using the new project's service-role key.
   - The cron job in `sql/060` **hardcodes the ehow URL**. Re-run it with
     the new project's URL, or the nightly run keeps calling the old project.
4. Repoint eq-service's Netlify env vars `MAXIMO_PDF_PARSE_ENDPOINT_URL` and
   `RCD_SCHEDULE_PARSE_ENDPOINT_URL` at the new project's
   `/functions/v1/<slug>` URLs.

After any change to one of these functions, keep this repo and the live
function in sync. `eq-ai-assist` drifted once (a direct MCP deploy with no
repo commit, fixed in #106). Compare the two with the Supabase MCP
`get_edge_function` before you trust either copy.
