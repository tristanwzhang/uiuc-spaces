-- Tighten the per-IP check-in limit from 5/minute to 10/hour.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- Why: the per-IP limit added in supabase_harden_abuse.sql works — inserts are
-- capped, confirmed by counting rows per minute. The flood simply throttled to
-- 4-5/minute to sit just under the cap and kept going, which is ~300 rows/hour
-- and refills the map's whole 2-hour read window in about 90 minutes.
--
-- Note what is NOT changed here: the per-browser-per-building limit. Widening
-- that window would accomplish nothing, because the flood mints a brand new
-- browser_id on every request — no two requests ever share one, so a limit
-- keyed on browser_id never matches twice no matter how long its window is.
-- Only the IP limit binds, so only the IP limit is worth tuning.
--
-- Why 10/hour is safe for real students, measured rather than guessed:
--   * Real check-ins (the page's own checkin_submitted events, localhost
--     excluded) are running at ~5 per DAY across all users right now.
--   * Since the run that added a success flag to those events, 25 real
--     check-ins have been recorded and 0 were rejected by the limit.
--   * 10/hour per IP is therefore ~100x current real demand from a single
--     address, and cuts the flood roughly 30x (300/hour -> 10/hour).
--
-- The one real risk: this is per-IP, and campus WiFi puts many students behind
-- a shared address. Launch day peaked at 35 check-ins in a single minute. If
-- traffic spikes like that again, students sharing one NAT address could start
-- getting rejected. If that happens, raise LIMIT_PER_HOUR below, or revert to
-- supabase_harden_abuse.sql. Real prevention is still a captcha-gated Edge
-- Function in front of the insert; this only buys time.

create or replace function public.enforce_checkin_rate_limit()
returns trigger
language plpgsql
security definer
-- pgcrypto's digest() lives in the extensions schema on Supabase, not public.
set search_path = public, extensions
as $$
declare
  -- Tunables, kept together so there's one place to adjust.
  window_len       constant interval := interval '1 hour';
  limit_per_window constant int      := 10;

  raw_ip    text;
  v_ip_hash text;
  ip_hits   int;
begin
  -- Per-browser-per-building. Kept as a cheap first check and to stop a real
  -- student double-tapping, but it is not what holds back a script.
  if exists (
    select 1 from public.checkins
    where browser_id = new.browser_id
      and building   = new.building
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'rate limited: one report per building per minute'
      using errcode = '53400';
  end if;

  raw_ip := split_part(
    coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''),
    ',', 1
  );

  if raw_ip <> '' then
    v_ip_hash := encode(digest(raw_ip, 'sha256'), 'hex');

    -- v_ip_hash, not ip_hash: a local variable sharing the column's name would
    -- make this "ip_hash = ip_hash", always true, silently disabling the limit.
    select count(*) into ip_hits
    from public.checkin_ip_log
    where ip_hash = v_ip_hash
      and created_at > now() - window_len;

    if ip_hits >= limit_per_window then
      raise exception 'rate limited: too many reports from this connection'
        using errcode = '53400';
    end if;

    insert into public.checkin_ip_log (ip_hash, building) values (v_ip_hash, new.building);
  end if;

  return new;
end;
$$;

-- The log must outlive the window the check reads, or the limit quietly stops
-- working: rows would be deleted while the counter still needs to see them.
-- Window is 1 hour, so keep 3 to leave margin for the job running late.
create or replace function public.cleanup_checkin_ip_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.checkin_ip_log where created_at < now() - interval '3 hours';
$$;

-- Confirm the trigger is still attached to the new function body:
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.checkins'::regclass and not tgisinternal;

-- Then clear the junk that already landed. Everything currently in the
-- readable window is from the flood (441 of 446 rows "packed", spread evenly
-- over 70 buildings, every one a fresh browser_id; the other 5 were test rows),
-- so there is nothing real to preserve by filtering more carefully.
delete from public.checkins;

select count(*) as rows_remaining from public.checkins;
