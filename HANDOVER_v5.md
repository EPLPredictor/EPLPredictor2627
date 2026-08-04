# EPL Predictor — Handover (v5, W/D/L scoring)

**Status:** deployed and live. Checks 1–5 of the §7 verification pass. Check 6 (scoring)
is still pending — it needs a finished matchday, and the season hasn't started yet.
**Prediction format changed since deployment: users now pick Win/Draw/Loss, not a
scoreline.** See §12 revision 4 for why and what it touches.
**Cost:** ₹0 / month
**Date:** 02 Aug 2026 — **revision 4**, see §12
**Supersedes:** v4 (post-deploy, scoreline predictions) and earlier

v2 was the brief. This is the handover for what was actually built from it. Where the
two disagree, the code wins and this file explains why.

---

## 0. Starting a fresh chat from this file

This file alone is enough to **orient** a new instance — architecture, decisions, what's
unverified. It is not enough to **edit code**, because it describes the artifacts without
containing them. Attach the files you're touching.

Paste this, and attach per the table:

> Picking up the EPL Predictor project. The attached handover is the source of truth for
> design decisions. The app is live and deployed. Don't regenerate any file from the
> handover's description — if you need to change a file, ask me to attach it first.
> Here's what I need: <your task>

| Task | Attach |
|---|---|
| Explain the design, plan a feature, decide something | this file only |
| Anything touching the database | `01_schema.sql` + `03_phone_required.sql` + `04_pick_based_scoring.sql` |
| Anything touching the UI or auth flow | `epl-predictor.html` |
| Anything about fixture data, standings, or the cron | `index.ts` + `02_cron.sql` |
| Deployment help, or you're stuck on a step | `DEPLOY.md` |
| Full audit or handover to a new owner | all eight |

**Two failure modes to head off.** First, a fresh instance may rewrite a file from this
description rather than editing the real one — the result looks right and diverges silently
from what you deployed. The instruction above is there to block that. Second, see §11: the
RLS kickoff lock and the derived leaderboard both look like they could be simplified into a
client-side check and a stored points column. That simplification is exactly what v1 was,
and it was exploitable from the browser console.

Also state which revision you hold. Both `DEPLOY.md` and this file are at **revision 2**
(31 Jul 2026); if your copies say revision 1, the email-provider ordering in them is wrong.

---

## 1. What you have

```
epl-predictor/
├── DEPLOY.md                        ← start here: ordered runbook + verification
├── sql/01_schema.sql        269 ln   tables, RLS, kickoff lock, scoring, leaderboard
├── sql/03_phone_required.sql        phone mandatory/unique, address dropped — run after 01
├── sql/04_pick_based_scoring.sql    W/D/L picks, standings-gap scoring — run after 03
├── sql/02_cron.sql           56 ln   pg_cron schedule for the sync job
├── functions/sync-fixtures/
│   └── index.ts                     Edge Function: football-data.org → fixtures + standings
└── epl-predictor.html                the whole app (auth + 4 tabs), single file
```

Nothing else is needed. No build step, no `package.json`, no framework.

Run order for the SQL matters: `01_schema.sql`, then `03_phone_required.sql`, then
`04_pick_based_scoring.sql`. The numbering is deployment order, not creation order — `03`
was written after `02_cron.sql` but must run before cron matters, since it only touches
`profiles` and auth. Rename the files to match run order exactly if it bothers you; not
done here to avoid invalidating anything that already references the old names.

**Three secrets, passed separately from this file:**

| Secret | Where it goes | Public? |
|---|---|---|
| Supabase project URL | CONFIG block in the HTML | yes, by design |
| Supabase `anon` key | CONFIG block in the HTML | yes, by design |
| football-data.org token | `supabase secrets set` | **no — server only** |
| `SYNC_SECRET` (self-generated) | `supabase secrets set` + cron SQL | no |

If the football-data token has ever appeared in client code or a git diff, rotate it.

---

## 2. How it works, in one pass

```
football-data.org  ──(cron, every 5 min)──▶  Edge Function  ──▶  fixtures table
   (matches + standings)                     (holds the token)   (+ frozen table
                                                                    position per
                                                                    unstarted fixture)
                                                                       │
                                                                       │ public read
                                                                       ▼
   browser ──── Supabase Auth (email OTP + password) ────────▶  predictions table
                                                                       │  RLS: insert/update
                                                                       │  only while
                                                                       │  kickoff_utc > now()
                                                                       │  stores a pick:
                                                                       │  H / D / A
                                                                       ▼
                                                          score() → leaderboard view
                                                                       │
                                                          get_leaderboard() RPC
```

Four load-bearing ideas. Each one exists because v1 got it wrong:

1. **Auth is entirely Supabase Auth.** No password column, no client-side hashing, no self-issued OTP. Signup writes to `auth.users`; a `SECURITY DEFINER` trigger copies name/phone into `profiles`. The client never inserts into `profiles`. Phone is mandatory, format-checked (Indian mobile, `^[6-9]\d{9}$`), and unique — enforced both in the HTML form and again inside the trigger, since the trigger is the only thing standing between the public signup API and the table. `address` was collected in early builds and never used; it's gone as of `03_phone_required.sql`.
2. **The kickoff lock is an RLS `WITH CHECK`**, not a disabled input. `fixture_is_open()` reads `fixtures.kickoff_utc`. A direct REST POST after kickoff returns `42501`.
3. **Points are derived, never written.** `score()` is an immutable SQL function; `leaderboard` is a view over `predictions ⋈ fixtures`. There is no `total_points` column to tamper with or to drift. As of `04_pick_based_scoring.sql`, `score()` also reads each fixture's frozen `home_position`/`away_position` — still derived, still nothing writable by the client.
4. **One server-side syncer, not N browsers.** The API token stays in the Edge Function; the 10 req/min budget is spent by one caller — now 2 calls per 5-minute tick (fixtures + standings), still far under budget.

---

## 3. Decisions log

Read this before changing anything — each row is a question someone will re-ask.

| Decision | Why | Cost of reversing |
|---|---|---|
| **Email OTP, not SMS** | No free SMS path exists. Twilio/MSG91/Vonage all bill per message; Firebase's phone quota keeps tightening. Email is the same security property — possession of a channel the attacker doesn't hold. | Low. `signInWithOtp({ phone })` plus a paid gateway in Supabase's SMS settings. Nothing else changes. Phone is already collected. |
| **Single HTML file, no framework** | Matches the WC 2026 predictor the team already deployed. No build step; redeploy = re-drag one file. | Low now, higher later. Past ~1000 lines, move to Vite. |
| **Fixtures cached in our own table** | 10 req/min is shared. ~15 users refreshing exhausts it, and client-side fetching exposes the token. | High — it's the spine of the design. |
| **`leaderboard` as a view, exposed via `SECURITY DEFINER` RPC** | The view reads `profiles`, which is self-only under RLS, so a direct select returns one row. | Low. |
| **Predictions hidden until kickoff** | Otherwise users copy each other. `read predictions` policy: own always, others' only once `fixture_is_open()` is false. | Low — relax the policy. |
| **No admin override tab** | The WC app needed one because its upstream was flaky. football-data.org is reliable, and an override that writes scores would defeat derived scoring. | Medium — you'd need a writable score path, which reintroduces the tampering surface. |
| **`TIMED` counts as open, alongside `SCHEDULED`** | football-data.org v4 uses `TIMED` once kickoff is confirmed. Treat only `SCHEDULED` as open and *every* fixture looks locked. | n/a — this is just correct. |
| **Phone mandatory + unique, format-checked, no SMS OTP** | Group-of-friends app; a real 10-digit Indian mobile number is a cheap authenticity filter without paying for SMS verification. Format check only — it doesn't prove the number receives texts, just rejects obviously fake input (`0000000000`, letters, wrong length). Uniqueness stops one person registering twice. | Low to relax the format/uniqueness; **medium** to add real SMS verification later — would need a paid gateway and a second OTP path alongside the existing email one. |
| **`address` dropped from `profiles`** | Collected at signup in early builds, never displayed or used anywhere in the app. Removed rather than left dead. | Low — it's just a column; nothing else referenced it. |
| **Win/Draw/Loss picks + standings-gap scoring, not exact scorelines** | Requested change from exact-score prediction to the simpler W/D/L format used in the earlier WC 2026 predictor. A real bookmaker-odds ratio was the first idea but every EPL-covering odds API needs a paid tier — checked directly, not assumed — so ₹0 cost would have broken. League table position (already free via football-data.org) is the substitute: correctly calling an upset scores more than correctly calling the obvious favourite. | **High.** Touches `predictions`' column shape, `score()`, the leaderboard view, the sync function (now also pulls standings), and the prediction UI. Reverting to scorelines means re-adding `home_score`/`away_score` to `predictions`, rewriting `score()` back, and rebuilding the two-input UI — not a quick toggle. |

---

## 4. What changed from the v2 brief

Two bugs caught while writing the SQL. Both were in the v2 brief's own snippets, so if
anyone built from v2 directly, they have them.

**`profiles.full_name` is `NOT NULL`.** The trigger passed `nullif(trim(...), '')`, so a
signup with no name in the metadata failed the `auth.users` insert and surfaced as an
opaque 500 at the client. The app validates the field, but a direct API signup doesn't.
Now falls back to the email's local part, then `'Player'`.

**Postgres grants `EXECUTE` to `PUBLIC` on every new function.** v2's
`revoke all on function get_leaderboard() from anon` did nothing — anon could still read
every user's name and score. Now revoked from `public`, then granted to `authenticated`.

The same rule cuts the other way, and this is the trap worth remembering:
**`fixture_is_open()` must stay executable by `anon` and `authenticated`.** It's called
inside the RLS policies, which are evaluated as the *invoking* role. Revoke it and every
prediction read and write fails with `permission denied for function`. It looks removable.
It isn't. There's a comment in the schema saying so.

Smaller additions beyond the brief: `sync_age_seconds()` RPC feeding a staleness banner;
a `SYNC_SECRET` header check on the Edge Function (the anon key is public, so without it
anyone could spam the syncer and burn the rate limit); a 60-second upstream guard; and
`touch_updated_at` on predictions.

---

## 5. Verified vs not — read before you trust it

**Verified against the live project, 01 Aug 2026** (§7/§8 checks, run via browser-console
`fetch` against the real REST endpoint, not curl — no terminal was available):

- Past-kickoff fixture write → rejected, `403` / `42501` (RLS violation). *Tested against a
  manually inserted fixture with a back-dated kickoff, since the 2026–27 season hadn't
  started yet and no genuinely past fixture existed in the table. Deleted afterward.*
- Future fixture insert/update → succeeds, `201` / `204`.
- Direct write to `fixtures` → rejected, `403`, "permission denied for table fixtures".
- `GET /rest/v1/profiles` with a user JWT → exactly one row, the caller's own.
- Cross-account visibility → account B's `GET /rest/v1/predictions` does not contain
  account A's prediction on a future fixture.

**Not yet verified:** scoring (§9) under its *current* pick-based formula. Needs a finished
matchday with real results synced in, then a manual comparison against `get_leaderboard()`.
Can't be tested before the season starts. This is the one open item before fully trusting
the points system. Also unverified: whether `home_position`/`away_position` actually
populate correctly once the updated sync function runs against live standings data — check
this the first time the sync job runs post-migration, before relying on the upset bonus.

**Predictions were wiped a second time** by `04_pick_based_scoring.sql`, on top of the
earlier wipe from `03_phone_required.sql` — the scoreline format is incompatible with the
new pick format. Anyone who'd already predicted needs to re-predict.

**SMTP is live.** Brevo, single verified sender (no domain owned), sender address
`predictorepl@gmail.com`. OTP-by-email confirmed working end to end during account
creation for the checks above.

**Test data has been wiped once already** (`03_phone_required.sql` §0, to backfill the new
mandatory-phone constraint onto a clean slate) — the accounts used for the checks above no
longer exist. Expect to need fresh signups for any further testing.

---

## 6. Deployment, in short

Full detail in `DEPLOY.md`. **All steps below are done and live as of 01 Aug 2026.** The
shape, for anyone repeating this on a second environment:

1. Create the Supabase project; note URL, `anon` key, project ref.
2. Run `sql/01_schema.sql`. Confirm no column anywhere matches `%password%`.
3. **Configure custom SMTP before anything else email-related.** The built-in sender only reaches your own organization's members, so skipping this makes every real signup fail. *(Done via Brevo — single verified sender, no domain needed.)*
4. **Authentication → Providers → Email:** "Confirm email" must be **on**. Then edit the *Confirm signup* and *Reset password* templates to use `{{ .Token }}` and drop `{{ .ConfirmationURL }}`. There is no OTP toggle in the dashboard — the template variable is the switch, and a casing mistake renders it empty rather than erroring.
5. `supabase secrets set` the football-data token and `SYNC_SECRET`; deploy the function; trigger it once with `?force=1`.
6. Run `sql/02_cron.sql` with the three placeholders filled.
7. Paste the two Supabase values into the HTML CONFIG block; drag onto Netlify Drop; add the URL to Supabase's redirect allow-list.
8. Run the verification section. *(Checks 1–5 pass; check 6 pending a finished matchday.)*
9. **Post-launch:** run `sql/03_phone_required.sql` to make phone mandatory/unique/format-checked and drop `address`. This wipes existing test accounts (auth.users cascades to profiles/predictions) — expect to re-signup after running it.
10. **Post-launch:** redeploy the updated `functions/sync-fixtures/index.ts` (now also pulls standings), then run `sql/04_pick_based_scoring.sql` to switch predictions to Win/Draw/Loss picks with standings-gap scoring, then redeploy the updated `epl-predictor.html`. This wipes existing predictions — the scoreline format is incompatible with picks.

Realistic first-time-through: 60–90 minutes, most of it waiting on the project to spin up,
verifying an SMTP sender, and the first cron tick.

---

## 7. Open items

**Do before real users:**
- [x] Run the §7 verification. Checks 1–5 pass (§5 above). Check 6 (scoring) can't be
  tested until a matchday finishes — do it the moment one does, before trusting the
  leaderboard with real stakes.
- [x] **Configure custom SMTP.** Done via Brevo, single verified sender, no domain owned.
- [ ] Decide the `POSTPONED` behaviour (§8).
- [ ] Run `sql/03_phone_required.sql` on any environment that hasn't had it yet — mandatory/unique/format-checked phone, `address` dropped.
- [ ] Redeploy `index.ts`, run `sql/04_pick_based_scoring.sql`, redeploy `epl-predictor.html` on any environment that hasn't had the W/D/L scoring change yet.
- [ ] Confirm `home_position`/`away_position` are actually populating after the first post-migration sync run — check a few upcoming fixtures in the `fixtures` table.

**Nice to have, in rough order of value:**
- [ ] Editable profile in Settings — currently read-only, and there's already an `update own profile` policy waiting for it.
- [ ] Per-matchday breakdown on the leaderboard.
- [ ] Mini-leagues. Cleanest shape: a `leagues` table plus `league_members`, and a `get_leaderboard(league_id)` overload. The scoring function doesn't change.
- [ ] `season` column on `fixtures` and `predictions`, so year-two doesn't wipe year-one's table.

---

## 8. Known behaviour

- **Postponed fixtures.** Status flips to `POSTPONED`, the lock closes, predictions freeze. When it's rescheduled with a future date they become editable again and the old prediction survives. If you'd rather clear them, add a trigger on `fixtures` that deletes predictions when status becomes `POSTPONED`. Undecided — pick one deliberately.
- **Sync is the single point of failure.** `fixtures.kickoff_utc` drives the lock. If the cron dies, kickoff times go stale and a match could sit open after kickoff. The app warns past 20 minutes via `sync_age_seconds()`. Don't ignore the banner.
- **No penalty shootouts** on football-data.org's free tier. Irrelevant for league play; matters if you extend to cups.
- **Supabase pauses idle free projects** after roughly a week. The cron counts as activity.
- **Scoring is duplicated.** SQL `score()` is authoritative; the JS `points()` renders per-match badges. If you change the rules, change both — or drop the JS copy and read points from an RPC.
- **Table position is frozen per-fixture, not looked up live.** The sync job writes `home_position`/`away_position` onto a fixture only while it's `SCHEDULED`/`TIMED`; once a match starts, those two columns stop being touched. This is deliberate — the upset bonus should reflect the table as it stood before kickoff, not wherever the table ends up after the round finishes. One consequence: if the sync job doesn't run between a fixture appearing and its kickoff, that fixture may never get a position frozen, and falls back to the flat 5-point "no standings yet" score for a correct win pick.

---

## 9. Scoring rules

**As of `04_pick_based_scoring.sql`.** Predictions are a single pick — Home win / Draw /
Away win — not a scoreline. Points depend on how big the table gap was between the two
teams *at the moment the fixture's position was last frozen* (i.e. just before kickoff —
see §2 point 3 and §8).

```
wrong pick                                             0
correct draw                                           6
correct win, favourite won as expected                 3
correct win, upset (lower-ranked team won)      3 + min(gap ÷ 2, 12)   → capped at 15
correct win, no frozen standings yet (early season)    5
```

`gap` is the absolute difference in table position between the winning and losing team,
but only counted as a bonus when the *winner* was ranked worse — an expected result never
gets the bonus, regardless of how big the gap was. The "no standings yet" fallback exists
because `home_position`/`away_position` are only populated once the sync job has run at
least once against a fixture while the standings endpoint actually has data — which, at
the very start of a season, it may not yet.

`public.score(pick, hs, aws, hpos, apos)` is the authoritative implementation. The JS
`points()` in `epl-predictor.html` duplicates it for per-match badge rendering — if you
change one, change both (see §8, "scoring is duplicated").

---

## 10. Ops

**Weekly:** `select public.sync_age_seconds();` — should stay under ~360. Skim Auth logs
for failed sends.

**When something breaks:**
```sql
-- is the cron alive?
select status, return_message, start_time from cron.job_run_details
where jobname='sync-fixtures' order by start_time desc limit 10;

-- did data land?
select count(*), max(synced_at) from fixtures;
```
Then call the function directly with `?force=1` and read the JSON error — it reports
upstream status codes verbatim, including `429` for rate limiting.

**New season:** football-data.org returns the current season by default, so the sync keeps
working unattended. Add the `season` column before you care about last year's table.

---

## 11. Picking this up in a new chat

Paste this file plus `DEPLOY.md` and say what you want. If you also paste the code files,
say which one you're changing — the four artifacts are independent and the schema is the
one where mistakes are expensive.

Two things a fresh instance should not "helpfully" redesign: the RLS-based kickoff lock,
and the derived leaderboard. Both look like they could be simplified into client-side
checks or a stored points column. That simplification is exactly what v1 was, and it was
exploitable from the browser console.

---

*Original WC 2026 predictor by Johnson, Merkle CDS Innovation. v5, 02 Aug 2026.*

---

## 12. Revision history

**Revision 4 — 02 Aug 2026.** Prediction format changed from exact scoreline to Win/Draw/
Loss picks, with points scaled by the table gap between the two teams instead of a fixed
tier. Requested to match the earlier WC 2026 predictor's simpler format.

*Real bookmaker odds were considered first and ruled out.* Checked directly rather than
assumed: The Odds API's free tier covers only NBA/MLB, not soccer — EPL odds need their
paid tier. Other providers claiming free unlimited soccer odds are obscure/unverified.
Building the "difficulty ratio" on a paid or unreliable dependency would have broken the
₹0/month constraint the whole project has held to, so league table position — already
free via football-data.org, already the data source in use — stands in for odds instead.

*Three artifacts changed together.* `functions/sync-fixtures/index.ts` now makes a second
upstream call per run, to `/competitions/PL/standings`, and freezes each team's position
onto every fixture that hasn't kicked off yet (`sql/04_pick_based_scoring.sql` adds the
`home_position`/`away_position`/`home_points`/`away_points` columns this needs). The same
migration replaces `predictions.home_score`/`away_score` with a single `pick` column
(`H`/`D`/`A`) and rewrites `score()` around the new formula (§9). `epl-predictor.html`'s
two number inputs became three Home/Draw/Away buttons; the JS `points()` duplicate was
updated to match. **This is the second time predictions have been wiped** (`03_...` wiped
`auth.users` for the phone constraint; `04_...` wipes `predictions` for the format change)
— both wipes were safe only because no real user had live stakes on the data yet.

*Why the position gap only rewards actual upsets, not raw distance.* Two mid-table teams
eight places apart, where the higher one wins as expected, isn't a hard call — the bonus
only applies when the side that actually won was the one ranked *worse*. This was a
deliberate asymmetry, not an oversight; §9 spells out the exact comparison.

**Revision 3 — 01 Aug 2026.** Deployment happened. Two kinds of changes in this revision:
status updates, and one real schema/UI change made after going live.

*Deployed and verified.* SMTP is live via Brevo (single verified sender, no domain owned).
§7 checks 1–5 all pass, run via browser-console `fetch` against the live REST endpoint —
no terminal was available, so the curl commands in `DEPLOY.md` were adapted to `fetch()`
calls instead; functionally identical. Check 1 needed a manually inserted fixture with a
back-dated kickoff, since the 2026–27 season hadn't started and no genuinely past fixture
existed yet. Check 6 (scoring) remains untested — it needs a finished matchday.

*`address` dropped, `phone` made mandatory/unique/format-checked.* Address was collected
at signup but never surfaced anywhere in the app — dead weight. Phone changed from
optional to a required 10-digit Indian mobile number (`^[6-9]\d{9}$}`), enforced in the
signup form, again in the `handle_new_user` trigger (in case someone calls the signup API
directly), and backed by a `unique` constraint so one number can't register twice. This is
a **format** check, not SMS verification — no gateway involved, ₹0 cost preserved. New
`phone_is_taken()` RPC lets the app show "already registered" before attempting signup,
rather than surfacing the trigger's raw constraint violation. Shipped as
`sql/03_phone_required.sql`, which also wipes existing `auth.users` to apply the new
`not null` constraint cleanly — safe pre-launch, would not be safe with real users on it.

**Revision 2 — 31 Jul 2026.** Corrections after checking Supabase's current docs rather
than relying on recalled behaviour.

*Supabase's built-in email sender only delivers to members of your project's organization.*
Revision 1 described it as development-grade and rate-limited, which understated it twice
over: the real cap is 2 messages per hour for the whole project, and any recipient outside
your organization is rejected outright with `Email address not authorized`. The practical
effect is that custom SMTP is a prerequisite for a single real signup, not a scaling task
for later. It's now step 3 of the runbook, ahead of template editing, because editing
templates first appears to work — a code arrives at your own address — and then fails for
everyone else.

*There is no "enable OTP" toggle in the dashboard.* The email template variable is the
switch: `{{ .ConfirmationURL }}` yields a magic link, `{{ .Token }}` yields a 6-digit code.
Worth knowing before you spend twenty minutes looking for a setting that doesn't exist.
Related: `{{ .Token }}` is a Go template variable, so a casing slip renders it empty rather
than raising an error — a blank email with no diagnostic.

*Code-length validation relaxed in `epl-predictor.html`.* Both OTP inputs previously
required exactly 6 characters. Hosted Supabase does send 6 digits, but longer tokens are
reported on some versions, and a client-side length check would have locked users out over
a server-side detail they can neither see nor change. Both handlers now accept any
non-empty code; `maxlength` is 10 so a paste can't be silently truncated.

Everything else — schema, RLS lock, scoring, sync architecture — is unchanged from
revision 1.
