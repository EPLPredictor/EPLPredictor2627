-- ============================================================
-- EPL Predictor — Phase 5: fix the standings-position writer
--
-- The sync function's original approach (a partial-column `upsert`
-- with just {id, home_position, away_position, ...}) fails, because
-- Postgres validates the INSERT branch of ON CONFLICT DO UPDATE
-- against every NOT NULL column on the table — kickoff_utc, home_team,
-- etc. — even though the intent was only ever to UPDATE, never INSERT
-- a new row. This function does a real UPDATE instead, so only the
-- four position/points columns are ever touched.
-- ============================================================

create or replace function public.set_fixture_positions(rows jsonb)
returns void
language sql
as $$
  update public.fixtures f
  set home_position = r.home_position,
      away_position = r.away_position,
      home_points   = r.home_points,
      away_points   = r.away_points
  from jsonb_to_recordset(rows) as r(
    id bigint, home_position int, away_position int, home_points int, away_points int
  )
  where f.id = r.id;
$$;

-- Only ever called by the sync Edge Function using the service-role key,
-- which already bypasses RLS and has full table privileges — no grants
-- needed for anon/authenticated here, and none should be added.
