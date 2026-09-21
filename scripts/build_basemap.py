#!/usr/bin/env python3
"""
Build data/basemap.json: the roads, paths, lawns, water and rail the map draws
itself (instead of using satellite photos or a third-party tile service).

Data © OpenStreetMap contributors (ODbL) — the page shows this credit.

Usage:
  python3 scripts/build_basemap.py              # download from Overpass
  python3 scripts/build_basemap.py --input raw.json   # reuse a saved download

Rerun occasionally to pick up map changes (new paths, construction, …).
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "data" / "basemap.json"

# Same area as the map (Champaign–Urbana)
WEST, SOUTH, EAST, NORTH = -88.33, 40.06, -88.16, 40.16
SCALE = 1e6   # coordinates stored as integer 1e-6 degree steps (~10 cm), so lines stay straight up close

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

BBOX = f"({SOUTH},{WEST},{NORTH},{EAST})"
QUERY = f"""[out:json][timeout:180];(
way["highway"]{BBOX};
way["railway"="rail"]{BBOX};
way["waterway"~"^(river|stream|canal|ditch)$"]{BBOX};
way["natural"="water"]{BBOX};
relation["natural"="water"]{BBOX};
way["leisure"~"^(park|pitch|garden|golf_course|playground|recreation_ground|nature_reserve|common)$"]{BBOX};
relation["leisure"~"^(park|golf_course|nature_reserve)$"]{BBOX};
way["landuse"~"^(grass|recreation_ground|cemetery|meadow|forest|village_green|farmland)$"]{BBOX};
relation["landuse"~"^(grass|cemetery|forest|farmland)$"]{BBOX};
way["natural"~"^(wood|grassland|scrub)$"]{BBOX};
way["amenity"="parking"]{BBOX};
);out geom tags;"""

# Layer names, in drawing order (the page draws them in this order).
LAYERS = ["farm", "wood", "green", "parking", "water",
          "stream", "path", "service", "minor", "major", "rail"]

MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MINOR = {"residential", "unclassified", "living_street", "busway", "road", "construction"}
PATHS = {"footway", "cycleway", "path", "pedestrian", "steps", "track", "bridleway"}
GREEN = {"park", "pitch", "garden", "golf_course", "playground", "recreation_ground",
         "common", "grass", "cemetery", "meadow", "village_green", "grassland", "nature_reserve"}


def classify(tags):
    """Layer name for an OSM element, or None to skip it."""
    hw = tags.get("highway")
    if hw:
        # Sidewalks and crossings just double the road lines; indoor and
        # underground paths aren't visible from above — skip them all.
        if tags.get("footway") in ("sidewalk", "crossing") or tags.get("area") == "yes":
            return None
        if tags.get("tunnel") in ("yes", "building_passage") or tags.get("indoor") == "yes":
            return None
        if tags.get("level", "0").startswith("-"):
            return None
        if hw in MAJOR:
            return "major"
        if hw in MINOR:
            return "minor"
        if hw == "service":
            # Parking-lot aisles and driveways are mostly visual clutter.
            if tags.get("service") in ("parking_aisle", "driveway", "drive-through"):
                return None
            return "service"
        if hw in PATHS:
            return "path"
        return None
    if tags.get("railway") == "rail":
        return None if tags.get("service") in ("yard", "siding", "spur") else "rail"
    if tags.get("waterway"):
        return "stream"
    if tags.get("natural") == "water":
        return "water"
    if tags.get("amenity") == "parking":
        return "parking"
    landcover = tags.get("leisure") or tags.get("landuse") or tags.get("natural")
    if landcover in ("wood", "forest", "scrub"):
        return "wood"
    if landcover == "farmland":
        return "farm"
    if landcover in GREEN:
        return "green"
    return None


def download():
    last_error = None
    for mirror in MIRRORS:
        try:
            body = urllib.parse.urlencode({"data": QUERY}).encode()
            req = urllib.request.Request(mirror, data=body,
                                         headers={"User-Agent": "uiuc-study-space/0.1"})
            with urllib.request.urlopen(req, timeout=240) as resp:
                return json.load(resp)
        except Exception as e:   # try the next mirror
            last_error = e
            print(f"  {mirror} failed: {e}", file=sys.stderr)
            time.sleep(3)
    raise SystemExit(f"All Overpass mirrors failed: {last_error}")


def encode(points):
    """[(lon, lat), …] → flat delta-encoded integers [x0, y0, dx1, dy1, …]."""
    out, px, py = [], 0, 0
    for i, (lon, lat) in enumerate(points):
        x = round((lon - WEST) * SCALE)
        y = round((lat - SOUTH) * SCALE)
        if i and x == px and y == py:
            continue   # drop repeated points
        out += [x - px, y - py] if i else [x, y]
        px, py = x, y
    return out


def rings_of(element):
    if element["type"] == "way":
        return [[(p["lon"], p["lat"]) for p in element.get("geometry", [])]]
    # Relations: an area's outline is often split over several ways — join
    # them end to end into closed rings before drawing.
    pieces = [[(p["lon"], p["lat"]) for p in m["geometry"]]
              for m in element.get("members", [])
              if m.get("type") == "way" and m.get("geometry")]
    return join_rings(pieces)


def join_rings(pieces):
    key = lambda pt: (round(pt[0], 7), round(pt[1], 7))
    rings = []
    pieces = [list(p) for p in pieces if len(p) >= 2]
    while pieces:
        ring = pieces.pop()
        while key(ring[0]) != key(ring[-1]):
            for i, piece in enumerate(pieces):
                if key(piece[0]) == key(ring[-1]):
                    ring += piece[1:]
                elif key(piece[-1]) == key(ring[-1]):
                    ring += piece[-2::-1]
                elif key(piece[-1]) == key(ring[0]):
                    ring = piece[:-1] + ring
                elif key(piece[0]) == key(ring[0]):
                    ring = piece[:0:-1] + ring
                else:
                    continue
                pieces.pop(i)
                break
            else:
                break   # can't close it (data cut off at the map edge)
        if key(ring[0]) == key(ring[-1]) and len(ring) >= 4:
            rings.append(ring)
    return rings


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", help="use a saved Overpass JSON instead of downloading")
    args = parser.parse_args()

    raw = json.load(open(args.input)) if args.input else download()

    features = []
    counts = {name: 0 for name in LAYERS}
    for element in raw["elements"]:
        layer = classify(element.get("tags", {}))
        if not layer:
            continue
        rings = [encode(r) for r in rings_of(element) if len(r) >= 2]
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        features.append([LAYERS.index(layer)] + rings)
        counts[layer] += 1

    out = {
        "attribution": "© OpenStreetMap contributors",
        "bounds": [WEST, SOUTH, EAST, NORTH],
        "scale": SCALE,
        "layers": LAYERS,
        "features": features,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, separators=(",", ":")))
    size_mb = OUT_FILE.stat().st_size / 1e6
    print(f"Wrote {OUT_FILE.relative_to(ROOT)} ({size_mb:.1f} MB, {len(features)} features)")
    print("  " + ", ".join(f"{k}: {v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
