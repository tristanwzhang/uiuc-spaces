-- Shared student check-ins for UIUC Spaces.
-- Paste this into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- Design notes:
--   * No accounts. Anyone can report; anyone can read the last 2 hours.
--   * browser_id is a random id kept in the visitor's browser. It exists only
--     to rate-limit; it is not a person and identifies nobody.
--   * Rate limit: one report per building per browser per minute.

create table if not exists public.checkins (
  id          uuid primary key default gen_random_uuid(),
  building    text        not null check (char_length(building) between 1 and 120),
  level       text        not null check (level in ('quiet', 'okay', 'packed')),
  browser_id  text        not null check (browser_id ~ '^[a-zA-Z0-9_-]{8,64}$'),
  created_at  timestamptz not null default now()
);

-- The map only ever asks for recent rows.
create index if not exists checkins_created_at_idx on public.checkins (created_at desc);
create index if not exists checkins_rate_idx on public.checkins (browser_id, building, created_at desc);

alter table public.checkins enable row level security;

-- Read: only the last 2 hours (older reports are ignored by the map anyway).
drop policy if exists "read recent checkins" on public.checkins;
create policy "read recent checkins"
  on public.checkins for select
  to anon, authenticated
  using (created_at > now() - interval '2 hours');

-- Write: inserts only; the column checks above validate the contents.
drop policy if exists "anyone can check in" on public.checkins;
create policy "anyone can check in"
  on public.checkins for insert
  to anon, authenticated
  with check (created_at > now() - interval '1 minute');

-- No update or delete policies, so neither is possible from the browser.

-- Rate limit, enforced in the database rather than trusting the page.
create or replace function public.enforce_checkin_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.checkins
    where browser_id = new.browser_id
      and building   = new.building
      and created_at > now() - interval '1 minute'
  ) then
    raise exception 'rate limited: one report per building per minute'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

drop trigger if exists checkin_rate_limit on public.checkins;
create trigger checkin_rate_limit
  before insert on public.checkins
  for each row execute function public.enforce_checkin_rate_limit();

-- Housekeeping: nothing older than a day is useful. Run occasionally, or
-- schedule with pg_cron if you enable that extension.
-- delete from public.checkins where created_at < now() - interval '1 day';
