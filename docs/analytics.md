# Analytics (PostHog) — setup notes

Tracking is already in the site ([app.js](../app.js), the `ANALYTICS` section near the top).
Project: PostHog **US region**, key `phc_pTDiskU8X4GkZisJH9byyKWbRnWv6tyLCZuJfZ6KTpQx`
(project keys are meant to be public in website code).

No cookies, no session recording, no personal data; "Do Not Track" is respected.
The script loads only after the map is up, so it can't slow the first view.

## Events the site sends

| Event | When | Properties |
|---|---|---|
| `$pageview`, `$pageleave` | Automatic | Gives visitors and time on site |
| `map_ready` | Buildings finished loading | `seconds_to_buildings`, `device`, `buildings_with_data` |
| `building_viewed` | Tooltip shown 1s (once per building per visit) | `building`, `status`, `source` |
| `building_opened` | Building clicked (check-in panel opens) | `building`, `device`, `source` |
| `checkin_submitted` | Student reports Quiet / Okay / Packed | `building`, `level`, `device` |
| `map_failed` | 3D buildings failed to load | `reason` |

## Build the KPI dashboard

**Dashboards → New dashboard → Blank**, name it "UIUC Spaces KPIs", then **Add insight**
for each row below. In the chart editor, click the event name in the series row to change
the event; "Break down by" is under the series.

| Chart | Type | Event | Settings |
|---|---|---|---|
| Visitors | Trends | `$pageview` | Measure: **Unique users**, last 30 days, grouped by day |
| Load speed | Trends | `map_ready` | Measure: **Property value → Average** of `seconds_to_buildings` |
| Most viewed buildings | Trends | `building_viewed` | Break down by `building`; chart type **Bar** |
| Check-ins | Trends | `checkin_submitted` | Break down by `level` (add a second series broken down by `building`) |
| Phone vs computer | Trends | `map_ready` | Break down by `device`; chart type **Pie** |
| Engagement funnel | Funnel | — | Steps: `map_ready` → `building_viewed` → `building_opened` → `checkin_submitted` |
| Failures | Trends | `map_failed` | None; should stay at zero |

## Filter out local testing

Project-wide (recommended):

1. **Settings → Project**
2. **"Filter out internal and test users"** → **+ Add exclusion criteria**
3. **Host** (`$host`) → **does not contain** → `localhost`
4. **Save**

Each insight then has a "Filter out internal and test users" toggle, on by default.

Just one dashboard instead: open it → **Filters** (funnel icon) → **+ Add filter** →
**Host** → **does not contain** → `localhost` → **Apply**, then save the dashboard.

## Notes

- Watch events arrive live under **Activity** in the left sidebar.
- Free plan covers 1M events/month.
- The site footer says "Anonymous usage stats help improve this map."
