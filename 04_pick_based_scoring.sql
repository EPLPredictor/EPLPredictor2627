-- ============================================================
-- EPL Predictor — Phase 4: Win/Draw/Loss picks, standings-gap scoring
--
-- Run AFTER 01_schema.sql and 03_phone_required.sql, and AFTER
-- deploying the updated sync-fixtures function (it needs to have run
-- at least once so home_position/away_position aren't all null).
-- ============================================================


-- ------------------------------------------------------------
-- 1. Fixtures gain a frozen table-position snapshot
--
-- Populated by the sync job only while a fixture is SCHEDULED/TIMED.
-- Once a match starts, the sync job stops touching these two columns,
-- so the gap used in scoring reflects the table "as of just before
-- kickoff" rather than whatever the table looks like today.
-- ------------------------------------------------------------

alter table public.fixtures add column if not exists home_position int;
alter table public.fixtures add column if not exists away_position int;
alter table public.fixtures add column if not exists home_points   int;
alter table public.fixtures add column if not exists away_points   int;


-- ------------------------------------------------------------
-- 2. Predictions store a pick, not a scoreline
--
-- Existing rows are numeric-scoreline shaped and incompatible with the
-- new format — wipe them. Pre-launch only.
--
-- The old `leaderboard` view and `get_leaderboard()` function both
-- reference home_score/away_score (view) or the old column shape
-- (function's RETURNS TABLE), so both must be dropped before the
-- column changes below — "create or replace" can't rename/remove a
-- column from either one, only append.
-- ------------------------------------------------------------

drop view if exists public.leaderboard cascade;
drop function if exists public.get_leaderboard();

truncate table public.predictions;

alter table public.predictions drop constraint if exists predictions_home_score_check;
alter table public.predictions drop constraint if exists predictions_away_score_check;
alter table public.predictions drop column if exists home_score;
alter table public.predictions drop column if exists away_score;

alter table public.predictions add column if not exists pick char(1);
alter table public.predictions alter column pick set not null;
alter table public.predictions drop constraint if exists predictions_pick_check;
alter table public.predictions add constraint predictions_pick_check
  check (pick in ('H', 'D', 'A'));   -- Home win / Draw / Away win

-- RLS policies on predictions reference only user_id/fixture_id via
-- fixture_is_open() — nothing to change there.


-- ------------------------------------------------------------
-- 3. Scoring — replaces the old exact/outcome/close-goals score()
--
--   correct draw pick                          6
--   correct win pick, favourite won as expected 3
--   correct win pick, upset (lower-ranked won)  3 + half the position
--                                                gap, capped at 15
--   no standings frozen yet (very early season) 5 flat, for a correct
--                                                win pick
--   wrong pick                                  0
-- ------------------------------------------------------------

drop function if exists public.score(int, int, int, int);

create or replace function public.score(
  pick text, hs int, aws int, hpos int, apos int
) returns int
language sql
immutable
as $$
  select case
    when pick is null or hs is null or aws is null then 0
    -- wrong pick
    when pick <> (case when hs > aws then 'H' when hs < aws then 'A' else 'D' end) then 0
    -- correct draw
    when hs = aws then 6
    -- correct win, standings not frozen yet
    when hpos is null or apos is null then 5
    -- correct win: winner_pos/loser_pos by which side actually won
    else (
      3 + least(
        greatest(
          -- positive gap = upset (winner ranked worse than loser)
          (case when hs > aws then hpos - apos else apos - hpos end),
          0
        ) / 2,
        12
      )
    )::int
  end;
$$;


create or replace view public.leaderboard as
select
  p.id        as user_id,
  p.full_name,
  coalesce(sum(
    public.score(pr.pick, f.home_score, f.away_score, f.home_position, f.away_position)
  ), 0)::bigint as points,
  count(f.id) filter (
    where pr.pick = (case when f.home_score > f.away_score then 'H'
                          when f.home_score < f.away_score then 'A'
                          else 'D' end)
  )::bigint   as correct_picks,
  count(f.id)::bigint as played,
  rank() over (
    order by coalesce(sum(
      public.score(pr.pick, f.home_score, f.away_score, f.home_position, f.away_position)
    ), 0) desc
  )::bigint   as rank
from public.profiles p
left join public.predictions pr on pr.user_id = p.id
left join public.fixtures    f  on f.id = pr.fixture_id and f.status = 'FINISHED'
group by p.id, p.full_name;


create or replace function public.get_leaderboard()
returns table (
  user_id       uuid,
  full_name     text,
  points        bigint,
  correct_picks bigint,
  played        bigint,
  rank          bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.user_id, l.full_name, l.points, l.correct_picks, l.played, l.rank
  from public.leaderboard l
  order by l.rank, l.full_name;
$$;

revoke all on function public.get_leaderboard() from public;
grant execute on function public.get_leaderboard() to authenticated;


-- ------------------------------------------------------------
-- Check
-- ------------------------------------------------------------

-- select column_name from information_schema.columns
-- where table_schema='public' and table_name='predictions';
-- expect: user_id, fixture_id, pick, updated_at — no home_score/away_score

-- select public.score('H', 3, 1, 5, 18);   -- home win, home ranked much better  -> 3
-- select public.score('H', 1, 0, 18, 2);   -- home win, home is the underdog     -> 3 + gap/2, capped 15
-- select public.score('D', 1, 1, 5, 5);    -- correct draw                       -> 6
-- select public.score('A', 3, 1, 5, 18);   -- wrong pick                         -> 0
