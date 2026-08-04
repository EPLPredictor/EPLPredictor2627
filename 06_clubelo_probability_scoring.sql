-- ============================================================
-- EPL Predictor — Phase 6: ClubElo probability scoring
--
-- Run AFTER 04_pick_based_scoring.sql and 05_set_fixture_positions.sql.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Fixtures gain a locked pre-match probability snapshot
--
-- Populated by the sync job only once a fixture is within ~2 hours of
-- kickoff (the "lock window") — not earlier, so the number reflects a
-- near-final Elo picture rather than one from days out. Once written,
-- never touched again by the same freeze pattern as home_position.
-- ------------------------------------------------------------

alter table public.fixtures add column if not exists home_win_prob numeric;
alter table public.fixtures add column if not exists draw_prob     numeric;
alter table public.fixtures add column if not exists away_win_prob numeric;


-- ------------------------------------------------------------
-- 2. Writer function — same reasoning as set_fixture_positions:
-- a partial-column upsert fails against NOT NULL columns elsewhere on
-- the table, so this does a real UPDATE instead.
-- ------------------------------------------------------------

create or replace function public.set_fixture_probabilities(rows jsonb)
returns void
language sql
as $$
  update public.fixtures f
  set home_win_prob = r.home_win_prob,
      draw_prob     = r.draw_prob,
      away_win_prob = r.away_win_prob
  from jsonb_to_recordset(rows) as r(
    id bigint, home_win_prob numeric, draw_prob numeric, away_win_prob numeric
  )
  where f.id = r.id;
$$;

-- Only ever called by the sync Edge Function using the service-role key.


-- ------------------------------------------------------------
-- 3. Scoring — layered fallback, best data available wins
--
--   1. Locked ClubElo probability for the pick   → 2 ÷ probability,
--                                                   clamped to [3, 15]
--   2. No probability, but table position known  → old standings-gap
--                                                   formula (§9 in v5)
--   3. Neither available                          → flat 5 (win) / 6 (draw)
--   wrong pick always                             → 0
--
-- Deliberately NOT rounded — points are cumulative across a season, so
-- rounding each match's score before summing would distort the total
-- in a way that compounds. Only round for on-screen display, never in
-- the calculation itself.
--
-- The view and get_leaderboard() both depend on the old score()
-- signature, so both must be dropped before score() itself can be
-- dropped/recreated — same reasoning as the address/phone migration.
-- ------------------------------------------------------------

drop view if exists public.leaderboard cascade;
drop function if exists public.get_leaderboard();
drop function if exists public.score(text, int, int, int, int);

create or replace function public.score(
  pick text, hs int, aws int,
  hwp numeric, dp numeric, awp numeric,
  hpos int, apos int
) returns numeric
language sql
immutable
as $$
  select case
    when pick is null or hs is null or aws is null then 0
    when pick <> (case when hs > aws then 'H' when hs < aws then 'A' else 'D' end) then 0

    -- layer 1: locked ClubElo probability for the side that was picked
    when (case pick when 'H' then hwp when 'D' then dp when 'A' then awp end) is not null
     and (case pick when 'H' then hwp when 'D' then dp when 'A' then awp end) > 0
    then least(
      greatest(2.0 / (case pick when 'H' then hwp when 'D' then dp when 'A' then awp end), 3),
      15
    )

    -- layer 2: standings-gap fallback
    when hs = aws then 6   -- correct draw, no probability data
    when hpos is null or apos is null then 5   -- correct win, no data at all
    else (
      3 + least(
        greatest(
          (case when hs > aws then hpos - apos else apos - hpos end),
          0
        ) / 2,
        12
      )
    )
  end;
$$;


create or replace view public.leaderboard as
select
  p.id        as user_id,
  p.full_name,
  coalesce(sum(
    public.score(pr.pick, f.home_score, f.away_score,
                 f.home_win_prob, f.draw_prob, f.away_win_prob,
                 f.home_position, f.away_position)
  ), 0)::numeric as points,
  count(f.id) filter (
    where pr.pick = (case when f.home_score > f.away_score then 'H'
                          when f.home_score < f.away_score then 'A'
                          else 'D' end)
  )::bigint   as correct_picks,
  count(f.id)::bigint as played,
  rank() over (
    order by coalesce(sum(
      public.score(pr.pick, f.home_score, f.away_score,
                   f.home_win_prob, f.draw_prob, f.away_win_prob,
                   f.home_position, f.away_position)
    ), 0) desc
  )::bigint   as rank
from public.profiles p
left join public.predictions pr on pr.user_id = p.id
left join public.fixtures    f  on f.id = pr.fixture_id and f.status = 'FINISHED'
group by p.id, p.full_name;


drop function if exists public.get_leaderboard();

create or replace function public.get_leaderboard()
returns table (
  user_id       uuid,
  full_name     text,
  points        numeric,
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

-- select public.score('H', 2, 0, 0.65, 0.22, 0.13, null, null);  -- favourite win, probability path -> 2/0.65 ≈ 3.08
-- select public.score('A', 0, 2, 0.65, 0.22, 0.13, null, null);  -- huge upset, probability path -> 2/0.13 ≈ 15.38, capped at 15
-- select public.score('D', 1, 1, 0.4, 0.3, 0.3, null, null);     -- draw, probability path -> 2/0.3 ≈ 6.67
-- select public.score('H', 2, 0, null, null, null, 3, 15);        -- no probability, gap fallback
-- select public.score('A', 0, 2, null, null, null, 3, 15);        -- no probability, no position -> falls to flat 5 (wait: hpos/apos ARE given here, so gap path applies)
