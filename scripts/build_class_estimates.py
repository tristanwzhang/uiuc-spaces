#!/usr/bin/env python3
"""
Build per-building class activity from UIUC's public Course Explorer feed.

For every scheduled class meeting we know the building, the days it meets and
the start/end time — but not how many students are in it. So we count meetings
in progress each hour, weighting lectures more heavily than discussions, and
use that as a stand-in for how busy a building is.

Usage:
  python3 scripts/build_class_estimates.py                 # full term (~3 min)
  python3 scripts/build_class_estimates.py --subjects CS MATH
  python3 scripts/build_class_estimates.py --term 2026/fall

Output:
  data/class_activity.json    per building: weighted meetings per weekday hour
  data/unmatched_buildings.txt  Course Explorer buildings we could NOT map to a
                                map building — left out rather than guessed
"""

import argparse
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
BASE = "https://courses.illinois.edu/cisapp/explorer/schedule"
NS = {"ns2": "http://rest.cis.illinois.edu"}

DAY_LETTERS = {"M": "monday", "T": "tuesday", "W": "wednesday",
               "R": "thursday", "F": "friday", "S": "saturday", "U": "sunday"}

# A lecture puts far more people in a building than a discussion section.
TYPE_WEIGHTS = {
    "LEC": 3.0, "LCD": 3.0, "ONL": 0.0, "OLC": 0.0, "CNF": 0.5,
    "DIS": 1.0, "LAB": 1.5, "LBD": 1.5, "Q": 0.5, "PKG": 1.0,
    "IND": 0.2, "PR": 0.5, "CLN": 0.5, "OD": 0.0,
}
DEFAULT_WEIGHT = 1.0

# Course Explorer's building names -> the exact OpenStreetMap name used by the
# 3D map. Only pairs that are certain; see data/unmatched_buildings.txt for the
# rest.
BUILDING_ALIASES = {
    "Siebel Center for Comp Sci": "Siebel Center for Computer Science",
    "Electrical & Computer Eng Bldg": "Electrical and Computer Engineering Building",
    "Materials Science & Eng Bld": "Materials Science & Engineering Building",
    "Mechanical Engineering Bldg": "Sidney Lu Mechanical Engineering Building",
    "Mechanical Engineering Lab": "Mechanical Engineering Lab",
    "Loomis Laboratory": "Loomis Laboratory of Physics",
    "Everitt Laboratory": "Everitt Laboratory",
    "Natural History Building": "Natural History Building",
    "Campus Instructional Facility": "Campus Instructional Facility",
    "Business Instructional Fac": "Business Instructional Facility",
    "Digital Computer Laboratory": "Digital Computer Laboratory",
    "David Kinley Hall": "David Kinley Hall",
    "Transportation Building": "Transportation Building",
    "Engineering Hall": "Engineering Hall",
    "Talbot Laboratory": "Talbot Laboratory",
    "Noyes Laboratory": "Noyes Laboratory",
    "Chemistry Annex": "Chemistry Annex",
    "Davenport Hall": "Davenport Hall",
    "Burrill Hall": "Burrill Hall",
    "Lincoln Hall": "Lincoln Hall",
    "Gregory Hall": "Gregory Hall",
    "Altgeld Hall": "Altgeld Hall",
    "Wohlers Hall": "Wohlers Hall",
    "English Building": "English Building",
    "Psychology Building": "Psychology Building",
    "Education Building": "Education Building",
    "Bevier Hall": "Bevier Hall",
    "Armory": "Armory",
    "Foellinger Auditorium": "Foellinger Auditorium",
    "Krannert Center for Perf Arts": "Krannert Center for the Performing Arts",
    "Architecture Building": "Architecture Building",
    "Art and Design Building": "Art and Design Building",
    "Music Building": "Music Building",
    "Turner Hall": "Turner Hall",
    "Mumford Hall": "Mumford Hall",
    "Huff Hall": "Huff Hall",
    "Freer Hall": "Louise Freer Hall",
    "Beckman Institute": "Beckman Institute",
    "Newmark Civil Engineering Bldg": "Newmark Civil Engineering Laboratory",
    "Roger Adams Laboratory": "Roger Adams Laboratory",
    "Everitt Lab": "Everitt Laboratory",
    "Temple Hoyne Buell Hall": "Temple Hoyne Buell Hall",
    "Wymer Hall": "Steven S. Wymer Hall",
    "Flagg Hall": "Flagg Hall",
    "ACES Lib, Info & Alum Ctr": "Funk Library",
    "Vet Med Basic Sciences Bldg": "Veterinary Medicine Basic Sciences Building",
    "Siebel Center for Design": "Siebel Center for Design",
    "Harding Band Building": "Harding Band Building",
    "Christopher Hall": "Doris Kelley Christopher Hall",
    "National Soybean Res Ctr": "National Soybean Research Center",
    "Ice Arena": "Ice Arena",
    # Renamed buildings, confirmed by hand
    "Sch of Info Sciences Bldg": "Graduate School of Library and Information Science",
    "Inst Labor &  Industrial Rel": "School of Labor & Employment Relations",
    "Law Building": "University of Illinois College of Law",
    "Civil & Envir Eng Bldg": "Civil and Environmental Engineering Building",
    "Coordinated Science Lab": "Coordinated Science Laboratory",
    "Literatures, Cultures, & Ling": "Literatures, Cultures & Linguistics Building",
    "Natural Resources Building": "Natural Resources Building",
    "Animal Sciences Laboratory": "Animal Sciences Laboratory",
    "Agricultural Engr Sciences Bld": "Agricultural Engineering Sciences",
    "Astronomy Building": "Astronomy Building",
    "Harker Hall": "Harker Hall",
    "Smith Memorial Hall": "Smith Memorial Hall",
    "Spurlock Museum": "Spurlock Museum",
    "Stock Pavilion": "Stock Pavilion",
    "Speech & Hearing Science Bldg": "Speech and Hearing Science Building",
    "Ceramics Building": "Ceramics Building",
    "Doris Kelley Christopher Hall": "Doris Kelley Christopher Hall",
    "Medical Sciences Building": "Medical Sciences Building",
    "Nuclear Engineering Lab": "Nuclear Engineering Laboratory",
    "Illini Union": "Illini Union",
    "Activities & Recreation Center": "Activities and Recreation Center",
    "Henry Administration Bldg": "Henry Administration Building",
    "Sidney Lu Mech Engr Bldg": "Sidney Lu Mechanical Engineering Building",
    "Main Library": "Main Library",
    "Grainger Engineering Library": "Grainger Engineering Library",
}


def get(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:
                return resp.read()
        except Exception:
            if attempt == tries - 1:
                raise
    return None


def parse_time(text):
    """'10:00AM' -> minutes since midnight, or None."""
    m = re.match(r"\s*(\d{1,2}):(\d{2})\s*([AaPp])", text or "")
    if not m:
        return None
    hour, minute = int(m.group(1)) % 12, int(m.group(2))
    if m.group(3).lower() == "p":
        hour += 12
    return hour * 60 + minute


def list_subjects(term):
    root = ET.fromstring(get(f"{BASE}/{term}.xml"))
    subjects = [s.get("id") for s in root.iter("subject")]
    if not subjects:  # namespaced variant, just in case
        subjects = [s.get("id") for s in root.iter("{http://rest.cis.illinois.edu}subject")]
    return subjects


def subject_meetings(term, subject):
    """Every meeting in a subject: (building, type, days, start, end)."""
    try:
        xml = get(f"{BASE}/{term}/{subject}.xml?mode=cascade")
    except Exception as e:
        print(f"  ! {subject}: {e}", file=sys.stderr)
        return []

    meetings = []
    for meeting in ET.fromstring(xml).iter("meeting"):
        building = (meeting.findtext("buildingName") or "").strip()
        days = (meeting.findtext("daysOfTheWeek") or "").strip()
        start = parse_time(meeting.findtext("start"))
        end = parse_time(meeting.findtext("end"))
        type_el = meeting.find("type")
        code = type_el.get("code") if type_el is not None else ""
        if building and days and start is not None and end is not None and end > start:
            meetings.append((building, code, days, start, end))
    return meetings


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--term", default="2026/fall", help="e.g. 2026/fall")
    parser.add_argument("--subjects", nargs="*", help="limit to these subject codes")
    args = parser.parse_args()

    subjects = args.subjects or list_subjects(args.term)
    print(f"Fetching {len(subjects)} subjects for {args.term} ...")

    all_meetings = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, meetings in enumerate(pool.map(lambda s: subject_meetings(args.term, s), subjects), 1):
            all_meetings.extend(meetings)
            if i % 25 == 0 or i == len(subjects):
                print(f"  {i}/{len(subjects)} subjects, {len(all_meetings)} meetings")

    # hours[osm_building][weekday][hour] = weighted count of meetings in progress
    hours = defaultdict(lambda: defaultdict(lambda: [0.0] * 24))
    unmatched = defaultdict(int)

    for building, code, days, start, end in all_meetings:
        mapped = BUILDING_ALIASES.get(building)
        if not mapped:
            unmatched[building] += 1
            continue
        weight = TYPE_WEIGHTS.get(code, DEFAULT_WEIGHT)
        if weight == 0:
            continue
        for letter in days:
            day = DAY_LETTERS.get(letter)
            if not day:
                continue
            for hour in range(start // 60, min((end - 1) // 60 + 1, 24)):
                hours[mapped][day][hour] += weight

    out = {
        "term": args.term,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Weighted count of class meetings in progress. Not people.",
        "buildings": {
            name: {
                "peak": max(max(day) for day in days.values()),
                "hours": {day: [round(v, 1) for v in values] for day, values in days.items()},
            }
            for name, days in sorted(hours.items())
        },
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "class_activity.json").write_text(json.dumps(out, indent=2))

    lines = [f"{count:5d} meetings  {name}" for name, count in
             sorted(unmatched.items(), key=lambda kv: -kv[1])]
    (DATA_DIR / "unmatched_buildings.txt").write_text(
        "Course Explorer buildings with no confident match to a map building.\n"
        "Add real matches to BUILDING_ALIASES in scripts/build_class_estimates.py.\n\n"
        + "\n".join(lines) + "\n")

    print(f"\n{len(out['buildings'])} buildings matched, {len(unmatched)} unmatched")
    print(f"Wrote data/class_activity.json and data/unmatched_buildings.txt")


if __name__ == "__main__":
    main()
