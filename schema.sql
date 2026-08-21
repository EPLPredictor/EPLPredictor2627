-- ============================================================
-- EPL Predictor — schema
--
-- Single consolidated file for a fresh project. Run once in the
-- Supabase SQL editor (or `supabase db push`). Safe to re-run —
-- everything is idempotent.
--
-- Reflects the CURRENT rules only:
--   - Win/Draw/Loss picks (not scorelines)
--   - Odds-based scoring: clamp(round(2 x odds), 4, 10) for a correct
--     pick once real odds are frozen for that fixture (24h before
--     kickoff); flat +5 win / +6 draw when they aren't yet (or the
--     odds fetch failed — same fallback covers both). See §5.
--   - Before that 24h freeze, the app shows an INDICATIVE preview
--     value (~ prefixed, refreshed every few hours, real market data
--     when available or the same flat number otherwise) so a fixture
--     never shows literally nothing — but this preview is never used
--     for scoring, only display. See §4.
--   - Predictions lock 2 hours before kickoff — a separate timer from
--     the odds freeze above, not the same moment. See §4 for why
--     they're deliberately decoupled now (revised 06 Aug 2026).
--   - Signup requires a verified-format Indian mobile number and an
--     age of 18+ (stored as age_at_signup, not a date of birth — see
--     §1), both enforced again in the trigger in case someone calls
--     the signup API directly
--   - Prize eligibility: predicted at least 75% of the matches that
--     have finished SO FAR — a rolling window, not a fixed 38-gameweek
--     denominator. See §5 below.
--
-- This project has tried flat, standings-gap, ClubElo-probability,
-- and now real-odds scoring (see README §6 and git history) — read
-- the reasoning there before "simplifying" back to flat again; it's
-- been tried twice already for reasons that stopped applying once
-- real prizes and a real odds provider were both in the picture.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PROFILES  (hangs off auth.users — no password column, ever)
-- ------------------------------------------------------------

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  full_name      text not null,
  phone          text not null,
  age_at_signup  int  not null,
  created_at     timestamptz not null default now()
);

alter table public.profiles
  drop constraint if exists profiles_phone_format;
alter table public.profiles
  add constraint profiles_phone_format check (phone ~ '^[6-9]\d{9}$');

alter table public.profiles
  drop constraint if exists profiles_phone_unique;
alter table public.profiles
  add constraint profiles_phone_unique unique (phone);

-- Age, not date of birth — the app asks "how old are you", not for an
-- exact birthdate. "Current age" is derived, never stored: it's
-- age_at_signup + however many full years have passed since
-- created_at (see the app's currentAge() helper and README §3). That
-- means it can never go stale and there's no birthday to track, at
-- the cost of being accurate to the year of signup rather than the
-- exact day - fine for an 18+ gate, which only ever needs "is this
-- number at least 18", never a real age-verification-grade check.
alter table public.profiles
  drop constraint if exists profiles_age_18plus;
alter table public.profiles
  add constraint profiles_age_18plus check (age_at_signup >= 18 and age_at_signup < 120);

-- Auto-predict opt-in (added Aug 2026) — a handful of real, consenting users
-- who can't log in daily get their picks filled in by a bot instead. Off by
-- default for everyone; only flipped on explicitly per user_id, never by a
-- bulk/filtered update. risk_tier shapes how that bot weighs favorite vs
-- underdog picks against the user's leaderboard standing — see
-- app/auto-predict.ts. Nullable because it's meaningless for anyone with
-- auto_predict_enabled = false.
alter table public.profiles
  add column if not exists auto_predict_enabled boolean not null default false;
alter table public.profiles
  add column if not exists risk_tier text
    check (risk_tier in ('conservative', 'balanced', 'aggressive'));

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- No insert policy. The trigger below is the only writer.
revoke insert, delete on public.profiles from anon, authenticated;


-- Populate profiles from signup metadata, so the client never writes
-- to this table directly and can't forge someone else's row.
-- Phone format and 18+ are enforced here too (defense in depth — the
-- app validates both, but someone could call the signup API
-- directly). full_name gets a soft fallback instead of blocking
-- signup, since a missing name isn't a fraud/compliance concern the
-- way an invalid phone or under-18 signup is.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := trim(coalesce(new.raw_user_meta_data->>'phone', ''));
  v_age   int;
begin
  if v_phone !~ '^[6-9]\d{9}$' then
    raise exception 'A valid 10-digit Indian mobile number is required';
  end if;

  begin
    v_age := (new.raw_user_meta_data->>'age')::int;
  exception when others then
    raise exception 'A valid age is required';
  end;

  if v_age is null or v_age < 18 or v_age >= 120 then
    raise exception 'You must be 18 or older to register';
  end if;

  insert into public.profiles (id, full_name, phone, age_at_signup)
  values (
    new.id,
    coalesce(
      nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
      split_part(new.email, '@', 1),
      'Player'
    ),
    v_phone,
    v_age
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- profiles is self-only under RLS, so the app can't just SELECT to
-- check if a number is taken. Lets the signup form show "already
-- registered" immediately instead of surfacing the trigger's raw
-- unique-constraint error after the fact.

create or replace function public.phone_is_taken(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where phone = p);
$$;


-- ------------------------------------------------------------
-- 2. FIXTURES  (written only by the sync Edge Function)
-- ------------------------------------------------------------

create table if not exists public.fixtures (
  id          bigint primary key,            -- football-data.org match id
  matchday    int,
  kickoff_utc timestamptz not null,
  home_team   text not null,
  away_team   text not null,
  home_crest  text,
  away_crest  text,
  status      text not null,                 -- SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED | POSTPONED | SUSPENDED | CANCELLED
  home_score  int,
  away_score  int,
  home_odds   numeric,                       -- FINAL odds, frozen ~24h before kickoff, never touched again — see §4
  draw_odds   numeric,
  away_odds   numeric,
  preview_home_odds numeric,                 -- INDICATIVE odds, refreshed every few hours until the freeze above — see §4
  preview_draw_odds numeric,
  preview_away_odds numeric,
  preview_synced_at timestamptz,             -- throttles the preview refresh; never used for scoring
  synced_at   timestamptz not null default now()
);

-- `create table if not exists` above only creates these columns on a
-- brand-new project — it's a no-op against a table that already
-- existed before odds scoring was added, so an upgrade needs these
-- explicitly or set_fixture_odds() below fails with "column does not
-- exist". Harmless no-op on a fresh project where they're already
-- there from the CREATE TABLE.
alter table public.fixtures add column if not exists home_odds numeric;
alter table public.fixtures add column if not exists draw_odds numeric;
alter table public.fixtures add column if not exists away_odds numeric;
alter table public.fixtures add column if not exists preview_home_odds numeric;
alter table public.fixtures add column if not exists preview_draw_odds numeric;
alter table public.fixtures add column if not exists preview_away_odds numeric;
alter table public.fixtures add column if not exists preview_synced_at timestamptz;

create index if not exists fixtures_kickoff_idx  on public.fixtures (kickoff_utc);
create index if not exists fixtures_matchday_idx on public.fixtures (matchday);
create index if not exists fixtures_status_idx   on public.fixtures (status);

alter table public.fixtures enable row level security;

drop policy if exists "fixtures are public" on public.fixtures;
create policy "fixtures are public" on public.fixtures
  for select using (true);

-- No write policy + no write grant. The sync job uses the
-- service-role key, which bypasses RLS.
revoke insert, update, delete on public.fixtures from anon, authenticated;


-- Writer for the odds freeze — same reasoning as every other frozen-
-- value writer in this project's history: a partial-column upsert
-- fails against this table's NOT NULL columns, so this does a real
-- UPDATE instead. Deliberately NOT security definer — it inherits
-- the caller's own privileges, so even if EXECUTE were ever granted
-- to anon/authenticated by accident, the UPDATE inside would still
-- fail on the table-level revoke above. Only the service role
-- (Edge Function) can actually use this in practice.
create or replace function public.set_fixture_odds(rows jsonb)
returns void
language sql
as $$
  update public.fixtures f
  set home_odds = r.home_odds,
      draw_odds = r.draw_odds,
      away_odds = r.away_odds
  from jsonb_to_recordset(rows) as r(
    id bigint, home_odds numeric, draw_odds numeric, away_odds numeric
  )
  where f.id = r.id;
$$;


-- Writer for the INDICATIVE preview odds — same not-security-definer
-- reasoning as set_fixture_odds above (a table-level revoke on
-- fixtures protects this even though EXECUTE gets auto-granted to
-- anon/authenticated by Supabase's defaults). Unlike set_fixture_odds,
-- this is meant to be called repeatedly — every refresh cycle
-- overwrites the previous preview value — so there's no "only if
-- null" guard here; the caller (the sync Edge Function) decides when
-- a fixture is due for a refresh, not this function.
create or replace function public.set_fixture_preview_odds(rows jsonb)
returns void
language sql
as $$
  update public.fixtures f
  set preview_home_odds = r.home_odds,
      preview_draw_odds = r.draw_odds,
      preview_away_odds = r.away_odds,
      preview_synced_at = now()
  from jsonb_to_recordset(rows) as r(
    id bigint, home_odds numeric, draw_odds numeric, away_odds numeric
  )
  where f.id = r.id;
$$;


-- ------------------------------------------------------------
-- 3. PREDICTIONS  — a pick (H/D/A), not a scoreline
-- ------------------------------------------------------------

create table if not exists public.predictions (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  fixture_id bigint not null references public.fixtures(id) on delete cascade,
  pick       char(1) not null check (pick in ('H', 'D', 'A')),
  updated_at timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

-- source/auto_reasoning (added Aug 2026, alongside profiles.auto_predict_enabled
-- above) — every auto-predict write is tagged and carries what produced it
-- (odds snapshot, leaderboard rank, risk tier at write time) so a bot pick is
-- always auditable and distinguishable from one the player entered themselves.
-- auto-predict.ts only ever INSERTs a missing row (onConflict do-nothing) —
-- it must never flip an existing 'manual' row to 'auto'.
alter table public.predictions
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'auto'));
alter table public.predictions
  add column if not exists auto_reasoning jsonb;

create index if not exists predictions_fixture_idx on public.predictions (fixture_id);

alter table public.predictions enable row level security;

revoke delete on public.predictions from anon, authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists predictions_touch on public.predictions;
create trigger predictions_touch
  before insert or update on public.predictions
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
-- 4. THE PREDICTION LOCK  (enforced by RLS, not the browser)
--
-- Locks 2 hours before kickoff, not at kickoff — mainly to close off
-- picks made after starting lineups are typically confirmed. This is
-- now a SEPARATE timer from the odds freeze (revised 06 Aug 2026):
-- odds freeze 24 hours before kickoff (ODDS_FREEZE_HOURS in the Edge
-- Function), a full 22 hours before predictions actually close, so
-- players get a long, stable window to decide against a real, final
-- number instead of a 2-hour scramble. Between "odds available" and
-- "odds frozen", a fixture shows an indicative preview value instead
-- (preview_home_odds etc., refreshed every few hours, never used for
-- scoring) — see README §3 for the full reasoning on why an
-- unfrozen, clearly-marked estimate is preferable to either a fixed
-- flat number or no number at all for a fixture more than a day out.
-- ------------------------------------------------------------

create or replace function public.fixture_is_open(fid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.fixtures
    where id = fid
      and kickoff_utc - interval '2 hours' > now()
      and status in ('SCHEDULED', 'TIMED')
  );
$$;

drop policy if exists "insert own prediction before kickoff" on public.predictions;
create policy "insert own prediction before kickoff" on public.predictions
  for insert
  with check (auth.uid() = user_id and public.fixture_is_open(fixture_id));

drop policy if exists "update own prediction before kickoff" on public.predictions;
create policy "update own prediction before kickoff" on public.predictions
  for update
  using      (auth.uid() = user_id and public.fixture_is_open(fixture_id))
  with check (auth.uid() = user_id and public.fixture_is_open(fixture_id));

-- Own predictions always visible. Everyone else's only after kickoff,
-- so nobody can copy before the whistle.
drop policy if exists "read predictions" on public.predictions;
create policy "read predictions" on public.predictions
  for select using (
    auth.uid() = user_id
    or not public.fixture_is_open(fixture_id)
  );


-- ------------------------------------------------------------
-- 5. SCORING  (derived, never client-written) + ELIGIBILITY
--
-- Odds-based, revised 06 Aug 2026 from flat +5/+6 — see README §6 for
-- the full history (this project has now tried flat, standings-gap,
-- ClubElo-probability, and odds; each revision's reasoning is logged
-- there, read it before "simplifying" back to flat again).
--
--   correct pick, odds available   clamp(round(2 x odds), 4, 10)
--   correct pick, odds missing     6 for a draw, 5 for a win (flat)
--   wrong pick                     0
--
-- "Odds missing" covers two cases identically, on purpose: a fixture
-- more than 24 hours from kickoff (odds haven't been frozen yet - it
-- may still be showing a `~` preview on the frontend, but that's a
-- display-only value this function never sees) and a fixture where
-- the odds fetch genuinely failed. Same fallback, same column being
-- null either way — no separate "did the API error" flag needed.
--
-- The floor/ceiling of 4-10 (not a wider range) is a deliberate
-- choice, not the only valid one: at odds 2.5 a correct win scores
-- exactly 5, and at odds 3.0 a correct draw scores exactly 6 - both
-- match the old flat numbers exactly, so the new formula only
-- meaningfully diverges from the old one where the odds actually say
-- the pick was more or less obvious than a coin flip.
--
-- Eligibility is 75% of MATCHES, not gameweeks, on a ROLLING basis —
-- deliberately revised from an earlier fixed-38-gameweek version (see
-- README §5/§10 for why). matches_completed = however many fixtures
-- have actually reached FINISHED so far; matches_predicted = how many
-- of those this player had a prediction on. Both numbers grow together
-- as the season progresses, so eligibility reflects "am I currently
-- on pace" at any point in the season, not a number that's meaningless
-- until the season is nearly over.
--
-- Restricting both sides to status = 'FINISHED' does double duty:
-- it's the rolling window (only matches that have actually happened
-- count), AND it's what makes postponed/abandoned fixtures excluded
-- from the count automatically — they never reach FINISHED, so they
-- can never enter the denominator OR the numerator. No special-case
-- logic needed for that rule.
--
-- Before any match has finished, matches_completed = 0 and everyone
-- is treated as eligible (100%) rather than dividing by zero or
-- flagging players "not eligible" before there's any data.
-- ------------------------------------------------------------

drop view if exists public.leaderboard cascade;
drop function if exists public.get_leaderboard();
drop function if exists public.score(text, int, int);

create or replace function public.score(
  pick text, hs int, aws int,
  home_odds numeric, draw_odds numeric, away_odds numeric
)
returns int
language sql
immutable
as $$
  select case
    when pick is null or hs is null or aws is null then 0
    when pick <> (case when hs > aws then 'H' when hs < aws then 'A' else 'D' end) then 0
    when (case pick when 'H' then home_odds when 'D' then draw_odds when 'A' then away_odds end) is not null
      then least(greatest(
        round(2 * (case pick when 'H' then home_odds when 'D' then draw_odds when 'A' then away_odds end)),
        4), 10)::int
    when hs = aws then 6   -- correct draw, no odds on file — flat fallback
    else 5                 -- correct win, no odds on file — flat fallback
  end;
$$;


create or replace view public.leaderboard as
select
  p.id        as user_id,
  p.full_name,
  coalesce(sum(
    public.score(pr.pick, f.home_score, f.away_score, f.home_odds, f.draw_odds, f.away_odds)
  ), 0)::bigint as points,
  count(f.id) filter (
    where pr.pick = (case when f.home_score > f.away_score then 'H'
                          when f.home_score < f.away_score then 'A'
                          else 'D' end)
  )::bigint   as correct_picks,
  count(f.id)::bigint as matches_predicted,
  mc.matches_completed,
  case when mc.matches_completed = 0 then 100.0
       else round(count(f.id)::numeric / mc.matches_completed * 100, 1)
  end as participation_pct,
  case when mc.matches_completed = 0 then true
       else count(f.id)::numeric / mc.matches_completed >= 0.75
  end as eligible,
  rank() over (
    order by coalesce(sum(
      public.score(pr.pick, f.home_score, f.away_score, f.home_odds, f.draw_odds, f.away_odds)
    ), 0) desc
  )::bigint   as rank
from public.profiles p
left join public.predictions pr on pr.user_id = p.id
left join public.fixtures    f  on f.id = pr.fixture_id and f.status = 'FINISHED'
cross join (
  select count(*)::bigint as matches_completed
  from public.fixtures where status = 'FINISHED'
) mc
group by p.id, p.full_name, mc.matches_completed;


-- The view reads profiles, which is self-only under RLS, so a direct
-- select would return one row. Expose it through a definer function.
create or replace function public.get_leaderboard()
returns table (
  user_id           uuid,
  full_name         text,
  points            bigint,
  correct_picks     bigint,
  matches_predicted bigint,
  matches_completed bigint,
  participation_pct numeric,
  eligible          boolean,
  rank              bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.user_id, l.full_name, l.points, l.correct_picks,
         l.matches_predicted, l.matches_completed, l.participation_pct,
         l.eligible, l.rank
  from public.leaderboard l
  order by l.rank, l.full_name;
$$;


-- ------------------------------------------------------------
-- 6. SYNC HEALTH  (feeds the staleness banner in the app)
-- ------------------------------------------------------------

create or replace function public.sync_age_seconds()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    extract(epoch from (now() - max(synced_at)))::int,
    999999
  )
  from public.fixtures;
$$;


-- ------------------------------------------------------------
-- 7. REMINDERS  (daily, at most 300 emails/run — see README §11)
--
-- reminder_log dedups by (user_id, matchday): once someone's been
-- emailed about a gameweek, they're never emailed about it again,
-- regardless of how many days the batch takes to work through the
-- full candidate list. No RLS policies on purpose — this table holds
-- no data anyone (anon or authenticated) needs to read directly; only
-- the send-reminders Edge Function touches it, via the service role,
-- which bypasses RLS entirely.
-- ------------------------------------------------------------

create table if not exists public.reminder_log (
  user_id  uuid not null references auth.users(id) on delete cascade,
  matchday int  not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, matchday)
);

alter table public.reminder_log enable row level security;


-- Returns who to remind for a given gameweek: registered players who
-- haven't predicted any fixture in it yet, and haven't already been
-- sent a reminder for it. Joins auth.users for the email address,
-- which is why this is SECURITY DEFINER — and exactly why it must
-- NEVER be granted to anon/authenticated (see GRANTS below): it would
-- hand any logged-in user every pending player's email address.

create or replace function public.reminder_candidates(target_matchday int, batch_limit int default 300)
returns table (user_id uuid, email text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, u.email, p.full_name
  from public.profiles p
  join auth.users u on u.id = p.id
  where not p.auto_predict_enabled
  -- auto_predict_enabled added Aug 2026, after this function was first
  -- written — opted-in users never need this nudge (that's the whole
  -- point of opting in), and reminding them "you haven't predicted yet"
  -- right before the bot fills it in for them is actively confusing, not
  -- just redundant.
  and not exists (
    select 1 from public.predictions pr
    join public.fixtures fx on fx.id = pr.fixture_id
    where pr.user_id = p.id and fx.matchday = target_matchday
  )
  and not exists (
    select 1 from public.reminder_log rl
    where rl.user_id = p.id and rl.matchday = target_matchday
  )
  order by p.created_at
  limit batch_limit;
$$;


-- ------------------------------------------------------------
-- 8. GRANTS
--
-- IMPORTANT, found the hard way: Supabase's default project setup
-- grants EXECUTE on every new public-schema function directly to
-- `anon` AND `authenticated` (via ALTER DEFAULT PRIVILEGES set up
-- when the project was created) — separately from the PUBLIC
-- pseudo-role. `revoke ... from public` does NOT touch those direct
-- grants. A previous version of this file only revoked from public
-- and believed get_leaderboard() was authenticated-only; it was
-- actually callable by anon (fully unauthenticated) the whole time —
-- confirmed live with a real anon-key RPC call. Fixed by naming the
-- actual roles in every revoke below. If you add a new function here,
-- verify its real grants with:
--   select grantee, privilege_type from information_schema.routine_privileges
--   where routine_name = '<function>';
-- Don't trust the revoke statement alone — trust that query.
--
-- fixture_is_open is called from inside the RLS policies, which are
-- evaluated as the *invoking* role — anon and authenticated. Revoking
-- it breaks every prediction read/write with "permission denied for
-- function". Looks removable. It isn't.
--
-- handle_new_user and touch_updated_at are trigger-only — they should
-- never be callable directly by anyone, including authenticated.
-- Revoking their EXECUTE grants doesn't break the triggers themselves:
-- trigger execution doesn't go through the same privilege check as an
-- ad-hoc RPC call.
--
-- reminder_candidates is deliberately NOT granted to anon or
-- authenticated anywhere in this file. Only the service role (used by
-- the send-reminders Edge Function) can call it, and the service role
-- already has full access by default — no grant needed or wanted.
-- ------------------------------------------------------------

revoke all on public.leaderboard from anon, authenticated;

revoke execute on function public.get_leaderboard()           from public, anon, authenticated;
revoke execute on function public.handle_new_user()            from public, anon, authenticated;
revoke execute on function public.touch_updated_at()            from public, anon, authenticated;
revoke execute on function public.phone_is_taken(text)         from public, anon, authenticated;
revoke execute on function public.reminder_candidates(int, int) from public, anon, authenticated;

grant execute on function public.get_leaderboard()      to authenticated;
grant execute on function public.phone_is_taken(text)   to anon, authenticated;
grant execute on function public.fixture_is_open(bigint) to anon, authenticated;
grant execute on function public.sync_age_seconds()      to anon, authenticated;


-- ------------------------------------------------------------
-- Checks
-- ------------------------------------------------------------

-- select tablename from pg_tables where schemaname='public';
-- -- profiles, fixtures, predictions

-- select table_name, column_name from information_schema.columns
-- where table_schema='public' and column_name ilike '%password%';
-- -- 0 rows, always

-- select public.score('H', 2, 0, null, null, null);        -- expect 5  (no odds, flat fallback)
-- select public.score('D', 1, 1, null, null, null);        -- expect 6  (no odds, flat fallback)
-- select public.score('A', 2, 0, null, null, null);        -- expect 0  (wrong pick)
-- select public.score('H', 2, 0, 1.57, 4.0, 5.5);          -- expect 4  (favorite, floor)
-- select public.score('A', 0, 2, 1.57, 4.0, 5.5);          -- expect 10 (underdog upset, ceiling)
-- select public.score('D', 1, 1, 1.57, 4.0, 5.5);          -- expect 8  (correct draw, odds-based)
-- select public.score('H', 2, 0, 2.5, 3.0, 3.0);           -- expect 5  (odds=2.5 exactly matches flat)

-- select * from get_leaderboard();
-- -- expect matches_predicted/matches_completed/participation_pct/eligible present

-- select column_name from information_schema.columns
-- where table_schema='public' and table_name='fixtures' and column_name like 'preview%';
-- -- preview_home_odds, preview_draw_odds, preview_away_odds, preview_synced_at

-- select grantee, privilege_type from information_schema.routine_privileges
-- where routine_name = 'set_fixture_preview_odds';
-- -- anon/authenticated will show EXECUTE (Supabase's default grant) - that's expected and
-- -- safe, since the UPDATE inside still needs table-level UPDATE on fixtures, which is
-- -- revoked from anon/authenticated. Confirm with a real anon-key RPC call if in doubt,
-- -- same as set_fixture_odds - never trust the grant list alone, see §8.
