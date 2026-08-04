-- ============================================================
-- EPL Predictor — Phase 3: mandatory Indian mobile number, drop address
--
-- Run this whole file once in the Supabase SQL editor, AFTER deploying
-- the updated epl-predictor.html that sends `phone` and no `address`.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Clear existing test accounts
--
-- Pre-launch only — do not run this once real users have signed up.
-- Deleting from auth.users cascades to public.profiles and
-- public.predictions via their "on delete cascade" foreign keys,
-- so this fully resets signups without leaving orphaned rows.
-- ------------------------------------------------------------

delete from auth.users;


-- ------------------------------------------------------------
-- 1. Drop address — never used
-- ------------------------------------------------------------

alter table public.profiles drop column if exists address;


-- ------------------------------------------------------------
-- 2. Phone becomes mandatory, format-checked, unique
--
-- Indian mobile numbers: exactly 10 digits, first digit 6-9.
-- This is a FORMAT check only — it rejects obviously fake input,
-- it does not verify the number actually receives SMS.
-- ------------------------------------------------------------

alter table public.profiles
  alter column phone set not null;

alter table public.profiles
  drop constraint if exists profiles_phone_format;
alter table public.profiles
  add constraint profiles_phone_format check (phone ~ '^[6-9]\d{9}$');

alter table public.profiles
  drop constraint if exists profiles_phone_unique;
alter table public.profiles
  add constraint profiles_phone_unique unique (phone);


-- ------------------------------------------------------------
-- 3. Enforce the same rule inside the signup trigger too
--
-- Defense in depth: someone could call the Supabase signup API
-- directly, bypassing the app's own client-side validation. If the
-- phone is missing or badly formed, the whole signup fails cleanly
-- with a message, instead of silently creating a broken profile —
-- unlike full_name, a missing/invalid phone here should block signup.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := trim(coalesce(new.raw_user_meta_data->>'phone', ''));
begin
  if v_phone !~ '^[6-9]\d{9}$' then
    raise exception 'A valid 10-digit Indian mobile number is required';
  end if;

  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(
      nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
      split_part(new.email, '@', 1),
      'Player'
    ),
    v_phone
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- ------------------------------------------------------------
-- 4. Pre-signup availability check
--
-- profiles is self-only under RLS, so the app can't just SELECT to
-- see if a number is taken. This lets the signup form show "already
-- registered" immediately, rather than surfacing the trigger's raw
-- unique-constraint error after the fact.
-- ------------------------------------------------------------

create or replace function public.phone_is_taken(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where phone = p);
$$;

revoke all on function public.phone_is_taken(text) from public;
grant execute on function public.phone_is_taken(text) to anon, authenticated;


-- ------------------------------------------------------------
-- Check
-- ------------------------------------------------------------

-- select column_name, is_nullable from information_schema.columns
-- where table_schema='public' and table_name='profiles';
-- expect: id/full_name/phone not-null, no address column at all

-- select conname from pg_constraint where conrelid = 'public.profiles'::regclass;
-- expect: profiles_phone_format, profiles_phone_unique among the results
