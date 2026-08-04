# Redfooty EPL Predictor

A Win/Draw/Loss prediction contest for the Premier League, run for a group of Indian
Reds with real prizes on the line (see `Landing_Page.html` for the current prize copy).
Single-file frontend, Supabase backend, ₹0/month infrastructure cost.

**This file is the only source of truth.** It replaces `HANDOVER_v5.md` and `DEPLOY.md`,
which described eight incremental SQL migrations (several since reverted) as separate
documents that drifted out of sync with each other and with the code. There's now one
schema file and one doc. If you're an AI assistant picking this project up cold: this
file plus the six files it names below is everything you need — don't reconstruct
history from git log unless you're specifically asked to.

---

## 1. What's in this repo

```
schema.sql              the whole database: tables, RLS, kickoff lock, scoring, leaderboard
cron.sql                pg_cron schedule template for the sync job (placeholders — see §4)
index.ts                Edge Function: football-data.org -> fixtures table
epl-predictor.html      the whole app — auth + 4 tabs, single file, no build step
Landing_Page.html       marketing/mockup page — placeholder data, not wired to Supabase
Terms_conditions_Plan.pdf   T&Cs for the contest
netlify.toml            makes a git-connected Netlify deploy serve epl-predictor.html at "/"
```

No framework, no `package.json`, no build step anywhere. Deploying a code change is:
edit the file, commit, push. Netlify auto-deploys `epl-predictor.html` from this repo's
`main` branch (see `netlify.toml`). `schema.sql`, `cron.sql`, and `index.ts` deploy to
Supabase via the CLI or by pasting into the SQL editor — see §4.

**Three secrets, none of them in this repo:**

| Secret | Where it lives | Public? |
|---|---|---|
| Supabase project URL + `anon` key | CONFIG block in `epl-predictor.html` | yes, by design |
| `FOOTBALL_DATA_TOKEN` | `supabase secrets set` | **no — server only** |
| `SYNC_SECRET` | `supabase secrets set` + filled into a *local, uncommitted* copy of `cron.sql` | **no — server only** |

`cron.sql` as committed here has `<placeholders>`, not real values. **Never commit the
filled-in version** — an earlier version of this project did exactly that (a real
`SYNC_SECRET` sat in `02_cron.sql` in git history) and it had to be rotated. Fill the
placeholders locally, run the SQL, then discard the filled copy.

---

## 2. How it works, in one pass

```
football-data.org  ──(cron, every 5 min)──▶  Edge Function  ──▶  fixtures table
   (matches + scores)                        (holds the token)    (public read)
                                                                       │
   browser ──── Supabase Auth (email OTP + password) ────────▶  predictions table
                                                                       │  RLS: insert/update
                                                                       │  only while
                                                                       │  kickoff_utc > now()
                                                                       │  stores a pick: H/D/A
                                                                       ▼
                                                          score() → leaderboard view
                                                                       │
                                                          get_leaderboard() RPC
```

Four load-bearing ideas, each one there because an earlier version of this app got it
wrong:

1. **Auth is entirely Supabase Auth.** No password column, no client-side hashing, no
   self-issued OTP. Signup writes to `auth.users`; a `SECURITY DEFINER` trigger copies
   name/phone/DOB into `profiles`. The client never inserts into `profiles` directly.
   Phone (Indian mobile, `^[6-9]\d{9}$`) and date of birth (18+) are format/age-checked
   both in the HTML form and again inside the trigger, since the trigger is the only
   thing standing between the public signup API and the table.
2. **The kickoff lock is an RLS `WITH CHECK`**, not a disabled input. `fixture_is_open()`
   reads `fixtures.kickoff_utc`. A direct REST POST after kickoff returns `42501`.
3. **Points are derived, never written.** `score()` is an immutable SQL function;
   `leaderboard` is a view over `predictions ⋈ fixtures`. There is no `total_points`
   column to tamper with or to drift.
4. **One server-side syncer, not N browsers.** The football-data.org token stays in the
   Edge Function; the 10 req/min budget is spent by one caller instead of every user's
   browser polling directly (which would also leak the token).

---

## 3. Scoring and eligibility (current rules)

```
wrong pick        0
correct draw      6
correct win       5
```

Deliberately flat — no bonus for calling an upset. Two more elaborate formulas were
tried and dropped; see §6 if you want the history.

**Prize eligibility:** a player must have predicted at least one fixture in 29 of the
season's 38 gameweeks (75%). `total_gameweeks` is hardcoded at 38 rather than computed
from `fixtures`, so a sync hiccup or a postponed/rescheduled fixture can't quietly
shrink the denominator mid-season. `get_leaderboard()` returns
`participation_gameweeks`, `total_gameweeks`, `participation_pct`, and `eligible` per
player; the Table tab in `epl-predictor.html` renders all four.

`public.score(pick, home_score, away_score)` is the authoritative implementation.
`epl-predictor.html`'s JS `points()` duplicates it for per-match badge rendering — if
you change one, change both.

---

## 4. Deployment (fresh project)

1. **Create the Supabase project.** Note the project URL, `anon` key, and project ref.
2. **Run `schema.sql`** in the SQL editor (or `supabase db push`). Confirm no column
   anywhere matches `%password%`.
3. **Custom SMTP, before anything else email-related.** Supabase's built-in sender only
   reaches your own org's members and caps at 2 messages/hour — every real signup fails
   without this. **Authentication → Emails → SMTP Settings.** This project uses Brevo
   (single verified sender, no domain owned — suits a no-domain group project).
4. **Authentication → Providers → Email:** turn **Confirm email** on. Then edit the
   *Confirm signup* and *Reset password* templates to use `{{ .Token }}` and remove
   `{{ .ConfirmationURL }}` entirely (if both are present, users click the link and skip
   the OTP screen). There's no "enable OTP" toggle — the template variable *is* the
   switch, and it renders empty rather than erroring if the casing is wrong.
5. **Deploy the Edge Function:**
   ```
   supabase login   # or export SUPABASE_ACCESS_TOKEN
   supabase link --project-ref <ref>
   supabase secrets set FOOTBALL_DATA_TOKEN=<your-football-data-token>
   supabase secrets set SYNC_SECRET=<openssl rand -hex 24 output — save it>
   supabase functions deploy sync-fixtures
   curl -i -X POST 'https://<ref>.functions.supabase.co/sync-fixtures?force=1' \
     -H "Authorization: Bearer <anon-key>" -H "x-sync-secret: <sync-secret>"
   ```
   Expect `{"synced":380,...}`. Free token: https://www.football-data.org/client/register
6. **Schedule the cron.** Copy `cron.sql`, fill in the three placeholders with real
   values, run it in the SQL editor. Do not commit the filled-in copy (§1).
7. **Configure the app.** Paste the project URL and `anon` key into the CONFIG block in
   `epl-predictor.html`. Push to `main` — Netlify auto-deploys from the GitHub
   connection (`netlify.toml` makes it serve at `/`). Add the Netlify URL to
   **Authentication → URL Configuration** (Site URL + Redirect URLs).
8. **Verify** — see §7.

Realistic first-time-through: 45–75 minutes, mostly waiting on the project to spin up
and the SMTP sender to verify.

---

## 5. Decisions log

Read this before changing anything — each row is a question someone will re-ask.

| Decision | Why | Cost of reversing |
|---|---|---|
| **Email OTP, not SMS** | No free SMS path exists; Twilio/MSG91/Vonage bill per message. Email gives the same security property — possession of a channel the attacker doesn't hold. | Low. `signInWithOtp({ phone })` plus a paid SMS gateway. |
| **Single HTML file, no framework** | No build step; redeploy = push to `main`. | Low now, higher past ~1000 lines — move to Vite then. |
| **Fixtures cached in our own table** | 10 req/min upstream budget is shared; client-side fetching also exposes the token. | High — it's the spine of the design. |
| **`leaderboard` as a view, exposed via `SECURITY DEFINER` RPC** | The view reads `profiles`, which is self-only under RLS, so a direct select returns one row. | Low. |
| **Predictions hidden until kickoff** | Otherwise users copy each other. | Low — relax the read policy. |
| **No admin override tab** | An override that writes scores would defeat derived scoring. | Medium — reintroduces the tampering surface. |
| **`TIMED` counts as open, alongside `SCHEDULED`** | football-data.org v4 uses `TIMED` once kickoff is confirmed. Treat only `SCHEDULED` as open and every fixture looks locked. | n/a — this is just correct. |
| **Phone mandatory + unique, format-checked only** | A real 10-digit Indian mobile number is a cheap authenticity/anti-duplicate filter without paying for SMS verification. Doesn't prove the number receives texts. | Medium to add real SMS verification — needs a paid gateway. |
| **DOB mandatory, 18+ enforced** | Compliance requirement for a contest with real cash prizes. | Low to relax, but don't — this is a legal gate, not a UX preference. |
| **Win/Draw/Loss picks, not exact scorelines** | Simpler format, matches an earlier predictor this team built. | High — touches `predictions`' shape, `score()`, the leaderboard view, the sync function, and the prediction UI. |
| **Flat scoring (+5/+6/0), no upset bonus** | Two more elaborate formulas were tried and dropped — see §6. Simplicity and auditability won over rewarding upset calls. | Low to re-add a bonus in `score()` alone; **high** to bring back position/probability data, since those columns were removed, not just unused. |
| **75%-of-38-gameweeks eligibility, fixed denominator** | Confirmed rule for prize qualification. Fixed at 38 so it can't shift if fixtures get rescheduled mid-season. | Low — it's one constant in one view. |
| **`cron.sql` ships as a placeholder template, never a filled-in file** | An earlier version of this project committed a real `SYNC_SECRET` to git. Rotated once discovered; won't happen twice. | n/a — this is just correct. |

---

## 6. Scoring history (why flat, not standings-gap or ClubElo)

Skip this section unless you're wondering why the schema doesn't have position or
probability columns.

Two earlier formulas were built and both were removed, not just disabled:

- **Standings-gap scoring.** Correct win scored more if the winner was ranked below the
  loser in the table at kickoff (an "upset bonus"), using `home_position`/
  `away_position` columns frozen by the sync job just before each fixture locked.
- **ClubElo-probability scoring.** Replaced the standings gap with a locked win/draw/
  loss probability pulled from ClubElo (free, no key), layered as: probability available
  → use it; else standings gap; else flat.

Both were reverted to flat scoring, and — when this file replaced the old multi-file
migration history — the columns, the freeze-functions, and the ~80 lines of Edge
Function code fetching standings/ClubElo were deleted outright rather than left dormant.
If upset-weighted scoring comes back, it's a rebuild: re-add the columns, the sync
logic, and the layered `score()` function. Old git history (or the previous
`HANDOVER_v5.md`, if you kept a copy) has the exact formulas if you want a starting
point rather than designing from scratch.

---

## 7. Verification checklist

Run after any fresh deployment, before trusting it with real users:

- **Past-kickoff fixture write → rejected.** Insert/update a prediction against a
  fixture with `kickoff_utc < now()`. Expect `403`/`42501`.
- **Future fixture write → succeeds.** Same call against an upcoming fixture. Expect
  `201`/`204`.
- **Direct write to `fixtures` → rejected**, `403`, "permission denied for table
  fixtures".
- **`GET /rest/v1/profiles` with a user JWT → exactly one row**, the caller's own.
- **Cross-account visibility** — account B's `GET /rest/v1/predictions` must not contain
  account A's prediction on a *future* fixture, but must after kickoff.
- **Scoring matches by hand** — after one finished gameweek, compare `get_leaderboard()`
  against a manual count.
- **Signup rejects under-18 and malformed phone numbers**, both from the app and via a
  direct `POST /auth/v1/signup` (tests the trigger, not just the client validation).

---

## 8. Known behaviour

- **Postponed fixtures.** Status flips to `POSTPONED`, the lock closes, predictions
  freeze. When rescheduled with a future date they become editable again and the old
  prediction survives. To wipe them instead, add a trigger on `fixtures` that deletes
  predictions when status becomes `POSTPONED`. Undecided — pick one deliberately.
- **Sync is the single point of failure.** `fixtures.kickoff_utc` drives the lock. If
  the cron dies, kickoff times go stale and a match could sit open after kickoff. The
  app warns past 20 minutes of staleness via `sync_age_seconds()`. Don't ignore the
  banner.
- **No penalty shootouts** on football-data.org's free tier. Irrelevant for league play.
- **Supabase pauses idle free projects** after roughly a week. The cron counts as
  activity.
- **Scoring is duplicated.** SQL `score()` is authoritative; the JS `points()` in
  `epl-predictor.html` renders per-match badges. Change both together, or drop the JS
  copy and read points from an RPC instead.

---

## 9. Ops

**Weekly:** `select public.sync_age_seconds();` — should stay under ~360. Skim Auth logs
for failed sends.

**When something breaks:**
```sql
-- is the cron alive? (job_run_details has no jobname column of its own —
-- only jobid — so join to cron.job to filter by name)
select j.jobname, jrd.status, jrd.return_message, jrd.start_time
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'sync-fixtures' order by jrd.start_time desc limit 10;

-- did data land?
select count(*), max(synced_at) from fixtures;
```
Then call the function directly with `?force=1` and read the JSON error — it reports
upstream status codes verbatim, including `429` for rate limiting.

**New season:** football-data.org returns the current season by default, so the sync
keeps working unattended. Add a `season` column before you care about last year's table.

---

## 10. Nice to have, unranked

- Editable profile in Settings — currently read-only, and there's already an
  `update own profile` policy waiting for it.
- Per-gameweek breakdown on the leaderboard, not just season totals.
- Mini-leagues: a `leagues` table + `league_members`, and a `get_leaderboard(league_id)`
  overload. The scoring function doesn't change.
- A `season` column on `fixtures` and `predictions`, so year two doesn't wipe year one.
- Wire `Landing_Page.html` to real Supabase data instead of placeholder rows, and link
  it from/to `epl-predictor.html`.

---

*Redfooty EPL Predictor. This file supersedes `HANDOVER_v5.md` and `DEPLOY.md`
(removed) and the eight-file SQL migration history (`01_schema.sql` through
`07_flat_scoring_and_eligibility.sql`, removed) as of the move to a dedicated
Supabase/Netlify/GitHub account under `predictorepl@gmail.com`.*
