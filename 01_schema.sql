-- ============================================================
-- EPL Predictor — Phase 1: schema, RLS, lock, scoring
-- Run this whole file once in the Supabase SQL editor.
-- Safe to re-run: everything is idempotent.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PROFILES  (hangs off auth.users — no password column, ever)
-- ------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  phone      text,
  address    text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- No insert policy. The trigger below is the only writer.
revoke insert, delete on public.profiles from anon, authenticated;


-- Populate profiles from signup metadata, so the client never
-- writes to this table and can't forge someone else's row.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, address)
  values (
    new.id,
    -- full_name is NOT NULL. Never let a missing name fail the
    -- auth.users insert — that surfaces as an opaque 500 at signup.
    coalesce(
      nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
      split_part(new.email, '@', 1),
      'Player'
    ),
    nullif(trim(coalesce(new.raw_user_meta_data->>'phone',   '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'address', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ------------------------------------------------------------
-- 2. FIXTURES  (written only by the sync job in Phase 2)
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
  synced_at   timestamptz not null default now()
);

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


-- ------------------------------------------------------------
-- 3. PREDICTIONS
-- ------------------------------------------------------------

create table if not exists public.predictions (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  fixture_id bigint not null references public.fixtures(id) on delete cascade,
  home_score int    not null check (home_score between 0 and 20),
  away_score int    not null check (away_score between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

create index if not exists predictions_fixture_idx on public.predictions (fixture_id);

alter table public.predictions enable row level security;

revoke delete on public.predictions from anon, authenticated;


-- Touch updated_at on every write.
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
-- 4. THE KICKOFF LOCK  (brief §4.2 — enforced here, not in the browser)
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
      and kickoff_utc > now()
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
-- 5. SCORING  (brief §4.3 — derived, never client-written)
-- ------------------------------------------------------------

create or replace function public.score(ph int, pa int, ah int, aa int)
returns int
language sql
immutable
as $$
  select case
    when ph is null or pa is null or ah is null or aa is null then 0
    when ph = ah and pa = aa                        then 10   -- exact scoreline
    when sign(ph - pa) = sign(ah - aa)              then 5    -- right outcome
    when abs(ph - ah) <= 1 and abs(pa - aa) <= 1    then 2    -- within one goal each side
    else 0
  end;
$$;


create or replace view public.leaderboard as
select
  p.id        as user_id,
  p.full_name,
  coalesce(sum(public.score(pr.home_score, pr.away_score, f.home_score, f.away_score)), 0)::bigint as points,
  count(f.id) filter (
    where pr.home_score = f.home_score and pr.away_score = f.away_score
  )::bigint   as exact_hits,
  count(f.id)::bigint as played,
  rank() over (
    order by coalesce(sum(public.score(pr.home_score, pr.away_score, f.home_score, f.away_score)), 0) desc
  )::bigint   as rank
from public.profiles p
left join public.predictions pr on pr.user_id = p.id
left join public.fixtures    f  on f.id = pr.fixture_id and f.status = 'FINISHED'
group by p.id, p.full_name;


-- The view reads profiles, which is self-only under RLS, so a direct
-- select would return one row. Expose it through a definer function.
create or replace function public.get_leaderboard()
returns table (
  user_id    uuid,
  full_name  text,
  points     bigint,
  exact_hits bigint,
  played     bigint,
  rank       bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.user_id, l.full_name, l.points, l.exact_hits, l.played, l.rank
  from public.leaderboard l
  order by l.rank, l.full_name;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, so revoking
-- from `anon` alone leaves it wide open. Revoke from PUBLIC, then grant.
revoke all on public.leaderboard from anon, authenticated;
revoke all on function public.get_leaderboard() from public;
grant execute on function public.get_leaderboard() to authenticated;

-- Trigger functions should not be callable directly.
revoke all on function public.handle_new_user()  from public;
revoke all on function public.touch_updated_at() from public;

-- fixture_is_open is called from inside the RLS policies, which are
-- evaluated as the *invoking* role. Revoking this would make every
-- prediction read and write fail with "permission denied for function".
grant execute on function public.fixture_is_open(bigint) to anon, authenticated;


-- ------------------------------------------------------------
-- 6. SYNC HEALTH  (feeds the staleness banner — brief §6)
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

grant execute on function public.sync_age_seconds() to anon, authenticated;
