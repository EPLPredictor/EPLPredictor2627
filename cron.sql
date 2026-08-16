-- ============================================================
-- EPL Predictor — schedule the fixture sync + reminder emails
--
-- Run AFTER the Edge Functions are deployed and secrets are set (see
-- README.md's deployment steps). Replace the <placeholders> below
-- with real values FROM THE DASHBOARD before running — then run the
-- filled-in version directly in the SQL editor. Do not commit the
-- filled-in version: this file is a template on purpose, so a real
-- secret never ends up in git history again (see README §5's row
-- about the SYNC_SECRET that did, once).
--
-- If CREATE EXTENSION errors on permissions, enable pg_cron and
-- pg_net from Dashboard -> Database -> Extensions instead, then
-- re-run from the cron.schedule blocks.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ------------------------------------------------------------
-- Fixture sync — every 5 minutes
-- ------------------------------------------------------------

select cron.unschedule('sync-fixtures')
where exists (select 1 from cron.job where jobname = 'sync-fixtures');

select cron.schedule(
  'sync-fixtures',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/sync-fixtures',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'Authorization',  'Bearer <anon-key>',
                 'x-sync-secret',  '<sync-secret>'
               ),
    timeout_milliseconds := 20000
  );
  $$
);


-- ------------------------------------------------------------
-- Reminder emails — once daily at 18:25 UTC (23:55 IST), 5 minutes
-- before Brevo's free-plan daily send quota resets at midnight IST
-- (confirmed with Brevo support 13 Aug 2026 — reset follows the
-- account's configured timezone, Asia/Kolkata). send-reminders.ts
-- reads Brevo's live remaining quota at call time and only sends that
-- many, so OTP emails (same Brevo account/quota, different send path)
-- always get first claim on the day's allowance. If the timezone
-- offset from UTC ever needs recalculating, IST has no DST, so this
-- schedule doesn't drift with seasons.
-- ------------------------------------------------------------

select cron.unschedule('send-reminders')
where exists (select 1 from cron.job where jobname = 'send-reminders');

select cron.schedule(
  'send-reminders',
  '25 18 * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'Authorization',     'Bearer <anon-key>',
                 'x-reminder-secret', '<reminder-secret>'
               ),
    timeout_milliseconds := 60000
  );
  $$
);


-- ------------------------------------------------------------
-- Auto-predict — every 3 hours. Not once daily: a gameweek's fixtures
-- kick off across several different days/times, each locking
-- independently 2 hours before its own kickoff, so this needs to run
-- often enough that no single fixture's lock sneaks up on it. It only
-- ever acts on fixtures whose FINAL odds are already frozen (see
-- auto-predict.ts header), so running this more often than odds
-- actually change is harmless — most runs just find nothing new to do.
-- ------------------------------------------------------------

select cron.unschedule('auto-predict')
where exists (select 1 from cron.job where jobname = 'auto-predict');

select cron.schedule(
  'auto-predict',
  '0 */3 * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/auto-predict',
    headers := jsonb_build_object(
                 'Content-Type',        'application/json',
                 'Authorization',       'Bearer <anon-key>',
                 'x-autopredict-secret', '<autopredict-secret>'
               ),
    timeout_milliseconds := 30000
  );
  $$
);


-- ------------------------------------------------------------
-- Checks
-- ------------------------------------------------------------

-- Is a job registered?
--   select jobid, jobname, schedule, active from cron.job;

-- Did the last few runs succeed? cron.job_run_details has no jobname
-- column of its own (only jobid) - join to cron.job to filter by name.
--   select j.jobname, jrd.status, jrd.return_message, jrd.start_time
--   from cron.job_run_details jrd
--   join cron.job j on j.jobid = jrd.jobid
--   where j.jobname = 'sync-fixtures'        -- or 'send-reminders'
--   order by jrd.start_time desc limit 10;

-- net.http_post returns immediately with a request id; the real
-- HTTP result lands here a moment later:
--   select id, status_code, content_type, timed_out, error_msg, created
--   from net._http_response order by created desc limit 5;

-- Did fixtures actually land?
--   select count(*) as fixtures, max(synced_at) as last_sync from public.fixtures;
--   select public.sync_age_seconds();      -- should stay under ~360

-- How many reminders have gone out, and for which gameweek?
--   select matchday, count(*) from public.reminder_log group by matchday order by 1;

-- How many auto picks exist, and for whom?
--   select user_id, count(*) from public.predictions where source = 'auto' group by user_id;

-- Pause a job without deleting it:
--   update cron.job set active = false where jobname = 'sync-fixtures';  -- or 'send-reminders', or 'auto-predict'
