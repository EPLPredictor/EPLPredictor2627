-- ============================================================
-- EPL Predictor — schedule the fixture sync
--
-- Run AFTER sync-fixtures is deployed and secrets are set (see
-- README.md's deployment steps). Replace the three <placeholders>
-- below with real values FROM THE DASHBOARD before running — then
-- run the filled-in version directly in the SQL editor. Do not
-- commit the filled-in version: this file is a template on purpose,
-- so a real SYNC_SECRET never ends up in git history again.
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
-- Checks
-- ------------------------------------------------------------

-- Is the job registered?
--   select jobid, jobname, schedule, active from cron.job;

-- Did the last few runs succeed? cron.job_run_details has no jobname
-- column of its own (only jobid) - join to cron.job to filter by name.
--   select j.jobname, jrd.status, jrd.return_message, jrd.start_time
--   from cron.job_run_details jrd
--   join cron.job j on j.jobid = jrd.jobid
--   where j.jobname = 'sync-fixtures'
--   order by jrd.start_time desc limit 10;

-- net.http_post returns immediately with a request id; the real
-- HTTP result lands here a moment later:
--   select id, status_code, content_type, timed_out, error_msg, created
--   from net._http_response order by created desc limit 5;

-- Did fixtures actually land?
--   select count(*) as fixtures, max(synced_at) as last_sync from public.fixtures;
--   select public.sync_age_seconds();      -- should stay under ~360

-- Pause without deleting:
--   update cron.job set active = false where jobname = 'sync-fixtures';
