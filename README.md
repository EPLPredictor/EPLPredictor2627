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
cron.sql                pg_cron schedule template for both cron jobs (placeholders — see §4)
index.ts                Edge Function: football-data.org -> fixtures table
send-reminders.ts       Edge Function: daily reminder emails — see §11
epl-predictor.html      the app itself — auth + 5 tabs (Predict/Results/Leaderboard/Rules/You)
Landing_Page.html       public marketing/rules/prizes page, served at "/"
rules-data.js           prizes + rules copy — single source of truth, loaded by BOTH
                         HTML pages (edit here, not in either HTML file, to change a
                         prize or a rule — prizes are explicitly tentative, see §5)
Terms_conditions_Plan.pdf   full T&C planning doc — NOT public, see the note below
netlify.toml            routing (see §1a) + blocks non-public files from being served
logo-96.png / favicon.png   the real Redfooty logo, resized for web (source: Logo.png,
                         1.9MB — never reference that one directly, it's for design use)
```

No framework, no `package.json`, no build step anywhere. Deploying a code change is:
edit the file, commit, push. Netlify auto-deploys from this repo's `main` branch (see
`netlify.toml`). `schema.sql`, `cron.sql`, and `index.ts` deploy to Supabase via the CLI
or by pasting into the SQL editor — see §4.

**`Terms_conditions_Plan.pdf` is in this repo but deliberately not public** —
`netlify.toml` returns 404 for it. It's marked "prepared for internal use": alongside the
official rules text (which IS public, published as the Rules section of both
`Landing_Page.html` and the app's Rules tab) it also has an internal site audit and
launch roadmap that was never meant to be visible to players. If you add real public
Terms/Privacy copy later, put it in a new file — don't unblock this one.

### 1a. Site map

```
/            Landing_Page.html   marketing, prizes, rules, sample leaderboard — public
/predict     epl-predictor.html  the actual app — login/signup/OTP + the 5 tabs
```

A returning visitor with an active session is redirected from `/` straight to `/predict`
(see the `getSession()` check near the top of `Landing_Page.html`'s script) — the
marketing page is only for first-time / logged-out visitors. The landing page's
"Register" button links to `/predict?view=signup`, which opens the app straight to the
signup screen instead of login.

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
                                                                       │  only while more than
                                                                       │  2h to kickoff
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
   name/phone/age into `profiles`. The client never inserts into `profiles` directly.
   Phone (Indian mobile, `^[6-9]\d{9}$`) and age (18+) are format/range-checked both in
   the HTML form and again inside the trigger, since the trigger is the only thing
   standing between the public signup API and the table. Age, not date of birth — see
   the decisions log for why, and how "current age" stays accurate without storing one.
2. **The lock is an RLS `WITH CHECK`**, not a disabled input. `fixture_is_open()` reads
   `fixtures.kickoff_utc` and closes 2 hours before kickoff, not at kickoff — paired with
   the odds freeze, see §3. A direct REST POST inside that window returns `42501`.
3. **Points are derived, never written.** `score()` is an immutable SQL function;
   `leaderboard` is a view over `predictions ⋈ fixtures`. There is no `total_points`
   column to tamper with or to drift.
4. **One server-side syncer, not N browsers.** The football-data.org token stays in the
   Edge Function; the 10 req/min budget is spent by one caller instead of every user's
   browser polling directly (which would also leak the token).

---

## 3. Scoring and eligibility (current rules)

Odds-based, revised 06 Aug 2026 — this project's fourth scoring formula (flat →
standings-gap → ClubElo-probability → flat → odds; see §6 for why each earlier one was
tried and dropped, and why odds is different).

```
wrong pick                                0
correct pick, odds locked for the fixture clamp(round(2 x odds), 4, 10)
correct pick, no odds on file             6 for a draw, 5 for a win (flat fallback)
```

"No odds on file" covers two cases with the same fallback: the fixture hasn't hit its
2-hours-before-kickoff freeze window yet, or the odds fetch genuinely failed. At odds
2.5, a correct win scores exactly 5; at odds 3.0, a correct draw scores exactly 6 — the
formula was deliberately anchored so it only meaningfully diverges from the old flat
numbers where the odds say a pick was more or less obvious than a coin flip.

**Predictions (and odds) lock 2 hours before kickoff, not at kickoff.** This is a
deliberate pairing, not two independent settings: if odds froze early but predictions
stayed open until kickoff, team news/lineups landing in that window could let someone
predict on information newer than the frozen odds reflect. `ODDS_LOCK_HOURS` in
`index.ts` and the `interval '2 hours'` in `fixture_is_open()` (`schema.sql`) must be
changed together — they're not read from one shared source.

One side effect worth knowing: the `read predictions` RLS policy also keys off
`fixture_is_open()`, so other players' picks now become visible 2 hours before kickoff
too, not exactly at kickoff. That's fine — once picks are locked, there's no remaining
copy-risk in showing them a little earlier.

**Prize eligibility:** a player must have predicted at least 75% of the matches that
have **finished so far** — not gameweeks, and not a fixed season-long total. It's a
rolling window: both the numerator (`matches_predicted`) and denominator
(`matches_completed`) grow as the season progresses, so "eligible" always means "on pace
right now," not "on pace for a target that's meaningless until the season nearly ends."
Restricting both sides to `status = 'FINISHED'` also automatically excludes postponed/
abandoned fixtures from the count — no special-case logic needed, since those never
reach `FINISHED`. Before any match finishes, everyone is treated as eligible (100%)
rather than dividing by zero. `get_leaderboard()` returns `matches_predicted`,
`matches_completed`, `participation_pct`, and `eligible` per player; the Leaderboard tab in
`epl-predictor.html` renders all four. See `schema.sql` §5 for the exact logic.

`public.score(pick, home_score, away_score, home_odds, draw_odds, away_odds)` is the
authoritative implementation. `epl-predictor.html`'s JS `pointsForCorrectPick()`
duplicates the same formula (used both for the Predict tab's live point preview and,
via `points()`, for Results-tab badges) — if you change one, change both.

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
5. **Deploy the Edge Functions:**
   ```
   supabase login   # or export SUPABASE_ACCESS_TOKEN
   supabase link --project-ref <ref>
   supabase secrets set FOOTBALL_DATA_TOKEN=<your-football-data-token>
   supabase secrets set SYNC_SECRET=<openssl rand -hex 24 output — save it>
   supabase secrets set ODDS_API_KEY=<your-the-odds-api-key>
   supabase functions deploy sync-fixtures
   curl -i -X POST 'https://<ref>.functions.supabase.co/sync-fixtures?force=1' \
     -H "Authorization: Bearer <anon-key>" -H "x-sync-secret: <sync-secret>"
   ```
   Expect `{"synced":380,...}`. Free token: https://www.football-data.org/client/register.
   Free odds key (500 credits/month — one `h2h`+`uk` call costs 1 credit, and the sync
   only spends one when a fixture is actually due, so 500/month is comfortable headroom
   for a 380-match season): https://the-odds-api.com/

   The response also includes `odds_debug` — check `matched` against `due_fixtures` the
   first time this runs for real. The team-name mapping in `index.ts` (`ODDS_API_TO_FD`)
   was written without a live API key to test against, so it may need fixing the first
   time a fixture actually enters the 2-hour lock window and the odds don't match up.

   Then the reminder function (§11) — needs a Brevo **transactional API key**
   (`xkeysib-...`, from Brevo → SMTP & API → API Keys — this is a different credential
   from the SMTP relay login used for OTP emails):
   ```
   supabase secrets set BREVO_API_KEY=<xkeysib-...>
   supabase secrets set REMINDER_SECRET=<openssl rand -hex 24 output — save it>
   supabase functions deploy send-reminders
   ```
6. **Schedule the cron.** Copy `cron.sql`, fill in the placeholders with real values, run
   it in the SQL editor. Do not commit the filled-in copy (§1).
7. **Configure the app.** Paste the project URL and `anon` key into the CONFIG block in
   `epl-predictor.html`. Push to `main` — Netlify auto-deploys from the GitHub
   connection (`netlify.toml` routes `/` to the landing page and `/predict` to the app —
   see §1a). Add the Netlify URL to **Authentication → URL Configuration** (Site URL +
   Redirect URLs) — the wildcard covers `/predict` too, no extra entry needed.
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
| **Predictions hidden until locked (2h before kickoff, not at kickoff — revised 06 Aug 2026)** | Otherwise users copy each other. The read policy keys off the same `fixture_is_open()` as the write policy, so it moved with the lock-time change below. | Low — relax the read policy. |
| **No admin override tab** | An override that writes scores would defeat derived scoring. | Medium — reintroduces the tampering surface. |
| **`TIMED` counts as open, alongside `SCHEDULED`** | football-data.org v4 uses `TIMED` once kickoff is confirmed. Treat only `SCHEDULED` as open and every fixture looks locked. | n/a — this is just correct. |
| **Phone mandatory + unique, format-checked only** | A real 10-digit Indian mobile number is a cheap authenticity/anti-duplicate filter without paying for SMS verification. Doesn't prove the number receives texts. | Medium to add real SMS verification — needs a paid gateway. |
| **Age (not date of birth) mandatory, 18+ enforced — revised 04 Aug 2026** | Compliance requirement for a contest with real cash prizes; unchanged. Originally collected as a full DOB, changed to a plain age input at the project owner's request. Neither is verified against real ID, so this doesn't weaken the gate — both are equally self-attested. "Current age" is derived (`age_at_signup` + full years since `created_at`), never stored, so it can't go stale without a birthdate on file. | Low to relax the 18+ threshold itself; **medium** to go back to DOB, since `profiles.dob` no longer exists — would need a real migration, not a revert. |
| **Win/Draw/Loss picks, not exact scorelines** | Simpler format, matches an earlier predictor this team built. | High — touches `predictions`' shape, `score()`, the leaderboard view, the sync function, and the prediction UI. |
| **Odds-based scoring, flat as fallback only — revised 06 Aug 2026** | Flat (+5/+6/0) was the third formula, chosen for simplicity after two more elaborate ones were dropped — see §6. Superseded because the project owner wanted a correct pick's value to actually track how likely it was, using real bookmaker odds instead of a fixed number. Flat didn't go away: it's now the fallback for a fixture with no locked odds (either too early, or the odds fetch failed), so it's still load-bearing, just no longer the default path. | Low to change the multiplier/floor/ceiling in `score()`; **medium** to drop odds entirely and go back to pure flat, since that also means reverting `fixture_is_open()`'s lock time and `index.ts`'s odds-fetch step. |
| **Odds lock paired with the prediction lock, both at T-2h before kickoff** | Freezing odds without also freezing predictions would let a late predictor use team news the frozen odds don't reflect. See §3 for the full reasoning. | Low-medium — `ODDS_LOCK_HOURS` in `index.ts` and the interval in `fixture_is_open()` (`schema.sql`) are two separate constants, kept in sync by hand, not a shared source. |
| **75%-of-matches-completed-so-far eligibility, rolling — revised from an earlier fixed-38-gameweek version** | The fixed-denominator version (participation counted by gameweek, against a hardcoded 38) made "eligible" meaningless until late in the season, and didn't measure per-match commitment. Revised (04 Aug 2026) to a rolling window against matches actually finished so far. | Low — it's the join condition in one view. |
| **`cron.sql` ships as a placeholder template, never a filled-in file** | An earlier version of this project committed a real `SYNC_SECRET` to git. Rotated once discovered; won't happen twice. | n/a — this is just correct. |
| **Prizes/rules live in `rules-data.js`, not hardcoded in either HTML file** | Prizes are explicitly tentative (project owner, Aug 2026) and the exact rules text comes from `Terms_conditions_Plan.pdf` §1. One data file both pages load means an edit can't apply to only one of them. | Low — it's one file. |
| **`Terms_conditions_Plan.pdf` blocked from public access via `netlify.toml`** | The PDF is marked "prepared for internal use" and mixes public rules text with an internal site audit/roadmap not meant for players. The public rules text was extracted into `rules-data.js` instead. | Low — remove the redirect rule if the PDF is ever cleaned up for public release. |

---

## 6. Scoring history (why odds, not flat, standings-gap, or ClubElo)

Skip this section unless you're wondering why an earlier formula isn't the one running,
or why the schema doesn't have position/probability columns.

Four formulas total, in order tried:

- **Standings-gap scoring.** Correct win scored more if the winner was ranked below the
  loser in the table at kickoff (an "upset bonus"), using `home_position`/
  `away_position` columns frozen by the sync job just before each fixture locked.
- **ClubElo-probability scoring.** Replaced the standings gap with a locked win/draw/
  loss probability pulled from ClubElo (free, no key), layered as: probability available
  → use it; else standings gap; else flat.
- **Flat scoring (+5 win / +6 draw / 0 wrong, no upset bonus).** Both of the above were
  reverted to this for simplicity and auditability — a fixed number is trivial to
  explain to a player who asks "why did I only get 5 points." Ran as the live system
  from initial launch until 06 Aug 2026.
- **Odds-based scoring (current).** Reintroduces an upset bonus, but sourced from real
  bookmaker odds (The Odds API) instead of the project's own standings/ClubElo data, and
  capped to a narrow 4–10 range rather than left unbounded — see §3 for the exact
  formula. The project owner's reasoning: flat was too blunt (a nailed-on favourite and
  a coin-flip paid the same), but the two earlier upset-bonus attempts had been dropped
  as over-engineered for a WDL format. Real odds sidestep that: no in-house probability
  model to maintain, and the bonus tracks an external, auditable number instead of one
  this project computed itself.

The standings-gap and ClubElo columns/functions were deleted outright when this file
replaced the old multi-file migration history, rather than left dormant — so reviving
either is a rebuild, not an uncomment: re-add the columns, the sync logic, and the
layered `score()` function. Old git history (or the previous `HANDOVER_v5.md`, if you
kept a copy) has the exact formulas if you want a starting point rather than designing
from scratch. Flat scoring didn't suffer the same fate — it's still live code, just
demoted to the fallback path (§3) for whenever a fixture has no locked odds.

---

## 7. Verification checklist

Run after any fresh deployment, before trusting it with real users:

- **Locked fixture write → rejected.** Insert/update a prediction against a fixture
  inside its 2-hour-before-kickoff lock window (or already past kickoff). Expect
  `403`/`42501`.
- **Open fixture write → succeeds.** Same call against a fixture more than 2 hours from
  kickoff. Expect `201`/`204`.
- **Direct write to `fixtures` → rejected**, `403`, "permission denied for table
  fixtures".
- **`GET /rest/v1/profiles` with a user JWT → exactly one row**, the caller's own.
- **Cross-account visibility** — account B's `GET /rest/v1/predictions` must not contain
  account A's prediction on an *open* fixture (more than 2h to kickoff), but must once
  that fixture has locked.
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
- **Sync is the single point of failure.** `fixtures.kickoff_utc` drives both the lock
  and the odds freeze. If the cron dies, kickoff times go stale and a match could sit
  open past its 2-hour lock point, or even past kickoff. The app warns past 20 minutes
  of staleness via `sync_age_seconds()`. Don't ignore the banner.
- **No penalty shootouts** on football-data.org's free tier. Irrelevant for league play.
- **Supabase pauses idle free projects** after roughly a week. The cron counts as
  activity.
- **Scoring is duplicated.** SQL `score()` is authoritative; the JS `pointsForCorrectPick()`
  in `epl-predictor.html` (used by `points()` for Results badges and by the Predict tab's
  live point preview) duplicates the same odds-clamp-then-flat-fallback formula. Change
  both together, or drop the JS copy and read points from an RPC instead.

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
- Leaderboard filters — Overall / This Gameweek / Eligible Only — per the planning doc's
  own site audit. The Leaderboard tab currently shows one combined view.

---

## 11. Reminder emails

Deliberately simpler than the planning doc's original 48h+6h two-tier design — see the
project owner's own framing: "not very imp[ortant]," just "manage it somehow." What's
actually built:

- **Once a day, not per-fixture.** `send-reminders` (Edge Function) finds the current
  gameweek — the earliest matchday with at least one fixture still open — and emails
  every registered player who hasn't predicted any fixture in it yet.
- **Hard-capped at 300 sends per run**, matching Brevo's free-tier daily limit (300/day,
  9,000/month — confirmed directly against Brevo's pricing, not assumed, same discipline
  as the football-data.org/ClubElo cost checks elsewhere in this project's history). If
  the pending list is longer than 300, the rest simply wait for tomorrow's run.
- **Dedup via `reminder_log`** (`user_id`, `matchday`): once someone's been emailed about
  a gameweek, they're never emailed about it again, so a multi-day rollout through a
  large pending list doesn't repeat itself — each day's run only picks up players nobody
  has reached yet.
- **No 300-user-base assumption baked in.** At small scale this clears the whole pending
  list in one run, every day, indefinitely. Nothing needs to change if usage grows —
  worst case is just that a large gameweek's backlog takes a few days to fully clear
  instead of one.
- Uses Brevo's transactional email API (`api.brevo.com/v3/smtp/email`), not the SMTP
  relay used for OTP emails — needs its own credential, a Brevo **API key** (different
  from the SMTP login/password pair). See §4 step 5.
- `reminder_candidates(matchday, limit)` (SQL function) does the actual selection —
  who's pending, who's already been emailed — and is the only thing that can read
  `auth.users.email` outside Supabase Auth itself. It is **not** granted to
  `anon`/`authenticated` anywhere; only the service role (used by the Edge Function) can
  call it. Don't add that grant — it would let any logged-in user harvest every pending
  player's email address.

---

*Redfooty EPL Predictor. This file supersedes `HANDOVER_v5.md` and `DEPLOY.md`
(removed) and the eight-file SQL migration history (`01_schema.sql` through
`07_flat_scoring_and_eligibility.sql`, removed) as of the move to a dedicated
Supabase/Netlify/GitHub account under `predictorepl@gmail.com`.*
