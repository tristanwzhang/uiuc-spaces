# UIUC Spaces

A 3D map of the University of Illinois Urbana-Champaign campus showing how busy
buildings are, for finding somewhere to study.

*A student project · not affiliated with the University of Illinois.*

## How it works

Every building's busyness comes from the best source available, and the map
always says which one it used. Nothing is guessed: a building with no usable
data stays grey, and hours come only from official or confirmed sources.

| Source | Used for |
|---|---|
| Student check-ins | Anyone can report Quiet / Okay / Packed; recent reports outweigh estimates |
| Google popular times | Typical busyness where a listing exists (needs a SerpApi key) |
| Class schedules | Hourly estimates for ~68 buildings, from UIUC's public Course Explorer |
| Building-type patterns | Libraries, dining, gyms and BIF's atrium, outside class hours |

Opening hours come from the campus building-hours spreadsheet, the University
Library, University Housing dining, Campus Recreation, Spurlock Museum, Google
listings, and hours confirmed by hand. The academic calendar (holidays, Fall
Break, reading day, finals) adjusts everything.

## Running it locally

```bash
cd ..                       # the folder above this one
python3 -m http.server 8080
```

Then open <http://localhost:8080/UIUC%20Spaces/>.

## Data scripts

All write into `data/`, which the page loads at startup.

| Script | What it does | How often |
|---|---|---|
| `scripts/build_hours.py` | Opening hours from every source | Weekly (automated in CI) |
| `scripts/build_class_estimates.py` | Class meetings per building per hour | Each semester |
| `scripts/build_basemap.py` | Roads, paths, lawns and water from OpenStreetMap | Occasionally |
| `scripts/fetch_google_hours.py` | Hours from Google listings (needs `SERPAPI_KEY`) | Monthly |
| `scripts/fetch_popular_times.py` | Google popular times (needs `SERPAPI_KEY`) | Weekly |

Database setup for check-ins lives in `scripts/supabase_setup.sql`, with nightly
cleanup in `scripts/supabase_cleanup.sql`.

## Notes for whoever maintains this

- **The building-hours spreadsheet expires on December 10, 2026.** A new one is
  posted each term at
  [Daily Event Summaries](https://financeadmin.illinois.edu/facility-scheduling-and-resources/daily-event-summaries/);
  update `SHEET_URL` in `scripts/build_hours.py` and rerun it.
- **Library and dining hours only cover 7 days ahead**, which is why the weekly
  run matters, especially around finals and breaks.
- Keys in the page (Cesium, PostHog, Supabase anon) are public by design. The
  SerpApi key is private and lives only in your shell or in CI secrets.
- More detail: `docs/analytics.md`, `docs/checkins-backend.md`.

## Built with

[CesiumJS](https://cesium.com/platform/cesiumjs/) for the 3D map,
[OpenStreetMap](https://www.openstreetmap.org/copyright) data for buildings and
the drawn basemap, [Supabase](https://supabase.com) for shared check-ins, and
[PostHog](https://posthog.com) for anonymous usage stats.
