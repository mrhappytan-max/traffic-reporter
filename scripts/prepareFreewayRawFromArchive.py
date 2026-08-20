#!/usr/bin/env python3
"""V1.8.6.5 — one-time(-ish) preparation step: turns the messy official
freeway archive materials (KML, cp950-encoded CSV, UTF-8 CSV — three
different shapes from three different datasets) into the two clean CSV
files scripts/updateRoadLocationData.mjs's importer actually reads:
    data/road-location/raw/freeway/milestones/milestones.csv
    data/road-location/raw/freeway/facilities/facilities.csv

Written in Python, not Node (unlike the rest of this project's tooling),
specifically because of two things Python's stdlib handles cleanly and
Node's does not out of the box: (1) the official milestone KML zip's
entries have Big5/CP950-encoded filenames stored under the legacy CP437
codepage flag, which needs an explicit re-decode; (2) the dataset 166496
interchange CSVs are themselves CP950-encoded (not UTF-8). This script
does NOT touch any raw official file's content — it only reads
data/road-location/archive/raw_official_sources.zip (committed verbatim
by the operator — see archive/README_RAW_CONTRACT.md) and writes the two
normalized CSVs above. Re-run it any time the archive is refreshed.

What this script deliberately does NOT include, and why (both are
findable in the archive for a future round, not fabricated around):
  - `台26` and `南港聯絡道` milestones: dataset 95016 ships their 100m
    posts in the same KML collection, but `台26` is a PROVINCIAL road
    identity (already covered by raw/provincial/ if dataset 7040 includes
    it) and `南港聯絡道` has no numeral form roadIdentity.js's
    canonicalizers can derive this round. Both are logged below, not
    silently dropped.
  - freeway.gov.tw's own cnid=1906 "交流道、服務區里程一覽表" HTML pages
    (also archived, 8 pages) are NOT parsed — dataset 166496 (interchanges)
    + dataset 8161 (service areas) alone already give every priority
    route real IC/SA coverage; the HTML tables would only add a small
    number of additional facilities (the archive's own README estimates
    the gap at roughly 230 vs 236 facilities).
"""
import csv
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_ZIP = ROOT / "data" / "road-location" / "archive" / "raw_official_sources.zip"
MILESTONES_DIR = ROOT / "data" / "road-location" / "raw" / "freeway" / "milestones"
FACILITIES_DIR = ROOT / "data" / "road-location" / "raw" / "freeway" / "facilities"

# Matches the embedded HTML table dataset 95016 publishes inside both its
# KML <description> and its two supplementary CSVs' third column — same
# 7-column shape (RoadName, LR, X, Y, Z, KM, KM2) in every source file.
TABLE_ROW_RE = re.compile(
    r"<TD>([^<]*)</TD><TD>([^<]*)</TD><TD>([^<]*)</TD><TD>([^<]*)</TD><TD>([^<]*)</TD><TD>([^<]*)</TD><TD>([^<]*)</TD></TABLE>"
)

NON_FREEWAY_ROAD_NAMES = {"台26", "南港聯絡道"}


def outer_zip_name(zip_info):
    # The OUTER archive's filenames are real UTF-8 bytes, but were zipped
    # without the UTF-8 flag set, so `zipfile` decodes them via the
    # default legacy CP437 codepage — wrong for Chinese filenames.
    # Re-decode: CP437 bytes -> real bytes -> UTF-8 text.
    return zip_info.filename.encode("cp437").decode("utf-8")


def inner_kml_name(zip_info):
    # The NESTED milestone KML zip is a DIFFERENT archive (built by a
    # different, older tool) whose filenames are CP950-encoded, not
    # UTF-8 — same CP437-flag problem, different real encoding.
    return zip_info.filename.encode("cp437").decode("cp950")


def parse_milestone_kml(xml_text):
    rows = []
    for m in TABLE_ROW_RE.finditer(xml_text):
        road_name, lr, x, y, z, km_m, km_label = m.groups()
        rows.append({"road": road_name, "lon": x, "lat": y, "km_m": km_m})
    return rows


def load_milestones(outer_zip):
    milestones = []
    skipped_counts = {}

    kml_zip_info = next(i for i in outer_zip.infolist() if outer_zip_name(i) == "raw/nfb_95016_milestone_kml.zip")
    kml_zip_bytes = outer_zip.read(kml_zip_info)
    import io

    with zipfile.ZipFile(io.BytesIO(kml_zip_bytes)) as kml_zip:
        for info in kml_zip.infolist():
            decoded_name = inner_kml_name(info)
            if not decoded_name.lower().endswith(".kml"):
                continue
            text = kml_zip.read(info).decode("utf-8", errors="replace")
            for row in parse_milestone_kml(text):
                if row["road"] in NON_FREEWAY_ROAD_NAMES:
                    skipped_counts[row["road"]] = skipped_counts.get(row["road"], 0) + 1
                    continue
                milestones.append(row)

    # Two supplementary extension files, same embedded-table shape,
    # plain UTF-8 CSV (緯度,經度,百公尺里程樁位置).
    for extra in ("raw/nfb_95016_n2a.csv", "raw/nfb_95016_n4_fengtan.csv"):
        text = outer_zip.read(extra).decode("utf-8")
        for row in parse_milestone_kml(text):
            if row["road"] in NON_FREEWAY_ROAD_NAMES:
                skipped_counts[row["road"]] = skipped_counts.get(row["road"], 0) + 1
                continue
            milestones.append(row)

    return milestones, skipped_counts


IC_FILENAME_RE = re.compile(r"^nfb_166496_(.+?)(?:_平面|_高架)?\.csv$")


def load_ic_facilities(outer_zip):
    facilities = []
    for info in outer_zip.infolist():
        decoded_name = outer_zip_name(info)
        m = re.match(r"^raw/nfb_facilities/(nfb_166496_.+\.csv)$", decoded_name)
        if not m:
            continue
        basename = m.group(1)
        road_match = IC_FILENAME_RE.match(basename)
        road = road_match.group(1) if road_match else None
        if not road:
            continue
        text = outer_zip.read(info).decode("cp950")
        reader = csv.DictReader(text.splitlines())
        for row in reader:
            km_raw = row.get("里程K+000") or ""
            name_field = row.get("設施名稱")
            if not (km_raw and name_field):
                continue
            # The 國1 "高架" (elevated) file's own km column carries a
            # literal "高架" text prefix (e.g. "高架13") to distinguish it
            # from the at-grade alignment's km at the same nominal marker
            # — genuine official formatting, not a parse error. Strip it
            # for the numeric km value, and preserve the distinction in
            # `type` (display-only, never matched on for resolution).
            is_elevated = km_raw.startswith("高架")
            km_match = re.match(r"^\D*(\d+(?:\.\d+)?)", km_raw)
            if not km_match:
                continue
            facility_type = "交流道(高架)" if is_elevated else "交流道"
            facilities.append({"road": road, "km": km_match.group(1), "name": name_field, "type": facility_type})
    return facilities


SA_LOCATION_KM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[Kk](?:\+(\d+))?")


def load_sa_facilities(outer_zip):
    facilities = []
    sa_info = next(i for i in outer_zip.infolist() if outer_zip_name(i) == "raw/nfb_8161_國道服務區簡介一覽表.csv")
    text = outer_zip.read(sa_info).decode("utf-8-sig")
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        road = row.get("國道")
        name = row.get("服務區名稱")
        location = row.get("位置") or ""
        km_match = SA_LOCATION_KM_RE.search(location)
        if not (road and name and km_match):
            continue
        km = float(km_match.group(1))
        if km_match.group(2):
            km += int(km_match.group(2)) / 1000
        facilities.append({"road": road, "km": km, "name": f"{name}服務區", "type": "服務區"})
    return facilities


def write_csv(path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        # lineterminator="\n": csv.writer defaults to "\r\n", which `git
        # diff --check` flags as trailing whitespace on every line and
        # mixes line-ending conventions with the rest of this repo.
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)


def write_source_meta(path, source_name, source_url, dataset_updated_at, notes):
    payload = {
        "sourceName": source_name,
        "sourceUrl": source_url,
        "sourceAgency": "交通部高速公路局",
        "datasetUpdatedAt": dataset_updated_at,
        "notes": notes,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    with zipfile.ZipFile(ARCHIVE_ZIP) as outer_zip:
        milestones, skipped = load_milestones(outer_zip)
        ic_facilities = load_ic_facilities(outer_zip)
        sa_facilities = load_sa_facilities(outer_zip)

    write_csv(
        MILESTONES_DIR / "milestones.csv",
        ["路線名稱", "百公尺樁號KM", "WGS84_E", "WGS84_N"],
        # The source table's own "KM" field (parse_milestone_kml's km_m) is
        # WHOLE METRES from the route origin (e.g. "9900" for 9.9km), not
        # kilometres — convert here so this file's own declared column
        # ("百公尺樁號KM", per raw/README.md §2) actually holds KM, matching
        # what the importer (buildFreewayMilestones) expects.
        [[m["road"], float(m["km_m"]) / 1000, m["lon"], m["lat"]] for m in milestones],
    )
    write_source_meta(
        MILESTONES_DIR / "SOURCE_META.json",
        "國道百公尺里程樁",
        "https://data.gov.tw/dataset/95016",
        "2024-08-01",
        [
            "Normalized from data/road-location/archive/raw_official_sources.zip by "
            "scripts/prepareFreewayRawFromArchive.py — see that script's own header comment.",
            f"Excluded (out of freeway road-identity scope this round): {skipped}",
        ],
    )

    facilities = ic_facilities + sa_facilities
    write_csv(
        FACILITIES_DIR / "facilities.csv",
        ["路線名稱", "里程KM", "名稱", "類型"],
        [[f["road"], f["km"], f["name"], f["type"]] for f in facilities],
    )
    write_source_meta(
        FACILITIES_DIR / "SOURCE_META.json",
        "國道交流道與服務區里程",
        "https://data.gov.tw/dataset/166496 ; https://data.gov.tw/dataset/8161",
        "2026-08-20",
        [
            "Normalized from data/road-location/archive/raw_official_sources.zip by "
            "scripts/prepareFreewayRawFromArchive.py — see that script's own header comment.",
            f"{len(ic_facilities)} interchanges (dataset 166496) + {len(sa_facilities)} service areas (dataset 8161).",
            "freeway.gov.tw cnid=1906 HTML mileage tables (also archived) were NOT parsed this round.",
        ],
    )

    print(
        f"prepareFreewayRawFromArchive: milestones={len(milestones)} "
        f"(skipped {skipped}), facilities={len(facilities)} "
        f"(ic={len(ic_facilities)}, sa={len(sa_facilities)})"
    )


if __name__ == "__main__":
    main()
