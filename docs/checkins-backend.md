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

No accounts, so anyone could spam. Mitigations: the per-minute limit above, the
existing trust rules (a single report only nudges the estimate; disagreeing reports
count less), and reports fading out after 2 hours. Real prevention would need
logins, which would cost most of the users.
