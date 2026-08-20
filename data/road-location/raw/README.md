# Road location raw data — input contract (V1.8.6.5)

This directory holds the RAW input to `scripts/updateRoadLocationData.mjs`
(run via `npm run update:road-location-data`), which compiles it into the
compact, bundled datasets under `data/road-location/generated/` that
`src/traffic/kmLocationResolver.js` actually reads at runtime.

**This repo's Claude Code session has no outbound network access to
government data hosts (confirmed exhaustively — see PROJECT_HANDOFF.md's
V1.8.6.5 section).** Real official data for `raw/provincial/` and
`raw/freeway/` was brought into the repo by the project owner (provincial:
the official data.gov.tw dataset 7040 file, committed verbatim; freeway:
an archive of the official raw source materials — see
`data/road-location/archive/README_RAW_CONTRACT.md` for exactly what was
collected and from where). Freeway's official archive materials came in
multiple raw shapes (KML, HTML tables, CSV) that don't share one column
layout, so `scripts/prepareFreewayRawFromArchive.mjs` normalizes them
into the one CSV contract documented in §2/§3 below before the main
importer ever runs — see that script's own header comment.

Nothing under `raw/` is bundled into the Worker — only the importer reads
it, at build/prep time, on a developer machine.

## 1. Provincial roads (省道) — `raw/provincial/*.csv`

**Real schema, confirmed from the actual official file.** The official
data.gov.tw dataset 7040 file (`省道里程坐標(里程牌標誌)`) was staged
verbatim as `raw/provincial/provincial.csv` — see that directory's own
`SOURCE_META.json` for full provenance/SHA-256/notes. The importer reads
the government's own column names directly:

| Column         | Required | Meaning                                                              |
|----------------|----------|-----------------------------------------------------------------------|
| `route_raw`    | yes      | Route number as published (e.g. `台3`, `台13甲`, `台16臨29`)          |
| `km_m`         | yes      | Chainage in whole metres from the route origin (as-installed, not idealised — a "NK+000" sign is often a few metres off the round value; resolved by kmLocationResolver.js's own tolerance, not exact equality) |
| `lon_wgs84`    | yes      | Longitude, decimal degrees (WGS84)                                    |
| `lat_wgs84`    | yes      | Latitude, decimal degrees (WGS84)                                     |
| `county`       | yes      | County/city name (e.g. `新竹縣`)                                      |
| `township`     | yes      | Township name (e.g. `關西鎮`)                                         |
| `village`      | no       | Village name (e.g. `南山里`)                                          |
| `install_position` | no  | `中央`/`左側`/`右側` — used only to prefer a single `中央` sign over a left/right pair when deduplicating; never shown to a driver |

A row missing `county` or `township` is a schema error (the real dataset
has no free-text "設置位置" field to fall back to — the resolver's label
is always composed from `county`+`township`+`village`). Left/right sign
pairs ~1m apart at the same physical marker are deduplicated by the
importer (10m bucketing — see `PROVINCIAL_DEDUPE_BUCKET_METERS` in the
importer's own comment); this never merges two genuinely distinct
markers, since real markers are ≥100m apart.

## 2. Freeway 100m milestones (國道百公尺樁) — `raw/freeway/milestones/*.csv`

Produced by `scripts/prepareFreewayRawFromArchive.mjs` from the official
dataset 95016 KML files (plus its two supplementary extension CSVs) —
see that script and `data/road-location/archive/README_RAW_CONTRACT.md`.
Column contract (unchanged from this project's own original design):

| Column         | Required | Meaning                                          |
|----------------|----------|---------------------------------------------------|
| 路線名稱       | yes      | Route name, as the source publishes it (e.g. `國1`, `國3甲`, `國道1號`) — normalized by the importer |
| 百公尺樁號KM   | yes      | Kilometer marker as a plain number                |
| WGS84_E        | yes      | Longitude, decimal degrees                        |
| WGS84_N        | yes      | Latitude, decimal degrees                         |

Two routes present in the official milestone archive are deliberately
NOT included here: `台26` (published under a `台2己`-named KML file, but
its own embedded RoadName is `台26` — a provincial-road identity, out of
this file's freeway scope; it's already covered via `raw/provincial/` if
dataset 7040 includes it) and `南港聯絡道` (a named connector with no
numeral form `roadIdentity.js` can canonicalize this round). Both
exclusions are logged by `prepareFreewayRawFromArchive.mjs` when it runs,
not silently dropped.

## 3. Freeway facilities (交流道／服務區里程) — `raw/freeway/facilities/*.csv`

Produced by `scripts/prepareFreewayRawFromArchive.mjs` from official
dataset 166496 (interchanges, per-route CSV) and dataset 8161 (service
areas). `freeway.gov.tw`'s own cnid=1906 HTML mileage tables (also
archived) are NOT parsed this round — 166496+8161 alone already cover
every priority route; see that script's own header comment for the exact
gap this leaves.

| Column     | Required | Meaning                                                    |
|------------|----------|-------------------------------------------------------------|
| 路線名稱   | yes      | Route name, same forms as above                             |
| 里程KM     | yes      | Kilometer marker as a plain number                           |
| 名稱       | yes      | Facility name a driver recognizes (e.g. `竹北`, `湖口服務區`) |
| 類型       | no       | `交流道` / `服務區` / free text — display-only, not matched on |

## 4. Optional per-directory source metadata — `SOURCE_META.json`

Each of `raw/provincial/`, `raw/freeway/milestones/`, and
`raw/freeway/facilities/` carries its own `SOURCE_META.json` recording
where the data came from and when the official dataset itself was last
updated:

```json
{
  "sourceName": "省道里程坐標",
  "sourceUrl": "https://data.gov.tw/dataset/7040",
  "sourceAgency": "交通部公路局",
  "datasetUpdatedAt": "2026-08-01"
}
```

All fields optional; the importer fills in `null` for whichever are
missing. `fetchedAt` is NOT part of this file — the importer stamps that
itself, as the actual time it ran.

## 5. What happens if a directory is empty

No raw files for a given road type is NOT an error — the importer
produces a genuine, real importer-generated output with `recordCount: 0`
for that dataset (never hand-written, never silently fabricated — the
generated file's own `metadata` makes the emptiness explicit). The KM
Location Resolver treats an empty dataset as "cannot resolve this road,"
never as a reason to guess.

## 6. What happens on a schema problem

A raw file that EXISTS but is missing a required column, or has a row
whose required value doesn't parse, is a hard error: the importer prints
exactly which file/column/row failed and exits non-zero, WITHOUT
touching any previously-generated file. It never silently drops the bad
row and produces a partial dataset that could be mistaken for a
complete, verified one.
