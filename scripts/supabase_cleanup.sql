-- Automatic cleanup of old check-ins for UIUC Spaces.
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run twice.
--
-- The map only ever uses the last 2 hours. Keeping 7 days lets you look back at
-- a week of reports (e.g. "was the Union actually packed on Tuesday?") while the
-- table stays small. Change the interval below if you want a different window.

create extension if not exists pg_cron;

-- Remove an older copy of this job, if any, so re-running is safe.
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-checkins';

-- Every night at 11:17pm campus time (04:17 UTC).
select cron.schedule(
  'delete-old-checkins',
  '17 4 * * *',
  $$delete from public.checkins where created_at < now() - interval '7 days'$$
);

-- Check it was scheduled:
select jobname, schedule, active from cron.job where jobname = 'delete-old-checkins';
