---
name: supabase-ops
description: Deploy and verify changes to this project's Supabase backend (schema, Edge Functions, auth config, secrets, cron) via API/CLI only, plus how to test them live with Playwright — no Supabase dashboard needed. Use whenever changing schema.sql, index.ts, send-reminders.ts, cron.sql, or verifying live behavior after a change.
---

# Supabase ops for Redfooty EPL Predictor

Everything in this project's Supabase backend is deployed through the Management API
and the CLI — never the dashboard UI. This skill is the accumulated gotchas from
actually doing that, several of which cost real debugging time the first time around.

Read `CLAUDE.md` first — the delete-safety rule there is not optional, and applies to
every cleanup step described below.

## Setup, every single time

Each PowerShell tool call in this environment is a **fresh shell** — nothing persists
between calls, including `PATH` and env vars. Every command block that uses `git`, `gh`,
or `npx supabase` needs this prepended:

```powershell
$env:Path += ";C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI"
$env:SUPABASE_ACCESS_TOKEN = "<the user's PAT, provided fresh each session — never persist it>"
```

The Supabase project ref is `snxrkdsrzzamoowijwcj`. The access token is a Personal
Access Token, account-wide in scope — ask the user for it, never store it in a file,
memory, or commit it.

## Deploying a schema.sql change

The Management API's `POST /v1/projects/{ref}/database/query` endpoint runs arbitrary
SQL — no CLI or DB password needed. Two things that will bite you:

- **It rejects large payloads (~413) around 14KB+.** Split the SQL into chunks at
  section-divider comments (`-- ---...`) and POST each chunk separately, in order.
- **`revoke all on function X from public` does NOT revoke direct grants to `anon`/
  `authenticated`.** This Supabase project (like most) grants EXECUTE to those roles
  directly on every new function, independent of the `PUBLIC` pseudo-role. A function
  meant to be `authenticated`-only that only does `revoke ... from public` is still
  callable by a fully anonymous caller — this happened for real with `get_leaderboard()`
  and wasn't caught until a live anon-key REST call was tested. Always write
  `revoke ... from public, anon, authenticated`, then re-grant only what's needed, and
  **verify with a real query, not the revoke statement's own comment**:
  ```sql
  select grantee, privilege_type from information_schema.routine_privileges
  where routine_name = '<function_name>';
  ```
  Better still, prove it with an actual unauthenticated REST call:
  ```powershell
  Invoke-RestMethod -Uri "https://snxrkdsrzzamoowijwcj.supabase.co/rest/v1/rpc/<fn>" `
    -Method Post -Headers @{apikey=$anonKey; Authorization="Bearer $anonKey"} -Body "{}"
  # expect 401/403 with code 42501 if it's meant to require auth
  ```

## Deploying an Edge Function (index.ts / send-reminders.ts)

Source of truth for each function lives as a flat `.ts` file at repo root (matches the
function name minus `-fixtures`/etc.) — `supabase/functions/<name>/index.ts` is a
deploy-time staging copy only, gitignored, never the thing you edit:

```powershell
New-Item -ItemType Directory -Force -Path "supabase\functions\<name>"
Copy-Item "<name>.ts" "supabase\functions\<name>\index.ts" -Force
npx --yes supabase functions deploy <name> --project-ref snxrkdsrzzamoowijwcj --workdir "."
```

Docker doesn't need to be running — the CLI bundles remotely and just prints a warning.

Before writing TypeScript for one of these, syntax-check it (Deno globals like `Deno.serve`
will show as semantic errors from `tsc`, which is fine — only TS1xxx codes are real syntax
errors):
```powershell
npx --yes tsc --noEmit --target es2022 --skipLibCheck <name>.ts 2>&1 | Select-String "error TS1"
```

## Secrets

```powershell
npx --yes supabase secrets set KEY=value --project-ref snxrkdsrzzamoowijwcj
```

Generate fresh secrets with real entropy, never reuse a value that's ever appeared in a
git commit (this project has one burned `SYNC_SECRET` in old history for exactly that
reason):
```powershell
$rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
$bytes = New-Object byte[] 24
$rng.GetBytes($bytes)
$secret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
```
Never print a secret to output — write it to a scratchpad file if you need to reuse it
across multiple tool calls in the same session, and don't commit that file.

## Auth config (SMTP, OTP templates, site URL) without the dashboard

`GET`/`PATCH /v1/projects/{ref}/config/auth` covers all of it — `smtp_host`/`smtp_port`/
`smtp_user`/`smtp_pass`/`smtp_sender_name`/`smtp_admin_email`, `mailer_autoconfirm`,
`mailer_templates_confirmation_content`/`mailer_templates_recovery_content` (HTML,
`{{ .Token }}` for OTP-style codes), `site_url`, `uri_allow_list`. `GET` first to see the
full current shape before writing a `PATCH` — field names aren't always obvious.

## Cron

`cron.sql` in the repo is a **placeholder template on purpose** — never commit a
filled-in copy. Fill placeholders locally, run via the database/query endpoint, discard.
Know before debugging a "job not running" report: `cron.job_run_details` has no
`jobname` column of its own, only `jobid` — join to `cron.job` to filter by name.

## Netlify

`netlify.toml`'s `publish = "."` serves the whole repo root, so every internal file
(schema, functions, docs) needs an explicit block — and **a redirect does nothing
against a path that already resolves to a real file unless `force = true` is set**. This
cost a full round-trip the first time (the block redirects silently no-opped without it).

## Verifying a change against the live app

Use Playwright driven from a local `file://` copy or the live URL, with a throwaway user
created via the Auth Admin API — bypasses OTP entirely, still exercises the real
`handle_new_user` trigger and its validation:

```js
await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "TestPass123!", email_confirm: true,
    user_metadata: { full_name, phone, age } }),
});
```

**Cleanup: delete only the exact ID(s) this run created — never a filtered list.** See
`CLAUDE.md` for why this rule exists; it was learned the expensive way, on real user data.

For layout/style checks, take real screenshots (`page.screenshot`) rather than describing
what should be there — several real bugs this project shipped (nav overlap, mojibake from
a PowerShell encoding bug, an accordion item stuck open) were only caught by actually
looking at a screenshot, not by reasoning about the CSS.

If you need the user to visually approve something before it goes live: capture
screenshots, embed them as base64 in a small HTML page, and publish it as an Artifact.
Costs nothing on Netlify's build minutes and gives a real before/after to react to,
instead of burning a deploy just to let someone look at a change.
