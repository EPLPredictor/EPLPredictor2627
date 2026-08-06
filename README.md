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
   `fixtures.kickoff_utc` and closes 2 hours before kickoff, not at kickoff — a separate
   timer from the odds freeze, see §3. A direct REST POST inside that window returns
   `42501`.
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
tried and dropped, and why odds is different). Revised again the same day to split what
was one "odds lock" timer into two: an **odds freeze** (24h before kickoff, produces the
real scoring number) and the **prediction lock** (2h before kickoff, unchanged, when
picks actually close) — see below for why.

```
wrong pick                                0
correct pick, FINAL odds on file          clamp(round(2 x odds), 4, 10)
correct pick, no odds on file at all      6 for a draw, 5 for a win (flat fallback)
```

**Final odds freeze 24 hours before kickoff, not 2.** Once frozen, `home_odds`/
`draw_odds`/`away_odds` on that fixture are permanent — `set_fixture_odds()` only ever
writes them once (guarded by `home_odds is null` in the sync job's query, not inside the
function itself). This is what `score()` actually reads; nothing below this line affects
a single point actually awarded.

**Before that 24h freeze, the app shows an indicative preview instead of a flat
placeholder or nothing.** `preview_home_odds`/`preview_draw_odds`/`preview_away_odds`
hold real market odds when The Odds API already has them for a fixture that far out,
refreshed at most every 4 hours (`PREVIEW_REFRESH_HOURS` in `index.ts`) via
`set_fixture_preview_odds()` — which, unlike the final-odds writer, is expected to be
called repeatedly and just overwrites each time. The frontend (`previewPointsForPick()`
in `epl-predictor.html`) shows this value with a `~` prefix and a banner explaining it's
an estimate; **it is never read by `score()` or anything SQL-side** — purely a display
concern. If a fixture has neither final nor preview odds yet (too far out to be priced,
or every fetch attempt failed), the Predict tab falls back to the same flat 5/6 numbers,
still shown with a `~` since they're not final either.

Why not just freeze odds immediately and skip the estimate? Two reasons, both from the
project owner directly: bookmaker odds are least reliable days out and most reliable
close to kickoff, so freezing too early locks in a worse number for everyone — but
showing literally nothing (or a static number that can't possibly be right) for a
fixture that's a week away isn't good UX either, and a live-but-unlabelled number would
let one player who predicts early get scored on stale information relative to one who
predicts late. The `~` marker plus the Rules-tab disclosure is the resolution: the
number can move, but it's never presented as a promise, so nobody predicting on an
estimate can reasonably claim they weren't told.

**A subtlety worth being explicit about, because it was raised and reasoned through
directly:** the preview refresh has to stamp `preview_synced_at` on every fixture it
*attempts*, not just ones where The Odds API actually had a price. A fixture too far out
to be priced yet would otherwise never get a timestamp, and would get re-queried (and
re-fetch the whole odds API response) on every 5-minute cron tick forever instead of
every `PREVIEW_REFRESH_HOURS` — silently blowing through the free API tier. `index.ts`
handles this by passing every attempted fixture to `set_fixture_preview_odds()` with
`home_odds: null` when there was no match, not just the ones that resolved to a price.

**Predictions lock 2 hours before kickoff — deliberately no longer tied to the odds
freeze.** Before 06 Aug 2026 these were the same timer, specifically so nobody could see
final odds and still have time to change their pick using newer team news. That
reasoning no longer applies the same way now that odds go final 24h out — by the 2h
mark, predictions have been open against final numbers for 22 hours regardless. The 2h
cutoff's remaining job is simpler: close the window before official starting lineups are
typically confirmed, independent of odds. `ODDS_FREEZE_HOURS` (24) in `index.ts` and the
`interval '2 hours'` in `fixture_is_open()` (`schema.sql`) are now two genuinely separate
constants — don't assume changing one should change the other.

One side effect worth knowing: the `read predictions` RLS policy keys off
`fixture_is_open()` (the 2h prediction lock), so other players' picks become visible 2
hours before kickoff — unrelated to the 24h odds freeze. That's fine — once picks are
locked, there's no remaining copy-risk in showing them a little earlier.

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
authoritative implementation — note it only ever takes the final `home_odds`/etc columns
as arguments, never the preview ones. `epl-predictor.html`'s JS `pointsForCorrectPick()`
duplicates the same formula (used by `points()` for Results-tab badges, and as the
final-odds branch inside `previewPointsForPick()` below) — if you change one, change
both. `previewPointsForPick()` is a separate, display-only function layered on top for
the Predict tab's `~` preview — it reads `preview_home_odds`/etc when `pointsForCorrectPick()`
has nothing final to work with yet, but it is never used for actual scoring anywhere.

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
   Free odds key (500 credits/month — one `h2h`+`uk` call costs 1 credit regardless of
   how many fixtures it covers; the sync only calls it when at least one fixture is due
   for a freeze or a preview refresh, and the preview refresh self-throttles to at most
   once every `PREVIEW_REFRESH_HOURS` — see §3): https://the-odds-api.com/

   The response includes `odds_debug` — check `matched` against `due_fixtures` (final
   freeze) and `preview_matched` against `preview_attempted` (indicative preview) the
   first time each actually runs for real. The team-name mapping in `index.ts`
   (`ODDS_API_TO_FD`) was checked 06 Aug 2026 against a real Odds API response compared
   to every distinct team name in the live `fixtures` table — all 20 clubs matched
   exactly. That check ran before the season started (no fixture had entered the 24h
   freeze window yet), so it's confirmed for team *names*, not yet for the live
   end-to-end freeze path — re-check `odds_debug` once a real fixture hits T-24h, and
   expect the mapping to need a touch-up whenever a club is promoted/relegated between
   seasons.

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
| **Odds freeze (T-24h) decoupled from the prediction lock (T-2h) — revised 06 Aug 2026, same day** | Originally both were one T-2h timer. Superseded after the project owner raised a real fairness question: with only a 2-hour window, someone who predicts early sees a number that can still change, and a live-changing number specifically fails the "predicted a week out, never came back" player worst of anyone. Freezing 24h out gives a 22-hour window where the shown value is already final. | Medium — reverting means collapsing `ODDS_FREEZE_HOURS` back to match `PREDICTION_LOCK_HOURS` and dropping the preview columns/writer/display logic, several files. |
| **Indicative `~` preview odds before the 24h freeze, not a static placeholder** | A fixture more than 24h out previously showed nothing informative. Real (if not-yet-final) market odds where available, refreshed every few hours, clearly marked as an estimate — full disclosure (the `~` plus Rules-tab text plus a banner) rather than trying to prevent the number from ever being wrong. | Low — it's additive; removing it just means falling back to the flat 5/6 shown everywhere pre-freeze. |
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
  this project computed itself. Launched same-day with odds freezing 2h before kickoff
  (same moment predictions locked); revised again hours later, still 06 Aug 2026, to
  freeze at 24h instead with a decoupled 2h prediction lock and a `~`-marked preview in
  between — see §3 and the decisions log for why a 2-hour window turned out to be too
  short and too easy to feel "cheated" by.

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
- **Preview odds never leak into scoring** — pick a fixture with `preview_home_odds` set
  but `home_odds` still null, confirm `score()` scores it on the flat fallback (5/6), not
  the preview value. Preview is display-only by design; this checks that's actually true.
- **Preview throttle actually throttles** — call `sync-fixtures?force=1` twice in a row
  a few minutes apart, confirm `preview_synced_at` doesn't move on fixtures more than 24h
  out on the second call (it should only update once per `PREVIEW_REFRESH_HOURS`).

---

## 8. Known behaviour

- **Postponed fixtures.** Status flips to `POSTPONED`, the lock closes, predictions
  freeze. When rescheduled with a future date they become editable again and the old
  prediction survives. To wipe them instead, add a trigger on `fixtures` that deletes
  predictions when status becomes `POSTPONED`. Undecided — pick one deliberately.
- **Sync is the single point of failure.** `fixtures.kickoff_utc` drives the prediction
  lock (2h), the odds freeze (24h), and indirectly the preview refresh throttle. If the
  cron dies, kickoff times go stale and a match could sit open past its lock point, or
  even past kickoff, and odds simply stop freezing/refreshing. The app warns past 20
  minutes of staleness via `sync_age_seconds()`. Don't ignore the banner.
- **A fixture with no Odds API data at all yet** (too far out to be priced, or every
  fetch attempt has failed) shows the flat `~5`/`~6` estimate, same as the fallback for a
  fixture with no final odds — the only difference from a real preview value is where
  the number comes from, the `~` treatment is identical either way.
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
