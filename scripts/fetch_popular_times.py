#!/usr/bin/env python3
"""
Fetch Google Maps "Popular times" for campus places via SerpApi.

Usage:
  export SERPAPI_KEY=your_key_here
  python3 scripts/fetch_popular_times.py --dry-run          # show what would run, uses 0 searches
  python3 scripts/fetch_popular_times.py --only "Main Library"   # test one place (1 search)
  python3 scripts/fetch_popular_times.py                    # fetch everything

Output:
  data/popular_times.json   clean data the map will read
  data/raw/<place>.json     full SerpApi response, for checking/debugging

Each fetch costs one SerpApi search per place. Never put the API key in index.html.
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
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
OUT_FILE = DATA_DIR / "popular_times.json"

CAMPUS_LL = "@40.1065,-88.2270,15z"

# Places with Google popular times, checked by hand.
#   key       -> exact OpenStreetMap building name (what the 3D map uses)
#   query     -> what to search on Google Maps
#   expect    -> words that must appear in Google's result title, so we never
#                attach data to the wrong place
PLACES = {
    "Main Library": {
        "query": "Main Library, 1408 W Gregory Dr, Urbana, IL",
        "expect": ["main library"],
    },
    "Grainger Engineering Library": {
        "query": "Grainger Engineering Library Information Center, Urbana, IL",
        "expect": ["grainger"],
    },
    "Activities and Recreation Center": {
        "query": "Activities and Recreation Center, Champaign, IL",
        "expect": ["activities and recreation"],
    },
    "Illini Union Bookstore": {
        "query": "Illini Union Bookstore, Champaign, IL",
        "expect": ["illini union bookstore"],
    },
    "Gregory Hall": {
        "query": "Gregory Hall, University of Illinois, Urbana, IL",
        "expect": ["gregory hall"],
    },
}

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def serpapi_search(params, api_key):
    params = {**params, "api_key": api_key}
    url = "https://serpapi.com/search.json?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def parse_hour(label):
    """'6 AM' -> 6, '12 PM' -> 12, '1 PM' -> 13. Returns None if unrecognised."""
    m = re.match(r"\s*(\d{1,2})\s*([AaPp])\.?\s*[Mm]", str(label or ""))
    if not m:
        return None
    hour = int(m.group(1)) % 12
    return hour + 12 if m.group(2).lower() == "p" else hour


def parse_popular_times(place):
    """Pull weekly + live busyness out of SerpApi's place_results, defensively."""
    popular = place.get("popular_times") or {}
    graph = popular.get("graph_results") or {}

    weekly = {}
    for day in DAYS:
        hours = []
        for entry in graph.get(day) or []:
            hour = parse_hour(entry.get("time"))
            score = entry.get("busyness_score")
            if hour is not None and isinstance(score, (int, float)):
                hours.append({"hour": hour, "busyness": score})
        if hours:
            weekly[day] = hours

    live = popular.get("live_hash") or None
    return weekly, live


def fetch_place(name, cfg, api_key):
    response = serpapi_search(
        {"engine": "google_maps", "type": "search", "q": cfg["query"], "ll": CAMPUS_LL},
        api_key,
    )

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")
    (RAW_DIR / f"{safe}.json").write_text(json.dumps(response, indent=2))

    if "error" in response:
        raise RuntimeError(response["error"])

    place = response.get("place_results")
    if not place:
        candidates = [r.get("title") for r in response.get("local_results") or []][:5]
        raise RuntimeError(
            f"Google returned a list instead of one place. Candidates: {candidates}. "
            "Make the query more specific."
        )

    title = place.get("title", "")
    if not all(word in title.lower() for word in cfg["expect"]):
        raise RuntimeError(f"Result title '{title}' doesn't look like '{name}'. Skipped.")

    weekly, live = parse_popular_times(place)
    return {
        "google_title": title,
        "address": place.get("address"),
        "place_id": place.get("place_id"),
        "weekly": weekly,
        "live": live,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="fetch just this place (exact key from PLACES)")
    parser.add_argument("--dry-run", action="store_true", help="list places without searching")
    args = parser.parse_args()

    places = PLACES
    if args.only:
        if args.only not in PLACES:
            sys.exit(f"Unknown place '{args.only}'. Options: {', '.join(PLACES)}")
        places = {args.only: PLACES[args.only]}

    if args.dry_run:
        for name, cfg in places.items():
            print(f"{name:35} <- search: {cfg['query']}")
        print(f"\nWould use {len(places)} SerpApi search(es).")
        return

    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key:
        sys.exit("Set SERPAPI_KEY first:  export SERPAPI_KEY=your_key_here")

    # Merge into existing data so a single-place test doesn't wipe the rest
    existing = json.loads(OUT_FILE.read_text()) if OUT_FILE.exists() else {"places": {}}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for name, cfg in places.items():
        try:
            result = fetch_place(name, cfg, api_key)
            result["fetched_at"] = now
            existing["places"][name] = result
            days = len(result["weekly"])
            live = "yes" if result["live"] else "no"
            print(f"OK    {name}: '{result['google_title']}' — {days} days of data, live: {live}")
            if not days:
                print("      (no popular times in the response — check data/raw/ to see what came back)")
        except Exception as e:
            print(f"FAIL  {name}: {e}")

    existing["updated_at"] = now
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(existing, indent=2))
    print(f"\nSaved {OUT_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
