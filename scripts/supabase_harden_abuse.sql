-- Emergency hardening + cleanup for a scripted check-in flood.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- What happened (found 2026-09-29): something was POSTing directly to the
-- public /rest/v1/checkins endpoint — never touching the actual site, so
-- PostHog (which only sees events the page's own JS sends) showed nothing.
-- 3,054 rows arrived that day alone, ~8/minute sustained, 499 of a 500-row
-- sample said "packed", and 472 of those 500 used a distinct freshly-minted
-- browser_id — a script generating a new id on every request specifically
-- to dodge the "one report per building per browser per minute" limit,
-- which only ever worked against a well-behaved client, never a scripted one.
--
-- Worse, this defeats the map's own outlier-discounting too: that logic
-- protects against a FEW stray taps, but a flood of reports that all agree
-- with each other ("packed") is exactly what it trusts *more*, not less.
--
-- Run PART 1 first (stops new abuse), then PART 2 (cleans up existing junk).
-- Running PART 1 first means less junk can land while you're doing PART 2.

-- ═══ PART 1: rate-limit by IP too, not just the client-supplied browser_id ═══

-- Needed for hashing the IP below (Supabase projects normally already have
-- this; harmless if it's already enabled).
create extension if not exists pgcrypto;

-- A private log the rate limiter consults. RLS is enabled with no policies,
-- which is a default-deny: PostgREST will not serve this table to anyone,
-- including the anon key — only this security-definer function can read or
-- write it. Stores a one-way hash of the IP, never the raw address, so even
-- direct database access doesn't hand back anyone's real IP.
create table if not exists public.checkin_ip_log (
  id          bigint generated always as identity primary key,
  ip_hash     text        not null,
  building    text        not null,
  created_at  timestamptz not null default now()
);
alter table public.checkin_ip_log enable row level security;
create index if not exists checkin_ip_log_created_at_idx on public.checkin_ip_log (created_at desc);
create index if not exists checkin_ip_log_ip_hash_idx on public.checkin_ip_log (ip_hash, created_at desc);

create or replace function public.enforce_checkin_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_ip  text;
  ip_hash text;
  ip_hits int;
begin
  -- Original per-browser-per-building limit. Kept as a cheap first check,
  -- but a script can regenerate browser_id for free, so it's no longer the
  -- only thing standing between the table and a flood.
  if exists (
    select 1 from public.checkins
    where browser_id = new.browser_id
      and building   = new.building
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'rate limited: one report per building per minute'
      using errcode = '53400';
  end if;

  -- IP-based limit: the thing a script can't regenerate for free. Supabase's
  -- PostgREST layer exposes the caller's forwarded-for header as a Postgres
  -- setting; take the first address (the original client, not any proxy
  -- hop after it) per Supabase's own documented pattern:
  -- https://supabase.com/docs/guides/api/securing-your-api
  raw_ip := split_part(
    coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''),
    ',', 1
  );

  if raw_ip <> '' then
    ip_hash := encode(digest(raw_ip, 'sha256'), 'hex');

    select count(*) into ip_hits
    from public.checkin_ip_log
    where ip_hash = ip_hash
      and created_at > now() - interval '1 minute';

    -- Adjust this if 5/minute turns out to be too strict or too loose for
    -- real usage — it's a judgement call, not a measured number.
    if ip_hits >= 5 then
      raise exception 'rate limited: too many reports from this connection'
        using errcode = '53400';
    end if;

    insert into public.checkin_ip_log (ip_hash, building) values (ip_hash, new.building);
  end if;

  return new;
end;
$$;

drop trigger if exists checkin_rate_limit on public.checkins;
create trigger checkin_rate_limit
  before insert on public.checkins
  for each row execute function public.enforce_checkin_rate_limit();

-- Keep the private log small — it only ever needs the last minute.
create or replace function public.cleanup_checkin_ip_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.checkin_ip_log where created_at < now() - interval '1 hour';
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-checkin-ip-log';
select cron.schedule(
  'cleanup-checkin-ip-log',
  '*/30 * * * *',
  $$select public.cleanup_checkin_ip_log()$$
);

-- ═══ PART 2: purge the flood ═══
-- The map only ever reads the last 2 hours anyway (both the RLS read policy
-- and the page's own CHECKIN_MAX_MIN), and at ~8 fake rows/minute sustained,
-- there is nothing recent worth trying to separate from the noise by hand.
-- This clears the whole table; real reports start accumulating again
-- immediately under the hardened limit above.
delete from public.checkins;

-- Check it worked and the new trigger is attached:
select count(*) as rows_remaining from public.checkins;
select tgname, tgenabled from pg_trigger where tgrelid = 'public.checkins'::regclass;
