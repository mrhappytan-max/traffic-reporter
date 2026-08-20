# Road location raw data — input contract (V1.8.6.5)

This directory holds the RAW input to `scripts/updateRoadLocationData.mjs`
(run via `npm run update:road-location-data`), which compiles it into the
compact, bundled datasets under `data/road-location/generated/` that
`src/traffic/kmLocationResolver.js` actually reads at runtime.

**This repo's Claude Code session has no outbound network access to
government data hosts (confirmed exhaustively — see PROJECT_HANDOFF.md's
V1.8.6.5 section) and therefore cannot download or inspect the real
official files itself.** The contract below is *this project's own*
normalized intermediate format — it is NOT necessarily the exact column
layout the official files ship with. Whoever prepares the raw files here
(the project owner, or another tool/session with real access to
data.gov.tw / freeway.gov.tw) is responsible for mapping the official
file's actual columns into this contract before running the importer.

Nothing under `raw/` is bundled into the Worker — only the importer reads
it, at build/prep time, on a developer machine. Whether raw files
themselves get committed to the repo (vs. kept locally and only their
`generated/` output committed) is a size/license decision for whoever
prepares them; this contract doesn't require either choice.

## 1. Provincial roads (省道) — `raw/provincial/*.csv`

One or more CSV files (any filename), UTF-8, comma-separated, one header
row. Column names are Chinese to mirror the official dataset's own
terminology (data.gov.tw dataset 7040 "省道里程坐標" and similar):

| Column       | Required | Meaning                                                    |
|--------------|----------|-------------------------------------------------------------|
| 公路編號     | yes      | Route number as the source spells it (e.g. `台3`, `台13甲`, `台3線`) — normalized by the importer, any of these forms is fine |
| 縣市         | no       | County/city name (e.g. `新竹縣`)                             |
| 鄉鎮         | no       | Township name (e.g. `關西鎮`)                                |
| 村里         | no       | Village name (e.g. `南山里`)                                 |
| 樁號KM       | yes      | Kilometer marker as a plain number (e.g. `9.0`, `82.3`)      |
| WGS84_E      | no       | Longitude, decimal degrees                                   |
| WGS84_N      | no       | Latitude, decimal degrees                                    |
| 設置位置     | no       | Free-text official location description, used as-is for the label when present (preferred over composing 縣市/鄉鎮/村里) |

At least one of {縣市+鄉鎮} or 設置位置 must be present per row, or the
row carries no usable label — the importer treats a row with NEITHER as
a schema error (fail loud), not a silently-skipped row.

## 2. Freeway 100m milestones (國道百公尺樁) — `raw/freeway/milestones/*.csv`

| Column         | Required | Meaning                                          |
|----------------|----------|---------------------------------------------------|
| 路線名稱       | yes      | Route name (e.g. `國道一號`, `國道1號`, `中山高`) |
| 百公尺樁號KM   | yes      | Kilometer marker as a plain number                |
| WGS84_E        | yes      | Longitude, decimal degrees                        |
| WGS84_N        | yes      | Latitude, decimal degrees                         |

## 3. Freeway facilities (交流道／服務區里程) — `raw/freeway/facilities/*.csv`

| Column     | Required | Meaning                                                    |
|------------|----------|-------------------------------------------------------------|
| 路線名稱   | yes      | Route name, same forms as above                             |
| 里程KM     | yes      | Kilometer marker as a plain number                           |
| 名稱       | yes      | Facility name a driver recognizes (e.g. `竹北`, `湖口服務區`) |
| 類型       | no       | `交流道` / `服務區` / free text — display-only, not matched on |

## 4. Optional per-directory source metadata — `SOURCE_META.json`

Drop a `SOURCE_META.json` next to the CSV files in `raw/provincial/`,
`raw/freeway/milestones/`, or `raw/freeway/facilities/` to record where
the data came from and when the official dataset itself was last updated:

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
whose required value doesn't parse (e.g. 樁號KM isn't a number), is a
hard error: the importer prints exactly which file/column/row failed and
exits non-zero, WITHOUT touching any previously-generated file. It never
silently drops the bad row and produces a partial dataset that could be
mistaken for a complete, verified one.
