#!/usr/bin/env python3
"""
Fetch opening hours from Google Maps listings (via SerpApi) into
data/google_hours.json. build_hours.py then uses them above every other source:
Google says when a place is actually open to people, while the campus
spreadsheet only says when Facilities unlocks the doors.

Usage:
  export SERPAPI_KEY=your_key_here
  python3 scripts/fetch_google_hours.py --dry-run           # 0 searches
  python3 scripts/fetch_google_hours.py --only "Illini Union"
  python3 scripts/fetch_google_hours.py                     # all places below

Budget: one search per place. The free SerpApi plan allows 250/month, so the
list below is the public-facing buildings where Google is likely to be both
present and right — run it monthly, or weekly for a shorter list.

Nothing is guessed: a listing that doesn't match the expected name, or hours we
can't parse exactly, is skipped and reported.
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "data" / "google_hours.json"
CAMPUS_LL = "@40.1065,-88.2270,15z"

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

# map building name -> what to search, and words the result's title must contain
PLACES = {
    "Illini Union Bookstore": ("Illini Union Bookstore, Champaign, IL", ["bookstore"]),
    "Illini Union":           ("Illini Union, Champaign, IL", ["illini union"]),
    "Main Library":           ("Main Library, 1408 W Gregory Dr, Urbana, IL", ["main library"]),
    "Grainger Engineering Library": ("Grainger Engineering Library Information Center, Urbana, IL", ["grainger"]),
    "Funk Library":           ("Funk ACES Library, Urbana, IL", ["funk"]),
    "Activities and Recreation Center": ("Activities and Recreation Center, Champaign, IL", ["activities and recreation"]),
    "Campus Recreation Center East":   ("Campus Recreation Center East, Urbana, IL", ["campus recreation center east"]),
    "Campus Instructional Facility":   ("Campus Instructional Facility, Urbana, IL", ["campus instructional"]),
    "Business Instructional Facility": ("Business Instructional Facility, Champaign, IL", ["business instructional"]),
    "Student Dining and Residential Programs (SDRP)": ("Ikenberry Dining Center, Champaign, IL", ["ikenberry", "dining"]),
    "Krannert Center for the Performing Arts": ("Krannert Center for the Performing Arts, Urbana, IL", ["krannert"]),
    "Spurlock Museum":        ("Spurlock Museum, Urbana, IL", ["spurlock"]),
    "Ice Arena":              ("University of Illinois Ice Arena, Champaign, IL", ["ice arena"]),
}


def serpapi(params, api_key):
    url = "https://serpapi.com/search.json?" + urllib.parse.urlencode({**params, "api_key": api_key})
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def parse_clock(text):
    """'8 AM' / '8:30 PM' / 'noon' / 'midnight' -> hours as a number, or None."""
    text = text.strip().lower().replace(".", "")
    if text in ("noon", "12 noon"):
        return 12.0
    if text in ("midnight", "12 midnight"):
        return 24.0
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*([ap])m?", text)
    if not m:
        return None
    hour = int(m.group(1)) % 12
    minute = int(m.group(2) or 0)
    if m.group(3) == "p":
        hour += 12
    return hour + minute / 60


def parse_day_hours(text):
    """'8 AM–6 PM' -> [[8, 18]]; 'Closed' -> []; '24 hours' -> [[0, 24]]; None if unclear."""
    if not text:
        return None
    text = text.strip().lower().replace(" ", " ")
    if "closed" in text:
        return []
    if "24 hours" in text or text == "open 24 hours":
        return [[0, 24]]

    ranges = []
    for span in re.split(r",|\band\b", text):
        span = span.strip()
        if not span:
            continue
        m = re.fullmatch(r"(.+?)\s*[–\-—to]+\s*(.+)", span)
        if not m:
            return None
        start, end = parse_clock(m.group(1)), parse_clock(m.group(2))
        if start is None or end is None:
            return None
        if end <= start:
            end += 24                      # runs past midnight
        ranges.append([round(start, 2), round(end, 2)])
    return ranges or None


def hours_from_place(place):
    """SerpApi place_results -> {day: [[open, close], …]} or None."""
    raw = place.get("hours") or place.get("operating_hours")
    by_day = {}
    if isinstance(raw, list):              # [{"monday": "8 AM–6 PM"}, …]
        for entry in raw:
            for day, text in entry.items():
                by_day[day.strip().lower()] = text
    elif isinstance(raw, dict):            # {"monday": "8 am–6 pm", …}
        by_day = {k.strip().lower(): v for k, v in raw.items()}
    else:
        return None

    week = {}
    for day in DAYS:
        parsed = parse_day_hours(by_day.get(day))
        if parsed is None:
            return None                    # incomplete or unreadable: use nothing
        week[day] = parsed
    return week


def fetch(name, query, expect, api_key):
    response = serpapi({"engine": "google_maps", "type": "search", "q": query, "ll": CAMPUS_LL}, api_key)
    if "error" in response:
        raise RuntimeError(response["error"])
    place = response.get("place_results")
    if not place:
        candidates = [r.get("title") for r in response.get("local_results") or []][:5]
        raise RuntimeError(f"no single match (candidates: {candidates})")
    title = place.get("title", "")
    if not all(word in title.lower() for word in expect):
        raise RuntimeError(f"result '{title}' doesn't look like this building")
    week = hours_from_place(place)
    if not week:
        raise RuntimeError("no readable hours in the listing")
    return {"google_title": title, "weekly": week}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="just this building (exact key from PLACES)")
    parser.add_argument("--dry-run", action="store_true", help="list what would be searched")
    args = parser.parse_args()

    places = PLACES if not args.only else {args.only: PLACES.get(args.only)}
    if args.only and not places[args.only]:
        sys.exit(f"Unknown building '{args.only}'. Options: {', '.join(PLACES)}")

    if args.dry_run:
        for name, (query, _) in places.items():
            print(f"{name:48} <- {query}")
        print(f"\nWould use {len(places)} SerpApi search(es).")
        return

    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key:
        sys.exit("Set SERPAPI_KEY first:  export SERPAPI_KEY=your_key_here")

    existing = json.loads(OUT_FILE.read_text()) if OUT_FILE.exists() else {"buildings": {}}
    for name, (query, expect) in places.items():
        try:
            result = fetch(name, query, expect, api_key)
            existing["buildings"][name] = result
            print(f"OK    {name}: '{result['google_title']}' — {result['weekly']['monday']} Mon")
        except Exception as e:
            print(f"SKIP  {name}: {e}")

    existing["built_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(existing, indent=1))
    print(f"\nWrote {OUT_FILE.relative_to(ROOT)} ({len(existing['buildings'])} buildings)")
    print("Now run: python3 scripts/build_hours.py")


if __name__ == "__main__":
    main()
