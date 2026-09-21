// ─── UIUC Spaces ──────────────────────────────────────────────────────────────
// Busyness comes from several sources, best first:
//   1. reported  — student check-ins from the last couple of hours
//   2. measured  — Google popular times (data/popular_times.json, via SerpApi)
//   3. estimated — class schedules (data/class_activity.json, Course Explorer)
//   4. typical   — a generic pattern for the building type (libraries, gym…)
// A building with none of these stays grey and shows nothing. Never guess.

// ─── Anonymous usage stats (PostHog) ──────────────────────────────────────────
// Off until ANALYTICS.key is filled in. No personal data, no cookies, and the
// script only loads after the map is up so it can't slow the first view.
const ANALYTICS = {
  key: 'phc_pTDiskU8X4GkZisJH9byyKWbRnWv6tyLCZuJfZ6KTpQx',   // project API key (public by design)
  host: 'https://us.i.posthog.com',                          // US region
};

const analyticsQueue = [];
let analyticsReady = false;

/** Record an event, e.g. track('checkin_submitted', { building, level }). */
function track(event, properties = {}) {
  if (!ANALYTICS.key) return;
  if (!analyticsReady) { analyticsQueue.push([event, properties]); return; }
  try { window.posthog?.capture(event, properties); } catch (e) { /* never break the map */ }
}

function startAnalytics() {
  if (!ANALYTICS.key || analyticsReady) return;
  const script = document.createElement('script');
  script.async = true;
  script.src = `${ANALYTICS.host}/static/array.js`;
  script.onload = () => {
    window.posthog.init(ANALYTICS.key, {
      api_host: ANALYTICS.host,
      persistence: 'memory',         // no cookies, so no cookie banner needed
      autocapture: false,            // only the events below
      disable_session_recording: true,
      disable_surveys: true,
      respect_dnt: true,
      capture_pageview: true,
      capture_pageleave: true,       // gives time-on-site
      person_profiles: 'never',
    });
    analyticsReady = true;
    for (const [event, props] of analyticsQueue.splice(0)) track(event, props);
  };
  script.onerror = () => { analyticsQueue.length = 0; };
  document.head.append(script);
}

function deviceKind() {
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700 ? 'phone' : 'computer';
}

// Cesium's servers use HTTP/2, so many requests can run at once.
Cesium.RequestScheduler.maximumRequestsPerServer = 40;

// Restricted token: only terrain + OSM buildings, only from this site.
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im5KTEZpTm56ZjRjbkZBMDYiLCJqdGkiOiI1Mjc5NDQ0NC05OTQyLTQ4ODUtYTNkNy1hN2M3Yzc5ODBmMjgiLCJpZCI6NDkzNDU4LCJzdWIiOiJ0cmlzdGFueiIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJVSVVDIFNwYWNlcyBTaXRlIiwiaWF0IjoxNzkwMDI5MDY3fQ.DFrEgqK_Sw73hGJUAvsuML0Vmh3c-30XzQS-6Umoshg';

// ─── Buildings we know something extra about ──────────────────────────────────
// Keyed by the building's EXACT OpenStreetMap name.
//   type          — picks the fallback busyness pattern
//   peakFullness  — how full this building gets at its busiest hour (0–1).
//                   Turns "busy for this building" into something comparable
//                   between buildings.
// Opening hours are NOT set here: they come only from official published
// hours in data/building_hours.json (scripts/build_hours.py).

const BUILDINGS = {
  "Main Library":                     { type: "library", peakFullness: 0.95 },
  "Grainger Engineering Library":     { type: "library", peakFullness: 0.95 },

  // Long official names crowd out their neighbours on the map, so these show a
  // shorter form of the same name. Tooltips still show the full name.
  "Steven S. Wymer Hall":                            { label: "Wymer Hall", labelPriority: 1 },
  "University of Illinois College of Law":           { label: "College of Law" },
  "Graduate School of Library and Information Science": { label: "Information Sciences" },
  "Veterinary Medicine Basic Sciences Building":     { label: "Vet Med Basic Sciences" },
  "Literatures, Cultures & Linguistics Building":    { label: "Literatures & Linguistics" },

  // BIF's atrium is a hangout spot: people stay 15 min – 2 h after class to
  // talk and study, so the building doesn't empty out when classes do. The
  // site owner's description of a typical day (which already reflects that)
  // is used instead of the class schedule.
  "Business Instructional Facility": {
    type: "atrium",
    label: "BIF",
    pattern: {
      // [from, to, level] in hours; 9.5 = 9:30am
      monday:    [[0, 9.5, "quiet"], [9.5, 10.5, "okay"], [10.5, 15.5, "busy"], [15.5, 24, "okay"]],
      tuesday:   [[0, 9.5, "quiet"], [9.5, 10.5, "okay"], [10.5, 15.5, "busy"], [15.5, 24, "okay"]],
      wednesday: [[0, 9.5, "quiet"], [9.5, 10.5, "okay"], [10.5, 15.5, "busy"], [15.5, 24, "okay"]],
      thursday:  [[0, 9.5, "quiet"], [9.5, 10.5, "okay"], [10.5, 15.5, "busy"], [15.5, 24, "okay"]],
      friday:    [[0, 24, "quiet"]],
      saturday:  [[0, 24, "quiet"]],
      sunday:    [[0, 24, "quiet"]],
    },
  },
  "Funk Library":                     { type: "library", peakFullness: 0.85 },
  "Illini Union":                     { type: "union",   peakFullness: 0.80 },
  "Illini Union Bookstore":           { type: "union",   peakFullness: 0.60 },
  "Activities and Recreation Center": { type: "rec",     peakFullness: 0.85 },
  "Campus Recreation Center East":    { type: "rec",     peakFullness: 0.80 },
  "Student Dining and Residential Programs (SDRP)": {
    type: "study",
    peakFullness: 0.80,
    // Centre of the east wing (the part not drawn as the dining hall), so the
    // label sits over SDRP's own area.
    labelAt: [-88.234758, 40.103672],
    label: "SDRP",   // the building's short name in OpenStreetMap (loc_name)
  },

  // The west part of the SDRP building, including the round section. OpenStreetMap
  // draws it as part of SDRP's outline, so we draw our own shape on top. The
  // outline follows SDRP's real edges (west, north and the curved south side)
  // and is cut straight at the east end of the curve; SDRP keeps the east wing.
  // Heights are metres above the ellipsoid, like the building tiles: SDRP's
  // roof is at ~198 m and its base ~192 m; the hall is drawn a little taller so
  // the two roofs never flicker against each other.
  "Ikenberry Dining Hall": {
    type: "dining",
    peakFullness: 0.90,
    shape: {
      baseM: 191.5,
      topM: 201,
      outline: [
      [-88.2350252, 40.1039745], [-88.2350669, 40.1039752], [-88.2357347, 40.1039715],
      [-88.235732, 40.1039442], [-88.2358503, 40.1039448], [-88.2358496, 40.1038348],
      [-88.2358031, 40.103831], [-88.2358045, 40.1037131], [-88.2358052, 40.1036972],
      [-88.2359167, 40.1036843], [-88.2359144, 40.103506], [-88.2358571, 40.1035159],
      [-88.2358395, 40.1034737], [-88.2358174, 40.1034347], [-88.2357851, 40.1033973],
      [-88.235731, 40.1033505], [-88.2356871, 40.1033228], [-88.2356398, 40.1032978],
      [-88.2355965, 40.1032814], [-88.2355494, 40.1032698], [-88.2355357, 40.103303],
      [-88.2355195, 40.1032977], [-88.2354684, 40.1032901], [-88.2354121, 40.1032857],
      [-88.2353625, 40.1032869], [-88.2353206, 40.1032905], [-88.2352855, 40.1032974],
      [-88.235242, 40.103309], [-88.2352097, 40.1033211], [-88.2351761, 40.1033343],
      [-88.2351419, 40.1033525], [-88.2351153, 40.1033709], [-88.2350979, 40.1033882],
      [-88.2350808, 40.103401], [-88.2351109, 40.103425], [-88.2351023, 40.1034305],
      [-88.2350929, 40.1034376], [-88.2350705, 40.1034654], [-88.2350508, 40.1034949],
      [-88.2350358, 40.1035273], [-88.2350284, 40.1035498], [-88.2350232, 40.1035704],
      ],
    },
  },

  // A building can also be split into spaces without drawing anything, e.g.
  //   "Illini Union": { spaces: { "Food court": { type: "dining" }, ... } },
  // Each space gets its own estimate, hours and check-ins, listed in the tooltip.
};

// How full each described level is (same scale as the tooltip's status words).
const PATTERN_LEVELS = { quiet: 0.2, okay: 0.5, busy: 0.72, packed: 0.9 };
const PATTERN_RAMP_H = 0.25;   // ease between levels over ~15 minutes

const DEFAULT_PEAK_FULLNESS = {
  library: 0.95, union: 0.80, rec: 0.85, dining: 0.90, study: 0.80, academic: 0.70,
};

// Spaces are addressed as "Building › Space"; plain buildings by their name.
const SPACE_SEP = ' › ';
const spaceId = (building, space) => building + SPACE_SEP + space;

function configFor(id) {
  if (BUILDINGS[id]) return BUILDINGS[id];
  const i = id.indexOf(SPACE_SEP);
  if (i < 0) return undefined;
  return BUILDINGS[id.slice(0, i)]?.spaces?.[id.slice(i + SPACE_SEP.length)];
}

function spacesOf(building) {
  return Object.keys(BUILDINGS[building]?.spaces || {});
}

// Typical share-of-peak by hour for buildings with no class or Google data.
// Rough shapes, clearly labelled as estimates in the UI.
const TYPE_PROFILES = {
  library: {
    // overnight values only matter for libraries that stay open (24/5)
    weekday:  [.25,.18,.12,.08,.05,.05,.05,.15,.3,.5,.65,.75,.8,.85,.9,.95,.9,.85,.8,.85,.9,.85,.6,.3],
    saturday: [0,0,0,0,0,0,0,.05,.15,.3,.45,.55,.6,.65,.65,.6,.55,.5,.5,.55,.6,.55,.4,.2],
    sunday:   [0,0,0,0,0,0,0,.05,.1,.2,.35,.5,.6,.7,.8,.85,.85,.85,.85,.9,.95,.9,.65,.35],
  },
  rec: {
    weekday:  [0,0,0,0,0,.1,.35,.5,.45,.4,.4,.45,.5,.5,.5,.55,.7,.9,1,.95,.8,.6,.3,.1],
    saturday: [0,0,0,0,0,0,.1,.2,.35,.5,.6,.65,.6,.5,.45,.4,.4,.45,.5,.45,.35,.2,.1,0],
    sunday:   [0,0,0,0,0,0,.05,.15,.25,.4,.5,.55,.55,.5,.5,.55,.65,.75,.8,.75,.6,.4,.2,.05],
  },
  // Meal rushes, with people staying to study in between and after dinner
  dining: {
    weekday:  [0,0,0,0,0,0,0,.35,.45,.3,.35,.8,1,.75,.4,.35,.45,.85,.95,.6,.45,.4,.25,0],
    saturday: [0,0,0,0,0,0,0,0,.15,.3,.45,.7,.8,.6,.35,.3,.4,.7,.75,.45,.3,.25,.15,0],
    sunday:   [0,0,0,0,0,0,0,0,.15,.35,.55,.8,.85,.6,.35,.35,.45,.8,.9,.6,.45,.4,.25,0],
  },
  // Study lounges: steady through the day, busiest in the evening
  study: {
    weekday:  [.15,.1,.05,0,0,0,0,.1,.2,.3,.4,.45,.45,.5,.55,.55,.55,.6,.7,.85,1,.95,.7,.35],
    saturday: [.1,.05,0,0,0,0,0,0,.1,.15,.25,.3,.35,.35,.35,.35,.35,.35,.35,.4,.4,.35,.25,.15],
    sunday:   [.1,.05,0,0,0,0,0,0,.1,.15,.25,.35,.45,.5,.55,.6,.65,.7,.75,.85,.95,.9,.7,.35],
  },
  union: {
    weekday:  [0,0,0,0,0,0,.05,.2,.4,.55,.7,.85,1,.95,.85,.8,.75,.65,.55,.5,.4,.3,.15,.05],
    saturday: [0,0,0,0,0,0,0,.1,.2,.3,.4,.55,.6,.6,.55,.5,.45,.4,.35,.3,.25,.2,.1,0],
    sunday:   [0,0,0,0,0,0,0,.1,.2,.3,.4,.5,.55,.55,.5,.5,.45,.45,.4,.35,.3,.2,.1,0],
  },
};

// ─── Student check-ins ────────────────────────────────────────────────────────
// Reports are shared through Supabase once CHECKINS is filled in (see
// scripts/supabase_setup.sql). Until then — or whenever the network fails —
// they fall back to this browser only.
const CHECKINS = {
  url: 'https://iyupkweuluwewsfbnizj.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5dXBrd2V1bHV3ZXdzZmJuaXpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NTQ2ODIsImV4cCI6MjEwNTMzMDY4Mn0.mzQO19Xr6qpoi6ab363nPtqh_ctIrdOOS6J5MlGIlr8',
};
const CHECKINS_POLL_MS = 60 * 1000;   // pick up other people's reports
const CHECKIN_LEVELS = { quiet: 0.2, okay: 0.55, packed: 0.9 };
const CHECKIN_FRESH_MIN = 30;   // full weight up to here
const CHECKIN_MAX_MIN   = 120;  // ignored after this
const CHECKIN_TRUST_HALF = 2;   // fresh reports needed before they outweigh the estimate

// ─── Academic calendar ────────────────────────────────────────────────────────
// From https://registrar.illinois.edu/fall-2026-academic-calendar/
// Class-schedule estimates only apply on instruction days. On other days the
// building-type patterns (and Google data) are scaled by CALENDAR_EFFECTS.
const ACADEMIC_CALENDAR = {
  term: 'Fall 2026',
  classesStart: '2026-08-24',
  classesEnd:   '2026-12-09',
  termEnd:      '2026-12-17',   // last day of final exams
  periods: [
    { start: '2026-09-07', end: '2026-09-07', kind: 'holiday', label: 'Labor Day — no classes' },
    { start: '2026-11-21', end: '2026-11-29', kind: 'break',   label: 'Fall Break — no classes' },
    { start: '2026-12-10', end: '2026-12-10', kind: 'reading', label: 'Reading day — no classes' },
    { start: '2026-12-11', end: '2026-12-17', kind: 'finals',  label: 'Finals week' },
  ],
};

// How busy each kind of place is compared to a normal class day.
// These are rough judgement calls, not measurements. Classroom buildings aren't
// listed: their estimate comes from the class schedule, which is simply zero
// on days without classes.
const CALENDAR_EFFECTS = {
  normal:  { library: 1,   study: 1,   union: 1,   dining: 1,   rec: 1,   atrium: 1 },
  holiday: { library: 0.8, study: 0.9, union: 0.6, dining: 0.8, rec: 1,   atrium: 0.3 },
  break:   { library: 0.3, study: 0.3, union: 0.3, dining: 0.3, rec: 0.4, atrium: 0.1 },
  reading: { library: 1.2, study: 1.2, union: 1,   dining: 1,   rec: 0.8, atrium: 1.1 },
  finals:  { library: 1.3, study: 1.3, union: 1,   dining: 1,   rec: 0.7, atrium: 1.1 },
  offterm: { library: 0.2, study: 0.2, union: 0.2, dining: 0.2, rec: 0.3, atrium: 0.1 },
};

const CAMPUS_TZ = 'America/Chicago';
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// ─── Data loading ─────────────────────────────────────────────────────────────
const data = { classActivity: null, popularTimes: null, hours: null, checkins: loadLocalCheckins() };

async function loadJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

const sharedCheckins = () => Boolean(CHECKINS.url && CHECKINS.anonKey);

function checkinsEndpoint(query = '') {
  return `${CHECKINS.url.replace(/\/$/, '')}/rest/v1/checkins${query}`;
}

function checkinsHeaders(extra = {}) {
  return { apikey: CHECKINS.anonKey, Authorization: `Bearer ${CHECKINS.anonKey}`, ...extra };
}

/** A random id for this browser, used only to rate-limit reports. */
function browserId() {
  try {
    let id = localStorage.getItem('browser-id');
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36)).slice(0, 36);
      localStorage.setItem('browser-id', id);
    }
    return id;
  } catch (e) {
    return 'anonymous-' + Math.random().toString(36).slice(2, 10);
  }
}

/** Everyone's reports from the last couple of hours. */
async function fetchSharedCheckins() {
  if (!sharedCheckins()) return;
  const since = new Date(Date.now() - CHECKIN_MAX_MIN * 60000).toISOString();
  try {
    const res = await fetch(
      checkinsEndpoint(`?select=building,level,created_at&created_at=gte.${since}&order=created_at.desc&limit=500`),
      { headers: checkinsHeaders() });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const rows = await res.json();

    // Server is the source of truth; keep only local reports it hasn't stored
    // yet (just sent, or sent while offline).
    const server = rows.map(r => ({ building: r.building, level: r.level, at: Date.parse(r.created_at) }));
    const seen = new Set(server.map(r => `${r.building}|${r.level}|${Math.round(r.at / 10000)}`));
    const localOnly = data.checkins.filter(r =>
      r.mine && !seen.has(`${r.building}|${r.level}|${Math.round(r.at / 10000)}`));
    data.checkins = [...server, ...localOnly];
    saveLocalCheckins();
    refresh({ keepThanks: true });   // don't wipe a "thanks" message mid-flight
  } catch (e) {
    console.warn('Could not load shared check-ins:', e);
  }
}

/** Send one report. Returns 'ok', 'rate-limited', or 'offline'. */
async function sendCheckin(report) {
  if (!sharedCheckins()) return 'offline';
  try {
    const res = await fetch(checkinsEndpoint(), {
      method: 'POST',
      headers: checkinsHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ building: report.building, level: report.level, browser_id: browserId() }),
    });
    if (res.ok) return 'ok';
    const text = await res.text();
    return /rate limited/i.test(text) ? 'rate-limited' : 'offline';
  } catch (e) {
    return 'offline';
  }
}

function loadLocalCheckins() {
  try {
    return JSON.parse(localStorage.getItem('checkins') || '[]');
  } catch (e) {
    return [];
  }
}

function saveLocalCheckins() {
  try {
    localStorage.setItem('checkins', JSON.stringify(data.checkins.slice(-200)));
  } catch (e) { /* private browsing — reports just won't persist */ }
}

// ─── Time helpers (campus time, not the viewer's) ─────────────────────────────
function campusNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  const weekdayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  return {
    day: DAY_NAMES[weekdayIndex < 0 ? new Date().getDay() : weekdayIndex],
    hour,
    time: hour + Number(get('minute')) / 60,   // e.g. 14.5 = 2:30pm
    // YYYY-MM-DD in campus time
    date: new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TZ }).format(new Date()),
  };
}

/** { kind, label, classesMeet } for a YYYY-MM-DD date. */
function calendarPeriod(date) {
  const cal = ACADEMIC_CALENDAR;
  const special = cal.periods.find(p => date >= p.start && date <= p.end);
  if (special) return { kind: special.kind, label: special.label, classesMeet: false };
  if (date < cal.classesStart || date > cal.termEnd) {
    return { kind: 'offterm', label: `Outside the ${cal.term} semester`, classesMeet: false };
  }
  if (date > cal.classesEnd) return { kind: 'finals', label: 'Finals week', classesMeet: false };
  return { kind: 'normal', label: '', classesMeet: true };
}

function calendarEffect(period, id) {
  const effects = CALENDAR_EFFECTS[period.kind] || CALENDAR_EFFECTS.normal;
  return effects[buildingType(id)] ?? 1;
}

function dayKind(day) {
  if (day === 'saturday') return 'saturday';
  if (day === 'sunday') return 'sunday';
  return 'weekday';
}

// ─── Working out how busy a building is ───────────────────────────────────────
function buildingType(id) {
  return configFor(id)?.type || 'academic';
}

function peakFullness(id) {
  const cfg = configFor(id);
  if (cfg?.peakFullness != null) return cfg.peakFullness;
  return DEFAULT_PEAK_FULLNESS[buildingType(id)] ?? 0.7;
}

// ─── Opening hours (official sources only) ────────────────────────────────────
// Each building in data/building_hours.json has some of:
//   dates    — exact hours for specific days (library/dining seven-day feeds)
//   periods  — hours for a date range (e.g. Fall Break)
//   weekly   — the usual week, used between valid[0] and valid[1]
// Hours are [open, close] pairs in hours of that day; close > 24 runs past
// midnight (2am = 26). Anything not covered is "unknown", never guessed.

function weekdayOf(date) {
  return DAY_NAMES[new Date(date + 'T12:00:00Z').getUTCDay()];
}

function shiftDate(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Published hours for one building on one date, or null if unknown. */
function publishedRanges(entry, date) {
  if (entry.dates && date in entry.dates) return entry.dates[date];

  const campusClosed = entry.followsCampusClosures
    && (data.hours.campusClosedDates || []).includes(date)
    && !(entry.openDates || []).includes(date);
  if (campusClosed) return [];

  if ((entry.unknownDuring || []).some(([a, b]) => date >= a && date <= b)) return null;

  const period = (entry.periods || []).find(p => date >= p.start && date <= p.end);
  if (period) return period.weekly[weekdayOf(date)] ?? null;

  if (!entry.valid || date < entry.valid[0] || date > entry.valid[1]) return null;
  return entry.weekly?.[weekdayOf(date)] ?? null;
}

/** { state: 'open' | 'closed' | 'unknown', source } */
function hoursStatus(id, date, time) {
  const entry = data.hours?.buildings?.[id];
  if (!entry) return { state: 'unknown' };

  // Still open from yesterday's late hours (e.g. until 2am)?
  const yesterday = publishedRanges(entry, shiftDate(date, -1));
  if (yesterday && yesterday.some(([, close]) => close > 24 && time < close - 24)) {
    return { state: 'open', source: entry.source };
  }

  const today = publishedRanges(entry, date);
  if (today == null) return { state: 'unknown' };
  const open = today.some(([o, c]) => time >= o && time < c);
  return {
    state: open ? 'open' : 'closed',
    source: entry.source,
    official: !!entry.sourceUrl,
    cardAccess: !!entry.cardAccess,   // doors have a card reader
  };
}

/**
 * Summarises recent reports for a building.
 *   value      — age-weighted average of the reports (0–1)
 *   trust      — how much the reports should override the estimate (0–1).
 *                Grows with the number of fresh reports, shrinks when they
 *                disagree, and fades as they age.
 */
function freshCheckin(name, now = Date.now()) {
  const recent = data.checkins
    .filter(c => c.building === name && (now - c.at) / 60000 < CHECKIN_MAX_MIN)
    .sort((a, b) => b.at - a.at);
  if (!recent.length) return null;

  let total = 0, weightSum = 0;
  const weighted = [];
  for (const report of recent) {
    const ageMin = (now - report.at) / 60000;
    const weight = ageMin <= CHECKIN_FRESH_MIN
      ? 1
      : 1 - (ageMin - CHECKIN_FRESH_MIN) / (CHECKIN_MAX_MIN - CHECKIN_FRESH_MIN);
    const level = CHECKIN_LEVELS[report.level] ?? 0.55;
    total += level * weight;
    weightSum += weight;
    weighted.push([level, weight]);
  }
  const value = total / weightSum;

  // Few reports → low trust: 1 fresh report ≈ 33%, 2 ≈ 50%, 4 ≈ 67%, 8 ≈ 80%.
  const countTrust = weightSum / (weightSum + CHECKIN_TRUST_HALF);

  // Reports that disagree (some "quiet", some "packed") count for less.
  const variance = weighted.reduce((sum, [level, w]) => sum + w * (level - value) ** 2, 0) / weightSum;
  const spread = Math.sqrt(variance);                 // 0 when all agree, ~0.35 when split
  const agreement = 1 - Math.min(spread / 0.35, 1) * 0.6;

  return {
    value,
    trust: countTrust * agreement,
    ageMin: (now - recent[0].at) / 60000,
    count: recent.length,
    disagree: spread > 0.2,
  };
}

function googleBusyness(name, day, hour) {
  const place = data.popularTimes?.places?.[name];
  const entry = place?.weekly?.[day]?.find(h => h.hour === hour);
  return entry ? entry.busyness / 100 : null;
}

function classBusyness(name, day, hour) {
  const building = data.classActivity?.buildings?.[name];
  if (!building || !building.peak) return null;
  const value = building.hours?.[day]?.[hour];
  return value == null ? null : value / building.peak;
}

// A described pattern ("quiet 6–9:30, busy 10:30–3:30, …") as a fullness value,
// easing between levels.
function patternBusyness(name, day, time) {
  const segments = configFor(name)?.pattern?.[day];
  if (!segments) return null;
  const levelAt = t => {
    const seg = segments.find(([from, to]) => t >= from && t < to);
    return seg ? PATTERN_LEVELS[seg[2]] : null;
  };
  const here = levelAt(time);
  if (here == null) return null;
  const before = levelAt(time - PATTERN_RAMP_H) ?? here;
  const after = levelAt(time + PATTERN_RAMP_H) ?? here;
  return (before + 2 * here + after) / 4;
}

function profileBusyness(name, day, hour) {
  const profile = TYPE_PROFILES[buildingType(name)];
  return profile ? profile[dayKind(day)][hour] : null;
}

/**
 * Returns { value, source, note } or null when we know nothing about it.
 * value is 0–1 fullness; source drives the label shown to the user.
 */
function occupancyFor(name) {
  const estimate = estimateFor(name);
  const checkin = freshCheckin(name);
  if (!checkin) return estimate;

  // Blend reports with the estimate. With no estimate (or a closed building
  // that people say is open) the reports are all we have.
  const base = estimate && !['closed', 'unknown'].includes(estimate.source) ? estimate.value : null;
  const trust = base == null ? 1 : checkin.trust;
  const value = base == null ? checkin.value : base * (1 - trust) + checkin.value * trust;

  const mins = Math.round(checkin.ageMin);
  const reports = checkin.count > 1
    ? `${checkin.count} student reports, newest ${mins} min ago`
    : `1 student report, ${mins} min ago`;
  const detail = checkin.disagree ? ' · reports disagree' : '';

  // Only call it "student reported" once reports outweigh the estimate.
  if (trust >= 0.5) {
    return { value, source: 'reported', note: reports + detail };
  }
  return { value, source: estimate.source, note: `${estimate.note} + ${reports}${detail}` };
}

/**
 * What the map shows for a whole building. For buildings split into spaces,
 * the colour is the average of the spaces that are open, and `spaces` lists
 * each one for the tooltip.
 */
function buildingOccupancy(name) {
  const spaces = spacesOf(name);
  if (!spaces.length) return occupancyFor(name);

  const parts = spaces.map(space => ({ space, occ: occupancyFor(spaceId(name, space)) }));
  const open = parts.filter(p => p.occ && !['closed', 'unknown'].includes(p.occ.source));

  if (!open.length) {
    const allClosed = parts.every(p => p.occ?.source === 'closed');
    return allClosed
      ? { value: 0, source: 'closed', note: 'All spaces closed right now', spaces: parts }
      : { value: 0, source: 'unknown', note: 'Hours not published for these spaces', spaces: parts };
  }

  const value = open.reduce((sum, p) => sum + p.occ.value, 0) / open.length;
  const sources = new Set(open.map(p => p.occ.source));
  const source = sources.size === 1 ? [...sources][0] : 'estimated';
  const note = open.length === parts.length
    ? 'Average of the spaces below'
    : `${open.length} of ${parts.length} spaces open`;
  return { value, source, note, spaces: parts };
}

/** The best estimate without student reports, or null. */
function estimateFor(name) {
  const { day, hour, time, date } = campusNow();
  const peak = peakFullness(name);
  const period = calendarPeriod(date);
  const effect = calendarEffect(period, name);
  const withPeriod = note => period.label ? `${note} · ${period.label}` : note;

  const hours = hoursStatus(name, date, time);
  if (hours.state === 'closed') {
    const from = hours.official ? ` · hours from ${hours.source}` : '';
    return {
      value: 0,
      source: 'closed',
      cardAccess: hours.cardAccess,
      note: hours.cardAccess
        ? `Public doors locked · i-card access may still work${from}`
        : `Closed right now${from}`,
    };
  }
  const estimate = estimateWhileOpen(name, day, hour, peak, period, effect, withPeriod, time);
  if (!estimate || hours.state === 'open') return estimate;

  // Hours not published for today: only show a number when classes are
  // actually scheduled there right now (so the building must be open). Typical
  // patterns are guesses and would imply the building is open, so they don't count.
  if (estimate.source === 'estimated' && estimate.value >= 0.03) {
    return { ...estimate, note: `${estimate.note} · building hours not published` };
  }
  return { value: 0, source: 'unknown', note: 'Opening hours not published for today' };
}

function estimateWhileOpen(name, day, hour, peak, period, effect, withPeriod, time = hour) {
  const google = googleBusyness(name, day, hour);
  if (google != null) {
    return {
      value: Math.min(google * peak * effect, 1),
      source: 'measured',
      note: withPeriod('Google popular times · typical for this hour'),
    };
  }

  // No classes meet on breaks, holidays, reading day or during finals.
  // A typical day described by the site owner is first-hand, so it takes
  // priority over the class schedule for that building.
  const described = patternBusyness(name, day, time);
  if (described != null) {
    return {
      value: Math.min(described * effect, 1),
      source: 'typical',
      note: withPeriod('Based on typical activity for this building'),
    };
  }

  const scheduled = classBusyness(name, day, hour);
  const classes = scheduled == null ? null : (period.classesMeet ? scheduled : 0);

  const rawProfile = configFor(name) ? profileBusyness(name, day, hour) : null;
  const profile = rawProfile == null ? null : Math.min(rawProfile * effect, 1);

  // Libraries, the Union and the gyms stay busy outside class hours, so their
  // own pattern wins whenever it says busier than the class schedule does.
  if (classes != null || profile != null) {
    const useProfile = profile != null && (classes == null || profile > classes);
    if (useProfile) {
      return {
        value: Math.min(profile * peak, 1),
        source: 'typical',
        note: withPeriod('Typical pattern for this kind of building'),
      };
    }
    return {
      value: classes * peak,
      source: 'estimated',
      note: period.classesMeet
        ? 'Estimated from class schedules'
        : `No classes scheduled · ${period.label}`,
    };
  }

  return null;
}

function knownBuildings() {
  const names = new Set(Object.keys(BUILDINGS));
  for (const name of Object.keys(data.classActivity?.buildings || {})) names.add(name);
  for (const name of Object.keys(data.popularTimes?.places || {})) names.add(name);
  return [...names];
}

// ─── Colours and labels ───────────────────────────────────────────────────────
function occToColor(t) {
  let r, g, b;
  if (t < 0.5) {
    const s = t * 2;
    r = Math.round(34  + s * (234 - 34));
    g = Math.round(197 + s * (179 - 197));
    b = Math.round(94  + s * (8   - 94));
  } else {
    const s = (t - 0.5) * 2;
    r = Math.round(234 + s * (239 - 234));
    g = Math.round(179 + s * (68  - 179));
    b = Math.round(8   + s * (68  - 8));
  }
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function cssColor(t) {
  if (t < 0.4) return '#22c55e';
  if (t < 0.7) return '#eab308';
  return '#ef4444';
}

function statusLabel(t) {
  if (t < 0.35) return 'Quiet';
  if (t < 0.6)  return 'Moderate';
  if (t < 0.8)  return 'Busy';
  return 'Very busy';
}

const SOURCE_LABELS = {
  reported:  'Student reported',
  measured:  'Google data',
  estimated: 'Estimated',
  typical:   'Estimated',
  closed:    'Closed',
  unknown:   'No data right now',
};

// ─── Map area: Champaign–Urbana only ──────────────────────────────────────────
const AREA = { west: -88.33, south: 40.06, east: -88.16, north: 40.16 };
const AREA_RECT = Cesium.Rectangle.fromDegrees(AREA.west, AREA.south, AREA.east, AREA.north);

// ─── Basemap: drawn in the browser from OpenStreetMap data ─────────────────────
// data/basemap.json (scripts/build_basemap.py) holds roads, paths, lawns, water
// and rail. Each map tile is drawn on a canvas in these colours, so the look is
// fully ours — no satellite photos and no third-party tile service.
const MAP_STYLE = {
  background: '#3d4151',
  farm:    { fill: '#434852' },
  wood:    { fill: '#485a4d' },
  green:   { fill: '#53684f' },
  parking: { fill: '#464a5b' },
  water:   { fill: '#3d5877' },
  stream:  { stroke: '#4a6a8e', widthM: 3,   minPx: 0.8 },
  path:    { stroke: '#666b82', widthM: 1.6, minPx: 1,   minLevel: 15 },
  service: { stroke: '#70758d', widthM: 4,   minPx: 0.6, minLevel: 14 },
  minor:   { stroke: '#858aa3', widthM: 8,   minPx: 0.7, minLevel: 12 },
  major:   { stroke: '#9ea3bc', widthM: 13,  minPx: 1.2 },
  rail:    { stroke: '#5b6073', widthM: 2.5, minPx: 0.8, dash: [6, 5] },
};

// Tiles are drawn by basemap-worker.js in the background, so dragging the map
// never waits on them. Browsers without OffscreenCanvas draw on the page.
class VectorBasemapProvider {
  constructor(drawTile) {
    this.tilingScheme = new Cesium.WebMercatorTilingScheme();
    this.tileWidth = BasemapRender.TILE_SIZE;
    this.tileHeight = BasemapRender.TILE_SIZE;
    this.minimumLevel = 0;
    this.maximumLevel = 19;
    this.rectangle = AREA_RECT;
    this.tileDiscardPolicy = undefined;
    this.errorEvent = new Cesium.Event();
    this.credit = new Cesium.Credit(
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors', true);
    this.proxy = undefined;
    this.hasAlphaChannel = false;
    this.ready = true;
    this.readyPromise = Promise.resolve(true);
    this._drawTile = drawTile;
  }

  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }

  requestImage(x, y, level) {
    const r = this.tilingScheme.tileXYToNativeRectangle(x, y, level);
    return this._drawTile({ west: r.west, south: r.south, east: r.east, north: r.north }, level);
  }
}

const BASEMAP_URL = 'data/basemap.json';
// Version tag so browsers pick up new worker code (matches the ?v= in index.html)
const BASEMAP_VERSION = new URL(document.querySelector('script[src*="basemap-render.js"]').src).search;

/** Resolves to a function (tile, level) => Promise<image>, or null if there's no basemap. */
async function startBasemap() {
  if (window.Worker && typeof OffscreenCanvas !== 'undefined') {
    try {
      return await startWorkerBasemap();
    } catch (e) {
      console.warn('Background map drawing unavailable, drawing on the page instead:', e);
    }
  }
  const basemap = await loadJson(BASEMAP_URL);
  if (!basemap) return null;
  const index = BasemapRender.buildIndex(basemap, AREA);
  return (tile, level) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = BasemapRender.TILE_SIZE;
    BasemapRender.drawTile(canvas.getContext('2d'), index, MAP_STYLE, tile, level);
    return Promise.resolve(canvas);
  };
}

function startWorkerBasemap() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`basemap-worker.js${BASEMAP_VERSION}`);
    const pending = new Map();
    let nextId = 1;

    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        resolve((tile, level) => new Promise((ok, fail) => {
          const id = nextId++;
          pending.set(id, { ok, fail });
          worker.postMessage({ type: 'tile', id, tile, level });
        }));
      } else if (data.type === 'failed') {
        worker.terminate();
        reject(new Error(data.message));
      } else {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        if (data.type === 'tile') job.ok(data.bitmap); else job.fail(new Error(data.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
    worker.postMessage({
      type: 'init',
      url: new URL(BASEMAP_URL, location.href).href,
      style: MAP_STYLE,
      area: AREA,
    });
  });
}

// ─── Viewer setup ─────────────────────────────────────────────────────────────
const viewer = new Cesium.Viewer('cesiumContainer', {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  baseLayer: false,   // the drawn basemap is added once its data has loaded
  useBrowserRecommendedResolution: false,   // see RENDER_PIXEL_RATIO below
  // Only redraw when something changes, instead of 60 times a second
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
  timeline: false,
  animation: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});

const scene = viewer.scene;
scene.globe.maximumScreenSpaceError = 2;   // default detail; the drawn basemap stays crisp
scene.globe.tileCacheSize = 1000;
scene.globe.baseColor = Cesium.Color.fromCssColorString(MAP_STYLE.background);
scene.globe.enableLighting = false;
scene.skyAtmosphere.show = true;
scene.fog.enabled = true;
scene.fog.density = 0.0002;
scene.postProcessStages.fxaa.enabled = true;

viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-09-15T19:00:00Z');
viewer.clock.shouldAnimate = false;

// ─── Performance: one steady resolution ───────────────────────────────────────
// Switching resolution at the start/end of every drag made the map flash, so
// render at a fixed ratio instead: close to Retina sharpness, much less work.
// Building names are page text, so they're always full sharpness anyway.
// 1 = one map pixel per screen pixel (fastest), 2 = full Retina (sharpest).
// Rendering cost scales with the square of this, so it's the biggest lever on
// how smooth dragging and zooming feel. Override with ?sharpness=1.5 to compare.
const RENDER_PIXEL_RATIO = Number(new URLSearchParams(location.search).get('sharpness')) || 1.25;
function applyPixelRatio() {
  viewer.resolutionScale = Math.min(1, RENDER_PIXEL_RATIO / (window.devicePixelRatio || 1));
}
applyPixelRatio();
window.addEventListener('resize', applyPixelRatio);

// ─── Camera ───────────────────────────────────────────────────────────────────
const CAMPUS_CENTER = Cesium.Cartesian3.fromDegrees(-88.2270, 40.1065, 220);
const HOME_VIEW = new Cesium.HeadingPitchRange(
  0,
  Cesium.Math.toRadians(-25),
  2200
);

function goHome() {
  viewer.camera.lookAt(CAMPUS_CENTER, HOME_VIEW);
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}
goHome();

const controller = scene.screenSpaceCameraController;
controller.minimumZoomDistance = 60;
controller.maximumZoomDistance = 6000;

const MIN_PITCH = Cesium.Math.toRadians(-90);
const MAX_PITCH = Cesium.Math.toRadians(-15);

scene.preRender.addEventListener(() => {
  const cam = viewer.camera;
  const pos = cam.positionCartographic;
  const lon = Cesium.Math.toDegrees(pos.longitude);
  const lat = Cesium.Math.toDegrees(pos.latitude);
  const clampedLon = Cesium.Math.clamp(lon, AREA.west, AREA.east);
  const clampedLat = Cesium.Math.clamp(lat, AREA.south, AREA.north);
  const clampedPitch = Cesium.Math.clamp(cam.pitch, MIN_PITCH, MAX_PITCH);

  if (clampedLon !== lon || clampedLat !== lat || clampedPitch !== cam.pitch) {
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(clampedLon, clampedLat, pos.height),
      orientation: { heading: cam.heading, pitch: clampedPitch, roll: 0 },
    });
  }
});

// Trackpad pinch arrives as a ctrl+wheel event, which Cesium ignores and Chrome
// would use to zoom the page. Turn it into a normal, amplified wheel event.
const PINCH_SPEED = 6;
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || e.target !== scene.canvas) return;
  e.preventDefault();
  e.stopPropagation();
  scene.canvas.dispatchEvent(new WheelEvent('wheel', {
    deltaY: e.deltaY * PINCH_SPEED,
    deltaMode: 0,
    clientX: e.clientX,
    clientY: e.clientY,
    bubbles: true,
    cancelable: true,
  }));
}, { capture: true, passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(CAMPUS_CENTER, 1), {
    offset: HOME_VIEW,
    duration: 1.2,
  });
});

// ─── Buildings ────────────────────────────────────────────────────────────────
let buildingsTileset = null;

// Cesium's defaults load campus fastest. (Tested: skipping detail levels made
// first load ~5x slower.) The two settings below trade a little building
// detail for speed on laptops.
const BUILDING_TILESET_OPTIONS = {
  maximumScreenSpaceError: 24,   // default 16: fewer, coarser building tiles
  cacheBytes: 256 * 1024 * 1024, // default 512MB: lighter on memory
};

async function loadBuildings() {
  try {
    buildingsTileset = scene.primitives.add(await Cesium.createOsmBuildingsAsync(BUILDING_TILESET_OPTIONS));
    performance.mark('buildings-tileset-ready');
    buildingsTileset.tileLoad.addEventListener(labelTileBuildings);
    buildingsTileset.tileLoad.addEventListener(() => {
      if (!performance.getEntriesByName('buildings-first-tile').length) performance.mark('buildings-first-tile');
    });
    buildingsTileset.initialTilesLoaded.addEventListener(() => {
      performance.mark('buildings-all-in-view');
      document.getElementById('loading')?.classList.add('done');
      startAnalytics();
      track('map_ready', {
        seconds_to_buildings: +(performance.now() / 1000).toFixed(1),
        device: deviceKind(),
        buildings_with_data: knownBuildings().length,
      });
    });
    applyStyle();
  } catch (e) {
    console.error('OSM Buildings failed to load:', e);
    document.getElementById('loading')?.classList.add('done');
    startAnalytics();
    track('map_failed', { reason: String(e).slice(0, 120) });
  }
}

// Places drawn by us rather than coming from the building tiles.
const overlays = new Map();
// Solid, muted building colours in the style of a clean vector map.
const NO_DATA_HEX = '#6f5c63';
const CLOSED_HEX  = '#3a3f4f';
const NO_DATA_COLOR = Cesium.Color.fromCssColorString(NO_DATA_HEX);

function colorFor(occ) {
  if (!occ) return { hex: NO_DATA_HEX, alpha: 1 };
  if (occ.source === 'closed') return { hex: CLOSED_HEX, alpha: 1 };
  if (occ.source === 'unknown') return { hex: NO_DATA_HEX, alpha: 1 };
  return { hex: occToColor(occ.value), alpha: 1 };
}

function createOverlays() {
  for (const [name, cfg] of Object.entries(BUILDINGS)) {
    const shape = cfg.shape;
    if (!shape) continue;
    const entity = viewer.entities.add({
      name,
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(shape.outline.flat()),
        height: shape.baseM,
        extrudedHeight: shape.topM,
        // One material we recolour in place. Replacing it would make Cesium
        // rebuild the shape, which shows up as a flicker.
        material: new Cesium.ColorMaterialProperty(NO_DATA_COLOR.clone()),
      },
      properties: { place: name },
    });
    overlays.set(name, entity);
  }
}

function applyOverlayColors() {
  for (const [name, entity] of overlays) {
    // Solid, so the building underneath doesn't tint it.
    const { hex } = colorFor(buildingOccupancy(name));
    const colour = Cesium.Color.fromCssColorString(hex);
    const current = entity.polygon.material.color;
    if (!Cesium.Color.equals(current.getValue(), colour)) current.setValue(colour);
  }
}

let lastStyleSignature = null;

function applyStyle() {
  applyOverlayColors();
  if (!buildingsTileset) return;

  const conditions = [];
  for (const name of knownBuildings()) {
    if (overlays.has(name)) continue;
    const occ = buildingOccupancy(name);
    if (!occ) continue;
    const safe = name.replace(/'/g, "\\'");
    const { hex, alpha } = colorFor(occ);
    conditions.push([`\${name} === '${safe}'`, `color('${hex}', ${alpha})`]);
  }
  conditions.push(['true', `color('${NO_DATA_HEX}', 1)`]);

  // Rebuilding the style makes every building re-evaluate, so only do it when
  // the colours actually changed.
  const signature = conditions.join('|');
  if (signature === lastStyleSignature) return;
  lastStyleSignature = signature;

  const inArea =
    `\${feature['cesium#longitude']} > ${AREA.west} && \${feature['cesium#longitude']} < ${AREA.east} && ` +
    `\${feature['cesium#latitude']} > ${AREA.south} && \${feature['cesium#latitude']} < ${AREA.north}`;

  buildingsTileset.style = new Cesium.Cesium3DTileStyle({ color: { conditions }, show: inArea });
  scene.requestRender();
}

// ─── Building labels ──────────────────────────────────────────────────────────
// Floating names for the buildings we have data on. Positions come from the
// building tiles as they load (each building knows its own centre and height).
// Drawn as regular page text on top of the map (not inside it), so the names
// stay sharp even while the map drops resolution during a drag.
const labelled = new Set();
const labels = [];
const LABEL_RANGE_M = 2600;
// Ellipsoid height of the ground on campus. Campus is flat (±3 m), so labels use
// this instead of looking up terrain under every label (that cost dozens of
// extra terrain downloads on page load).
const APPROX_GROUND_M = 192;
const labelLayer = document.getElementById('labels');

// Places students go to study or hang out get their labels first.
const STUDY_TYPES = new Set(['library', 'study', 'atrium', 'union', 'dining', 'rec']);
function labelPriority(name) {
  const cfg = configFor(name);
  return cfg?.labelPriority ?? (STUDY_TYPES.has(cfg?.type) ? 1 : 0);
}

function wrapName(name, max = 22) {
  const lines = [''];
  for (const word of name.split(' ')) {
    const line = lines[lines.length - 1];
    if (line && (line + ' ' + word).length > max) lines.push(word);
    else lines[lines.length - 1] = line ? line + ' ' + word : word;
  }
  return lines;
}

function addLabel(name, lon, lat, aboveGroundM, absoluteM) {
  if (labelled.has(name)) return;
  labelled.add(name);

  const el = document.createElement('div');
  el.className = 'map-label';
  const text = document.createElement('div');
  text.className = 'map-label-text';
  const lines = wrapName(BUILDINGS[name]?.label ?? name);
  text.textContent = lines.join('\n');
  const dot = document.createElement('div');
  dot.className = 'map-label-dot';
  el.append(text, dot);
  el.classList.add('is-hidden');
  labelLayer.append(el);

  const label = {
    name, el, lines, visible: false,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, absoluteM ?? APPROX_GROUND_M + aboveGroundM),
  };
  labels.push(label);
  scene.requestRender();
}

// Position every label for the current view, hiding ones that are far away,
// off screen, or would overlap a nearer label.
const scratchWindow = new Cesium.Cartesian2();
function placeLabels() {
  const camera = viewer.camera.positionWC;
  const width = scene.canvas.clientWidth, height = scene.canvas.clientHeight;
  // Nearest labels win, with two adjustments: study spots (libraries, the
  // Union, dining, gyms, BIF…) count as nearer so they survive crowding, and a
  // label already on screen gets a 15% head start so labels don't flicker.
  const items = labels
    .map(label => {
      const distance = Cesium.Cartesian3.distance(camera, label.position);
      const priority = labelPriority(label.name);
      return { label, distance, rank: distance * (priority ? 0.65 : 1) * (label.visible ? 0.85 : 1) };
    })
    .sort((a, b) => a.rank - b.rank);

  const taken = [];
  for (const { label, distance } of items) {
    let win = null;
    if (distance < LABEL_RANGE_M) {
      win = Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, label.position, scratchWindow);
    }
    let show = !!win && win.x > -100 && win.x < width + 100 && win.y > -50 && win.y < height + 100;
    let scale = 1;
    if (show) {
      scale = distance < 400 ? 1.05 : 1.05 - 0.3 * (distance - 400) / (LABEL_RANGE_M - 400);
      const w = Math.max(...label.lines.map(l => l.length)) * 7.2 * scale + 10;
      const h = label.lines.length * 16 * scale + 14;
      const box = [win.x - w / 2, win.y - h, win.x + w / 2, win.y + 4];
      show = !taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (show) taken.push(box);
    }
    if (show) {
      label.el.style.transform =
        `translate(${win.x.toFixed(1)}px, ${win.y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
    }
    if (label.visible !== show) {
      label.visible = show;
      label.el.classList.toggle('is-hidden', !show);
    }
  }
}

scene.postRender.addEventListener(placeLabels);

function labelTileBuildings(tile) {
  if (!data.classActivity && !data.hours) {   // data not here yet — label later
    pendingLabelTiles.push(tile);
    return;
  }
  const content = tile.content;
  if (!content?.featuresLength) return;
  const known = new Set(knownBuildings());
  for (let i = 0; i < content.featuresLength; i++) {
    const feature = content.getFeature(i);
    const name = feature.getProperty('name');
    if (!name || !known.has(name) || labelled.has(name)) continue;
    const [lon, lat] = BUILDINGS[name]?.labelAt ?? [
      feature.getProperty('cesium#longitude'),
      feature.getProperty('cesium#latitude'),
    ];
    addLabel(name, lon, lat, feature.getProperty('cesium#estimatedHeight') || 10);
  }
}

// Centre of a polygon's area (not the average of its points, which leans
// toward curved edges that have many points).
function areaCentre(outline) {
  const [ox, oy] = outline[0];   // work relative to the first point for precision
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const xa = outline[j][0] - ox, ya = outline[j][1] - oy;
    const xb = outline[i][0] - ox, yb = outline[i][1] - oy;
    const cross = xa * yb - xb * ya;
    area += cross; cx += (xa + xb) * cross; cy += (ya + yb) * cross;
  }
  area /= 2;
  return [ox + cx / (6 * area), oy + cy / (6 * area)];
}

const pendingLabelTiles = [];
function labelPendingTiles() {
  while (pendingLabelTiles.length) labelTileBuildings(pendingLabelTiles.pop());
}

function labelOverlays() {
  for (const [name, cfg] of Object.entries(BUILDINGS)) {
    const outline = cfg.shape?.outline;
    if (!outline) continue;
    const [lon, lat] = cfg.labelAt ?? areaCentre(outline);
    addLabel(name, lon, lat, 0, cfg.shape.topM + 2);
  }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip  = document.getElementById('tooltip');
const ttName   = document.getElementById('tt-name');
const ttOcc    = document.getElementById('tt-occ');
const ttStatus = document.getElementById('tt-status');
const ttSource = document.getElementById('tt-source');
const ttNote   = document.getElementById('tt-note');
const ttFill   = document.getElementById('tt-fill');
const ttSpaces = document.getElementById('tt-spaces');

function occText(occ) {
  if (!occ) return { text: 'No data', color: '#5a6478' };
  if (occ.source === 'closed') return { text: occ.cardAccess ? 'Closed*' : 'Closed', color: '#5a6478' };
  if (occ.source === 'unknown') return { text: 'Hours unknown', color: '#5a6478' };
  return { text: `${statusLabel(occ.value)} · ${Math.round(occ.value * 100)}%`, color: cssColor(occ.value) };
}

function renderSpaces(container, spaces) {
  container.replaceChildren();
  for (const { space, occ } of spaces || []) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const label = document.createElement('span');
    label.textContent = space;
    const value = document.createElement('span');
    const { text, color } = occText(occ);
    value.textContent = text;
    value.style.color = color;
    row.append(label, value);
    container.append(row);
  }
  container.hidden = !(spaces && spaces.length);
}

function showTooltip(x, y, name, occ) {
  ttName.textContent = name;
  ttOcc.textContent = Math.round(occ.value * 100) + '%';
  const inactive = occ.source === 'closed' || occ.source === 'unknown';
  ttStatus.textContent = occ.source === 'closed' ? (occ.cardAccess ? 'Closed*' : 'Closed')
    : occ.source === 'unknown' ? 'Hours unknown'
    : statusLabel(occ.value);
  ttStatus.style.color = inactive ? '#5a6478' : cssColor(occ.value);
  ttSource.textContent = SOURCE_LABELS[occ.source] || '';
  ttNote.textContent = occ.note || '';
  renderSpaces(ttSpaces, occ.spaces);
  ttFill.style.width = (occ.value * 100) + '%';
  ttFill.style.background = cssColor(occ.value);

  let tx = x + 18, ty = y - 20;
  if (tx + 250 > window.innerWidth)  tx = x - 268;
  const height = tooltip.offsetHeight || 200;
  if (ty + height > window.innerHeight) ty = y - height - 10;
  tooltip.style.left = tx + 'px';
  tooltip.style.top  = ty + 'px';
  tooltip.classList.add('show');
}

function hideTooltip() {
  tooltip.classList.remove('show');
}

// Which of our own shapes (if any) contains the point under the cursor.
function overlayAt(position) {
  if (!overlays.size) return null;
  let point = scene.pickPositionSupported ? scene.pickPosition(position) : undefined;
  if (!Cesium.defined(point)) {
    const ray = viewer.camera.getPickRay(position);
    point = ray && scene.globe.pick(ray, scene);
  }
  if (!Cesium.defined(point)) return null;

  const carto = Cesium.Cartographic.fromCartesian(point);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  for (const name of overlays.keys()) {
    if (pointInOutline(lon, lat, BUILDINGS[name].shape.outline)) return name;
  }
  return null;
}

function pointInOutline(lon, lat, outline) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i], [xj, yj] = outline[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildingNameAt(position) {
  const overlay = overlayAt(position);
  if (overlay) return overlay;

  const picked = scene.pick(position);
  if (!Cesium.defined(picked)) return null;

  // Our own shapes (e.g. the dining hall) come back as entities.
  if (picked.id instanceof Cesium.Entity) {
    const place = picked.id.properties?.place?.getValue();
    return place && knownBuildings().includes(place) ? place : null;
  }

  if (!picked.getProperty) return null;
  const name = picked.getProperty('name');
  if (!name) return null;
  const exact = knownBuildings().find(known => known === String(name).trim());
  return exact || null;
}

// Picking is expensive: at most once per frame, and never while dragging.
let dragging = false;
let pendingPick = null;

scene.canvas.addEventListener('pointerdown', () => { dragging = true; hideTooltip(); });
window.addEventListener('pointerup', () => { dragging = false; });

// A building counts as "looked at" after the tooltip has been up for a second,
// once per building per visit.
const viewedBuildings = new Set();
let hoverTimer = null;
let hoverName = null;

function noteHover(name, occ) {
  if (name === hoverName) return;
  hoverName = name;
  clearTimeout(hoverTimer);
  if (!name || viewedBuildings.has(name)) return;
  hoverTimer = setTimeout(() => {
    viewedBuildings.add(name);
    track('building_viewed', {
      building: name,
      status: occ.source === 'closed' ? 'closed' : occ.source === 'unknown' ? 'no data' : statusLabel(occ.value),
      source: SOURCE_LABELS[occ.source] || occ.source,
    });
  }, 1000);
}

function pickUnderMouse() {
  const position = pendingPick;
  pendingPick = null;
  const name = buildingNameAt(position);
  const occ = name ? buildingOccupancy(name) : null;
  if (name && occ) {
    showTooltip(position.x, position.y, name, occ);
    scene.canvas.style.cursor = 'pointer';
    noteHover(name, occ);
  } else {
    hideTooltip();
    scene.canvas.style.cursor = 'default';
    noteHover(null);
  }
}

const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

handler.setInputAction((movement) => {
  if (dragging) return;
  if (!pendingPick) requestAnimationFrame(pickUnderMouse);
  pendingPick = Cesium.Cartesian2.clone(movement.endPosition);
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// ─── Check-in panel ───────────────────────────────────────────────────────────
const panel      = document.getElementById('panel');
const panelName  = document.getElementById('panel-name');
const panelNow   = document.getElementById('panel-now');
const panelNote  = document.getElementById('panel-note');
const panelThanks = document.getElementById('panel-thanks');
const panelSpaces = document.getElementById('panel-spaces');
let panelBuilding = null;
let panelSpace = null;

// The id check-ins are stored under: the space if one is picked, else the building.
function panelTarget() {
  return panelSpace ? spaceId(panelBuilding, panelSpace) : panelBuilding;
}

function renderSpacePicker(name) {
  const spaces = spacesOf(name);
  panelSpaces.replaceChildren();
  panelSpaces.hidden = !spaces.length;
  for (const space of spaces) {
    const button = document.createElement('button');
    button.className = 'space-btn' + (space === panelSpace ? ' selected' : '');
    button.textContent = space;
    button.addEventListener('click', () => {
      panelSpace = space;
      openPanel(name);
    });
    panelSpaces.append(button);
  }
}

function openPanel(name, keepThanks = false) {
  if (name !== panelBuilding) {
    panelBuilding = name;
    panelSpace = spacesOf(name)[0] || null;
  }
  renderSpacePicker(name);
  const occ = occupancyFor(panelTarget());
  panelName.textContent = name;
  panelNow.textContent = !occ ? 'No data yet'
    : occ.source === 'closed' ? (occ.cardAccess ? 'Public doors locked · i-card may work' : 'Closed right now')
    : occ.source === 'unknown' ? 'Hours not published — no estimate right now'
    : `${SOURCE_LABELS[occ.source]} · ${Math.round(occ.value * 100)}% full`;
  panelNote.textContent = sharedCheckins()
    ? 'Shared with everyone using the map.'
    : 'Saved on this device only — no server yet.';
  if (!keepThanks) panelThanks.textContent = '';
  panel.classList.add('show');
}

function closePanel() {
  panel.classList.remove('show');
  panelBuilding = null;
  panelSpace = null;
}

async function submitCheckin(level) {
  if (!panelBuilding) return;
  const report = { building: panelTarget(), level, at: Date.now(), mine: true };
  data.checkins.push(report);
  saveLocalCheckins();
  track('checkin_submitted', { building: report.building, level, device: deviceKind() });

  refresh({ keepThanks: true });
  panelThanks.textContent = sharedCheckins() ? 'Thanks — sharing…' : 'Thanks — the map has been updated.';

  const result = await sendCheckin(report);
  if (result === 'rate-limited') {
    // Already reported this building in the last minute — drop the duplicate.
    data.checkins = data.checkins.filter(r => r !== report);
    saveLocalCheckins();
    refresh({ keepThanks: true });
    panelThanks.textContent = 'You just reported this one — try again in a minute.';
    return;
  }
  panelThanks.textContent = result === 'ok' ? 'Thanks — everyone sees this now.'
    : sharedCheckins() ? 'Thanks — saved here (could not reach the server).'
    : 'Thanks — the map has been updated.';
  if (result === 'ok') fetchSharedCheckins();
}

document.querySelectorAll('#panel .checkin-btn').forEach(button => {
  button.addEventListener('click', () => submitCheckin(button.dataset.level));
});
document.getElementById('panel-close').addEventListener('click', closePanel);

handler.setInputAction((click) => {
  const name = buildingNameAt(click.position);
  if (name) {
    openPanel(name);
    const occ = buildingOccupancy(name);
    track('building_opened', { building: name, device: deviceKind(), source: SOURCE_LABELS[occ?.source] || 'none' });
  } else {
    closePanel();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ─── Summary chips ────────────────────────────────────────────────────────────
function updateStats() {
  let quiet = 0, moderate = 0, busy = 0;
  for (const name of knownBuildings()) {
    const occ = buildingOccupancy(name);
    if (!occ || occ.source === 'closed' || occ.source === 'unknown') continue;
    if (occ.value < 0.4) quiet++;
    else if (occ.value < 0.7) moderate++;
    else busy++;
  }
  document.getElementById('s-quiet').textContent = quiet;
  document.getElementById('s-mod').textContent   = moderate;
  document.getElementById('s-busy').textContent  = busy;
}

function updateHeader() {
  const sources = [];
  if (data.popularTimes?.places) sources.push('Google');
  if (data.classActivity?.buildings) sources.push('class schedules');
  const period = calendarPeriod(campusNow().date);
  const base = sources.length
    ? `Live estimates from ${sources.join(' + ')}`
    : 'University of Illinois Urbana-Champaign';
  document.getElementById('header-sub').textContent = period.label ? `${base} · ${period.label}` : base;
}

function refresh({ keepThanks = false } = {}) {
  updateHeader();
  applyStyle();
  updateStats();
  if (panelBuilding) openPanel(panelBuilding, keepThanks);
}

// ─── Start ────────────────────────────────────────────────────────────────────
(async function start() {
  // Buildings take longest, so start them first; they're coloured once our
  // data arrives.
  const buildingsLoading = loadBuildings();
  const [classActivity, popularTimes, hours, drawTile] = await Promise.all([
    loadJson('data/class_activity.json'),
    loadJson('data/popular_times.json'),
    loadJson('data/building_hours.json'),
    startBasemap(),
  ]);
  performance.mark('data-and-basemap-ready');
  if (drawTile) {
    viewer.imageryLayers.add(new Cesium.ImageryLayer(new VectorBasemapProvider(drawTile), { rectangle: AREA_RECT }));
  }
  data.classActivity = classActivity;
  data.popularTimes = popularTimes;
  data.hours = hours;

  updateHeader();
  createOverlays();
  labelOverlays();
  labelPendingTiles();
  refresh();
  await buildingsLoading;
  refresh();

  // Busyness changes with the hour; recheck every five minutes.
  setInterval(refresh, 5 * 60 * 1000);

  // Other people's reports: load now, then keep an open page current.
  if (sharedCheckins()) {
    fetchSharedCheckins();
    setInterval(fetchSharedCheckins, CHECKINS_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchSharedCheckins();
    });
  }
})();
