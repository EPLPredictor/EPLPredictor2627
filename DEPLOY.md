# EPL Predictor — deployment runbook

**Revision 2 — 31 Jul 2026.** See [Changelog](#changelog) at the bottom for what moved
since revision 1 and why. If you have the older copy, replace it: revision 1 put the
email-provider step too late, which blocks signups.

Built from `HANDOVER_v3.md`. Follow in order; each step has a check.

```
epl-predictor/
├── sql/01_schema.sql              Step 2 — tables, RLS, lock, scoring
├── sql/02_cron.sql                Step 6 — schedule the sync
├── functions/sync-fixtures/index.ts
├── epl-predictor.html             the app
├── DEPLOY.md                      this file
└── HANDOVER_v3.md                 design decisions + what's unverified
```

---

## Step order at a glance

| # | Step | Blocks what |
|---|---|---|
| 1 | Supabase project | everything |
| 2 | Schema | everything |
| **3** | **Custom SMTP** | **any signup by a non-teammate** |
| 4 | Email confirmation + OTP templates | the OTP flow |
| 5 | Sync function | fixtures appearing |
| 6 | Cron | fixtures staying current |
| 7 | App config + deploy | — |
| 8 | Verification | going live |

Steps 3 and 4 used to be one step, in the other order. Doing 4 first appears to work —
you'll get a code at your own address — and then fails for every real user.

---

## 1. Supabase project

New project at https://supabase.com. Note the database password. Wait for it to spin up.

**Settings → API**, copy:
- Project URL → `https://<ref>.supabase.co`
- `anon` **public** key

Note the **project ref** (the `<ref>` part) — needed in steps 5 and 6.

---

## 2. Schema

SQL Editor → paste all of `sql/01_schema.sql` → Run. Expect "Success. No rows returned."

**Check:**
```sql
select tablename from pg_tables where schemaname='public';
-- profiles, fixtures, predictions

select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public';
-- handle_new_user, touch_updated_at, fixture_is_open, score,
-- get_leaderboard, sync_age_seconds

-- There must be no password column anywhere:
select table_name, column_name from information_schema.columns
where table_schema='public' and column_name ilike '%password%';
-- 0 rows
```

Supabase's linter will warn that `public.leaderboard` is a security-definer view. That's
deliberate — see `HANDOVER_v3.md` §2. Access to the view itself is revoked; the only way
in is `get_leaderboard()`.

---

## 3. Custom SMTP — do this before touching templates

**Supabase's built-in email sender will not email your users.** It delivers only to
addresses belonging to members of your project's organization; everything else fails with
`Email address not authorized`. The cap is also 2 messages per hour for the whole project,
shared across signups, resets and invites, with no delivery SLA.

That means with the default sender you cannot test signup with a friend's address, and
cannot share the Netlify link at all. This is not a scaling concern for later. It is step 3.

**Authentication → Emails → SMTP Settings** → enable Custom SMTP → fill in host, port,
username, password, sender email, sender name. Once a provider is attached the cap becomes
30 messages per hour, raisable on the **Authentication → Rate Limits** page.

Provider choice, one practical wrinkle: most providers only deliver to arbitrary
recipients once you've **verified a domain you own**. If you don't have a domain, pick a
provider that allows verifying a single sender *address* instead — Brevo does this, which
suits a group-of-friends app. Resend and SendGrid generally want the domain. All three
change their terms often; confirm on their current pages. All have free tiers, so this
stays ₹0.

**Check:** send yourself a test from the SMTP settings page if the dashboard offers it.
Otherwise the real check is at the end of step 4.

---

## 4. Email confirmation, and OTP codes instead of links

**4a — Authentication → Providers → Email:** turn **Confirm email** on. With it enabled,
`signUp` returns a user but no session until the code is verified, which is what the app's
OTP screen expects. With it off, `signUp` hands back a live session and the OTP step is
skipped entirely — the app detects this and warns, but fix it here.

**4b — Authentication → Email Templates:** edit two templates.

There is no "enable OTP" toggle anywhere in the dashboard. People hunt for one and don't
find it. **The template variable is the switch**: a template containing
`{{ .ConfirmationURL }}` produces a clickable magic link, and one containing `{{ .Token }}`
produces a 6-digit code. So swap the variable, and remove the URL entirely — if both are
present, users will click the link and bypass your flow.

`{{ .Token }}` is a Go template variable, so the leading dot and the capitalisation are
exact. Get the casing wrong and it renders **empty rather than erroring**, which produces a
blank email and no clue why.

*Confirm signup:*
```html
<h2>Confirm your email</h2>
<p>Your EPL Predictor code:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
<p>It expires in one hour.</p>
```

*Reset password:*
```html
<h2>Password reset</h2>
<p>Your code:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
<p>Ignore this email if you didn't ask for it.</p>
```

The one-hour claim tracks the **Email OTP Expiration** setting (Authentication → Providers
→ Email), default 3600 seconds. If you change it, change the copy.

**Check** — this is the real test of steps 3 and 4 together. You need the app running
first, so come back after step 7, or use curl now:

```bash
curl -i -X POST 'https://<ref>.supabase.co/auth/v1/signup' \
  -H "apikey: <anon-key>" -H "Content-Type: application/json" \
  -d '{"email":"someone-not-on-your-team@example.com","password":"testpass123"}'
```

Expect `200` with a user object and `"session": null`. Then that address receives an email
containing digits and **no link**. If you get `Email address not authorized`, step 3 isn't
done. If you get a link, step 4b isn't done. If the mail is blank, check the casing of
`{{ .Token }}`.

Then confirm the trigger fired:
```sql
select email, email_confirmed_at from auth.users order by created_at desc limit 5;
select id, full_name, phone from public.profiles;   -- a row per signup
```
`email_confirmed_at` stays null until the code is entered.

---

## 5. Sync function

```bash
npm i -g supabase
supabase login
supabase link --project-ref <ref>

mkdir -p supabase/functions/sync-fixtures
cp functions/sync-fixtures/index.ts supabase/functions/sync-fixtures/

supabase secrets set FOOTBALL_DATA_TOKEN=<your-football-data-token>
supabase secrets set SYNC_SECRET=$(openssl rand -hex 24)   # save the output
supabase functions deploy sync-fixtures
```

Free token: https://www.football-data.org/client/register

**Check** — trigger it once by hand:
```bash
curl -i -X POST 'https://<ref>.functions.supabase.co/sync-fixtures?force=1' \
  -H "Authorization: Bearer <anon-key>" \
  -H "x-sync-secret: <sync-secret>"
```
Expect `{"synced":380,...}`. Then:
```sql
select count(*), max(synced_at) from fixtures;
select public.sync_age_seconds();
```

Confirm the secret guard works — this should return **403**:
```bash
curl -i -X POST 'https://<ref>.functions.supabase.co/sync-fixtures' \
  -H "Authorization: Bearer <anon-key>"
```

---

## 6. Cron

Open `sql/02_cron.sql`, replace `<project-ref>`, `<anon-key>`, `<sync-secret>`, run it.

If `create extension` fails on permissions, enable **pg_cron** and **pg_net** under
Database → Extensions, then re-run from the `cron.schedule` block.

**Check** after ~6 minutes:
```sql
select status, return_message, start_time
from cron.job_run_details where jobname='sync-fixtures'
order by start_time desc limit 5;
```

---

## 7. App

Open `epl-predictor.html`, fill the two lines in the CONFIG block:

```js
const SUPABASE_URL      = "https://<ref>.supabase.co";
const SUPABASE_ANON_KEY = "eyJ...";
```

There is no third key. The football-data token stays server-side.

Drag the file onto https://app.netlify.com/drop. Then **Authentication → URL
Configuration**: set Site URL to the Netlify URL and add it to Redirect URLs.

Redeploying later = drag the same file onto the same site.

---

## 8. Verification that proves something

Clicking a greyed-out button proves nothing. Run these.

Get a real user JWT: sign up in the app, then in the browser console:
```js
(await sb.auth.getSession()).data.session.access_token
```

**The kickoff lock must reject a past fixture.** Pick one:
```sql
select id, home_team, away_team, kickoff_utc from fixtures
where kickoff_utc < now() limit 1;
```
```bash
curl -i -X POST 'https://<ref>.supabase.co/rest/v1/predictions' \
  -H "apikey: <anon-key>" -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<your-uid>","fixture_id":<past-id>,"home_score":9,"away_score":0}'
```
Expect **401/403 with code `42501`** (row-level security violation). A `201` means step 2
didn't apply — stop and re-run the schema.

**The same call against a future fixture** should return `201`.

**Nobody can write fixtures:**
```bash
curl -i -X PATCH 'https://<ref>.supabase.co/rest/v1/fixtures?id=eq.<any-id>' \
  -H "apikey: <anon-key>" -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" -d '{"home_score":99}'
```
Expect a rejection, not `204`.

**Profiles are self-only** — with a user JWT, `GET /rest/v1/profiles` returns exactly one row.

**Predictions are hidden before kickoff.** With two accounts, A predicts a future match;
B's `GET /rest/v1/predictions` should not contain it. After kickoff it should.

**Scoring matches by hand.** After one finished matchday, compare `get_leaderboard()`
against a manual count: 10 exact, 5 right outcome, 2 within one goal each side.

---

## Known behaviour worth deciding on

- **Postponed fixtures.** Status flips to `POSTPONED`, so the lock closes and predictions can't be edited. Predictions already placed survive and become editable again when it's rescheduled with a future date. To wipe them instead, add a trigger on `fixtures` that deletes predictions when status becomes `POSTPONED`.
- **`TIMED` vs `SCHEDULED`.** football-data.org uses `TIMED` once kickoff is confirmed and `SCHEDULED` before that. Both count as open, in the SQL and the app. Miss this and every fixture looks locked.
- **Sync is the single point of failure.** `fixtures.kickoff_utc` drives the lock. If the cron dies, kickoff times go stale and matches could stay open. The app warns past 20 minutes; don't ignore it.
- **Code length.** Hosted Supabase sends 6 digits, but longer tokens are reported on some versions. The app accepts any non-empty code rather than hard-failing on length, so this can't lock anyone out.
- **Supabase pauses idle free projects** after about a week. The cron counts as activity.

---

## What was not built, deliberately

- **No admin override tab.** The WC app needed one because its upstream was flaky. Here, an override that writes scores would undermine derived scoring.
- **No stored points column.** The leaderboard is a view; it cannot drift.
- **No custom auth.** No password column, no client-side hashing, no self-issued OTP.

---

## Changelog

**Revision 2 — 31 Jul 2026**

Custom SMTP was step 3's closing footnote, described as something to sort out "for more
than a few users." That was wrong in a way that would have wasted an afternoon: the
built-in sender refuses any address outside your Supabase organization, so signups fail for
every real user, not just at volume. The rate limit was also understated — 2 messages per
hour, not "a handful." SMTP is now its own step, ahead of the templates.

Added, all of it new information rather than reorganisation:
- there is no "enable OTP" dashboard toggle; the template variable is the switch
- `{{ .Token }}` renders empty on a casing mistake instead of erroring
- remove `{{ .ConfirmationURL }}` rather than leaving both in
- the domain-verification wrinkle in provider choice
- a curl that tests steps 3 and 4 before the app exists
- the `Email OTP Expiration` setting behind the "expires in one hour" copy

Code change in the same revision: `epl-predictor.html` no longer rejects codes that aren't
exactly 6 characters, and the input accepts up to 10. A hard length check would have locked
users out over a server-side config detail they can't see or fix.
