-- ============================================================
-- EPL Predictor — Phase 7: flat scoring, 18+ gate, participation tracking
--
-- Run AFTER 06_clubelo_probability_scoring.sql.
--
-- Three unrelated changes bundled because they all touch the same
-- objects (profiles, leaderboard, score):
--   1. Scoring reverts to flat +5/+6/0 — matches the published rules
--      doc, not the dynamic ClubElo/standings system from Phase 6.
--      (Phase 6's fixture columns and sync logic are left in place,
--      just unused by score() now — cheap to revive later if wanted.)
--   2. profiles gains a mandatory date-of-birth, enforced 18+ both in
--      the app and in the signup trigger (same pattern as phone).
--   3. Participation/eligibility per the 75% rule: a player must have
--      predicted at least one fixture in 29 of the season's 38
--      gameweeks (fixed denominator, not adjusted for late signups —
--      confirmed with the person, see HANDOVER §12 rev 7).
-- ============================================================


-- ------------------------------------------------------------
-- 0. Clear existing test accounts
--
-- Pre-launch only. dob will become NOT NULL below and no existing
-- test account has one — deleting from auth.users cascades to
-- profiles/predictions via their FK "on delete cascade" clauses,
-- same as the phone migration.
-- ------------------------------------------------------------

delete from auth.users;


-- ------------------------------------------------------------
-- 1. Date of birth — mandatory, 18+ enforced
-- ------------------------------------------------------------

alter table public.profiles add column if not exists dob date;
alter table public.profiles alter column dob set not null;

alter table public.profiles drop constraint if exists profiles_dob_18plus;
alter table public.profiles add constraint profiles_dob_18plus
  check (dob <= (current_date - interval '18 years'));


-- ------------------------------------------------------------
-- 2. Signup trigger enforces the same 18+ rule
--
-- Defense in depth — someone could call the signup API directly,
-- bypassing the app's own date-of-birth check. Same reasoning as the
-- phone format check in 03_phone_required.sql: this SHOULD block
-- signup if invalid, unlike full_name's soft-fallback.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := trim(coalesce(new.raw_user_meta_data->>'phone', ''));
  v_dob   date;
begin
  if v_phone !~ '^[6-9]\d{9}$' then
    raise exception 'A valid 10-digit Indian mobile number is required';
  end if;

  begin
    v_dob := (new.raw_user_meta_data->>'dob')::date;
  exception when others then
    raise exception 'A valid date of birth is required';
  end;

  if v_dob is null or v_dob > (current_date - interval '18 years') then
    raise exception 'You must be 18 or older to register';
  end if;

  insert into public.profiles (id, full_name, phone, dob)
  values (
    new.id,
    coalesce(
      nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
      split_part(new.email, '@', 1),
      'Player'
    ),
    v_phone,
    v_dob
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- ------------------------------------------------------------
-- 3. Scoring reverts to flat +5 / +6 / 0
--
-- Drop the view/RPC first — both depend on the old score() signature,
-- same reasoning as every prior scoring migration in this project.
-- ------------------------------------------------------------

drop view if exists public.leaderboard cascade;
drop function if exists public.get_leaderboard();
drop function if exists public.score(text, int, int, numeric, numeric, numeric, int, int);

create or replace function public.score(pick text, hs int, aws int)
returns int
language sql
immutable
as $$
  select case
    when pick is null or hs is null or aws is null then 0
    when pick <> (case when hs > aws then 'H' when hs < aws then 'A' else 'D' end) then 0
    when hs = aws then 6   -- correct draw
    else 5                 -- correct win (home or away)
  end;
$$;


-- ------------------------------------------------------------
-- 4. Participation & eligibility (the 75% rule)
--
-- TOTAL_GAMEWEEKS is hardcoded at 38 (the full PL season) rather than
-- computed from distinct matchdays in `fixtures`, so a sync hiccup or
-- a postponed-and-rescheduled fixture can't quietly shrink the
-- denominator mid-season.
--
-- "Predicted a gameweek" = at least one prediction row exists for a
-- fixture in that matchday. The kickoff-lock RLS already guarantees
-- any such row was submitted before that fixture locked, so no extra
-- timing check is needed here.
-- ------------------------------------------------------------

create or replace view public.leaderboard as
select
  p.id        as user_id,
  p.full_name,
  coalesce(sum(
    public.score(pr.pick, f.home_score, f.away_score)
  ), 0)::bigint as points,
  count(f.id) filter (
    where pr.pick = (case when f.home_score > f.away_score then 'H'
                          when f.home_score < f.away_score then 'A'
                          else 'D' end)
  )::bigint   as correct_picks,
  count(f.id)::bigint as played,
  coalesce(gw.participation_gameweeks, 0)::bigint as participation_gameweeks,
  38::bigint as total_gameweeks,
  round(coalesce(gw.participation_gameweeks, 0)::numeric / 38 * 100, 1) as participation_pct,
  coalesce(gw.participation_gameweeks, 0) >= 29 as eligible,
  rank() over (
    order by coalesce(sum(
      public.score(pr.pick, f.home_score, f.away_score)
    ), 0) desc
  )::bigint   as rank
from public.profiles p
left join public.predictions pr on pr.user_id = p.id
left join public.fixtures    f  on f.id = pr.fixture_id and f.status = 'FINISHED'
left join (
  select pr2.user_id, count(distinct fx.matchday) as participation_gameweeks
  from public.predictions pr2
  join public.fixtures fx on fx.id = pr2.fixture_id
  group by pr2.user_id
) gw on gw.user_id = p.id
group by p.id, p.full_name, gw.participation_gameweeks;


create or replace function public.get_leaderboard()
returns table (
  user_id                 uuid,
  full_name               text,
  points                  bigint,
  correct_picks           bigint,
  played                  bigint,
  participation_gameweeks bigint,
  total_gameweeks         bigint,
  participation_pct       numeric,
  eligible                boolean,
  rank                    bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.user_id, l.full_name, l.points, l.correct_picks, l.played,
         l.participation_gameweeks, l.total_gameweeks, l.participation_pct,
         l.eligible, l.rank
  from public.leaderboard l
  order by l.rank, l.full_name;
$$;

revoke all on function public.get_leaderboard() from public;
grant execute on function public.get_leaderboard() to authenticated;


-- ------------------------------------------------------------
-- Check
-- ------------------------------------------------------------

-- select public.score('H', 2, 0);  -- expect 5
-- select public.score('D', 1, 1);  -- expect 6
-- select public.score('A', 2, 0);  -- expect 0 (wrong pick)

-- select column_name, is_nullable from information_schema.columns
-- where table_schema='public' and table_name='profiles';
-- expect dob is_nullable = 'NO'

-- select * from get_leaderboard();
-- expect participation_gameweeks/total_gameweeks/participation_pct/eligible present
