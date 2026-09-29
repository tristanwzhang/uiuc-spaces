# Shared check-ins (Supabase) — plan, not built yet

Today a student's Quiet/Okay/Packed report is saved **only in their own browser**
(local storage), so nobody else sees it. PostHog records that a check-in happened
but can't feed it back to the map — analytics is write-only from the page.

The map already has the hook: `CHECKIN_API` in [app.js](../app.js). Everything
else (blending reports with estimates, trust by count/agreement/age, the panel)
already works.

## What to build

1. **Supabase project** (free tier: 500 MB database, 5 GB traffic/month).
   Note: free projects pause after 7 days with no activity; one click restores.
   Needed from the owner: **project URL** + **anon public key** (safe in browser code).

2. **Table `checkins`**
   - `id` (uuid, default), `building` (text), `level` (text: quiet/okay/packed)
   - `created_at` (timestamptz, default now())
   - `browser_id` (text) — random id kept in local storage, for rate limiting only
   - Index on `created_at` for the "last 2 hours" read.

3. **Row-level security**
   - Anyone may `insert` and may `select` rows from the last 2 hours.
   - No update or delete from the browser.
   - **Rate limit: one report per building per browser per minute** (agreed with the
     owner) — enforced in a Postgres policy/trigger, not just in the page.

4. **Page changes**
   - `CHECKIN_API` → Supabase REST endpoint; send report on submit.
   - Fetch the last 2 hours on load, then **poll every 60 s** so a page left open
     picks up other students' reports.
   - Keep the local-storage fallback when the network fails.

5. **Test**: two different browsers see each other's reports; the rate limit blocks
   a second report within a minute; the map falls back cleanly when offline.

## Abuse notes

No accounts, so anyone could spam. Original mitigations: the per-minute limit
above, the existing trust rules (a single report only nudges the estimate;
disagreeing reports count less), and reports fading out after 2 hours. Real
prevention would need logins, which would cost most of the users.

**2026-09-29: this was tested and found insufficient.** Something POSTed
directly to `/rest/v1/checkins` (never touching the site, so PostHog's
`checkin_submitted` stayed silent) generating a fresh `browser_id` on every
request — free to do, since browser_id is entirely client-supplied — which
defeats the per-browser rate limit completely. Worse, it defeats the
outlier-discounting too: that logic only protects against a *few* stray
reports disagreeing with the pattern; a flood of reports that all *agree*
with each other ("packed", 499 of 500 in the sample) is exactly what it
trusts more, not less. ~3,000 fake rows landed in one day.

Fix in `scripts/supabase_harden_abuse.sql`: an IP-based limit (hashed, logged
in a table PostgREST never serves, so no IP is ever exposed via the API),
independent of anything the client sends. Raises the bar from "generate a
UUID" to "control multiple real IPs" — real prevention against a determined,
IP-rotating attacker would still need accounts or a captcha-gated Edge
Function in front of the insert, which isn't built.

**Measured after that fix shipped: the limit holds, and it isn't enough.**
The trigger is working — inserts are capped at 5/minute per IP, confirmed by
counting rows per minute. The source simply throttled to sit just under the
cap (4–5/minute, sustained) and kept going. That is ~300 rows/hour, which
refills the map's entire 2-hour read window in about 90 minutes, so any
one-time purge buys roughly an hour before the map looks exactly as it did
before. The rate staying pinned just under a *per-IP* cap also suggests a
single IP rather than a rotating pool — which is the case a captcha in front
of the insert would actually stop.

Two things this taught us about filtering the junk after the fact:

- **"Delete reports that disagree with the usual pattern" does not separate
  fake from real.** Scored against the page's own estimates, 321 of 446 rows
  in the window deviated by more than `CHECKIN_SURPRISE_SPAN`. The other 125
  were *also* fake — they just landed on buildings busy enough that "packed"
  wasn't a surprise. Agreement with the estimate is evidence about the
  building, not about the reporter.
- **In that window there were no genuine reports at all** to protect: 441 of
  446 rows were `packed`, spread evenly over 70 buildings (5–14 each), every
  one with a fresh `browser_id`; the remaining 5 were our own test rows. A
  script walking the building list, not students. So cleanup here is not a
  precision problem — it's `delete from public.checkins`, and the only
  question worth arguing about is how to stop the refill.
