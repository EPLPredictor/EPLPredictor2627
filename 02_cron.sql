-- ============================================================
-- EPL Predictor — Step 6: schedule the fixture sync
--
-- Run AFTER the sync-fixtures function is deployed and tested.
-- Replace the three <placeholders> below first.
--
-- Revision 2: the function URL now uses the documented form
--   https://<ref>.supabase.co/functions/v1/<name>
-- Revision 1 used https://<ref>.functions.supabase.co/<name>, which
-- may not resolve. Copy the exact URL from the Edge Functions page
-- in the dashboard rather than assembling it by hand.
--
-- If CREATE EXTENSION errors on permissions, enable pg_cron and
-- pg_net from Dashboard -> Database -> Extensions instead, then
-- re-run from the cron.schedule block.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- Remove any previous version of the job before rescheduling.
select cron.unschedule('sync-fixtures')
where exists (select 1 from cron.job where jobname = 'sync-fixtures');


select cron.schedule(
  'sync-fixtures',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://iwqqwcwxqfpcebnjpbqr.supabase.co/functions/v1/sync-fixtures',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'Authorization',  'Bearer sb_publishable_Fd2ijqNtrsPr62ArsS9TGg_xKThWmzs',
                 'x-sync-secret',  '7d4f9c2a8b1e6f53c9a7d0be4f1a93c7e82b5d1f6a4c9e31'
               ),
    timeout_milliseconds := 20000
  );
  $$
);


-- ------------------------------------------------------------
-- Checks
-- ------------------------------------------------------------

-- Is the job registered?
--   select jobid, jobname, schedule, active from cron.job;

-- Did the last few runs succeed?
--   select runid, status, return_message, start_time
--   from cron.job_run_details
--   where jobname = 'sync-fixtures'
--   order by start_time desc limit 10;

-- net.http_post returns immediately with a request id; the real
-- HTTP result lands here a moment later:
--   select id, status_code, content_type, timed_out, error_msg, created
--   from net._http_response order by created desc limit 5;

-- Did fixtures actually land?
--   select count(*) as fixtures, max(synced_at) as last_sync from public.fixtures;
--   select public.sync_age_seconds();      -- should stay under ~360

-- Pause without deleting:
--   update cron.job set active = false where jobname = 'sync-fixtures';
