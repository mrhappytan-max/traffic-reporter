# Hsinchu boundary raw data — input contract

V2.4.5, updated by the `V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE` round.

This directory holds the RAW input to `scripts/updateHsinchuBoundaryData.mjs`
(run via `npm run update:hsinchu-boundary-data`), which compiles it into the
compact, bundled dataset under `data/hsinchu-boundary/generated/` that
`src/tdx/hsinchuGeoResolver.js` actually reads at runtime.

## What's here

`nlsc-shp-2020/` — the official whole-nation county/city shapefile
(`COUNTY_MOI_1090820.shp`/`.shx`/`.dbf`/`.prj`/`.CPG`) plus its accompanying
official ISO 19115/19139 metadata XML (`TW-01-301000100G-000017.xml`),
downloaded directly from data.gov.tw dataset **7442** ("直轄市、縣市界線
(EPSG:3824)", 內政部國土測繪中心) by a human and uploaded into this
session — see `SOURCE_META.json` in this directory for the full
provenance record, including an explicit, honest note on the file's own
2020-08-20 ISO-metadata date and why it was still adopted (a systematic
geometry diff against the outgoing source found no material difference —
see that file's own `geometryDiffCheck` block).

**Why a human-uploaded file and not a direct data.gov.tw download**: this
Claude Code sandbox's network egress policy blocks `data.gov.tw` and every
other `*.gov.tw` host (confirmed exhaustively across two separate rounds —
see `07_KNOWN_ISSUES.md`'s V2.4.5 entries for both the original round and
this hotfix). A human downloaded the file directly from the official
source and supplied it for this round.

`historical-taiwan-atlas-2021/` — the ORIGINAL V2.4.5 round's source
(taiwan-atlas npm 2021.9.20, itself a redistribution of the same dataset
7442), kept as a historical comparison / test fixture, no longer read by
the generator script or Production.

## Regeneration

```
npm run update:hsinchu-boundary-data
```

Reads `nlsc-shp-2020/COUNTY_MOI_1090820.shp` (+`.dbf`), decodes it (via the
`shapefile` npm package, a devDependency used only by this script — never
bundled into the Worker), extracts ONLY the 新竹市 (COUNTYID `O`,
COUNTYCODE `10018`) and 新竹縣 (COUNTYID `J`, COUNTYCODE `10004`) features,
validates each geometry is a single well-formed closed `Polygon` ring, and
atomically writes `data/hsinchu-boundary/generated/hsinchuBoundary.js`.

## Getting a fresher official file later

Replace the contents of `nlsc-shp-2020/` with a newer official download of
dataset 7442 (all 5 shapefile sidecar files + the ISO metadata XML,
verbatim), update `SOURCE_META.json`'s provenance fields to match, and
re-run the script above. Never hand-edit the shapefile or the generated
output — regenerate from a real source file instead. Before replacing,
run the same geometry-diff-check methodology `SOURCE_META.json`'s own
`geometryDiffCheck` block documents against the outgoing file, so any
future round can honestly report `BOUNDARY_CHANGED=YES/NO`.

## Design rules this script must never violate

Same discipline as `scripts/updateRoadLocationData.mjs`:
- Never silently accept a missing/malformed Hsinchu feature and still write
  a generated file — a schema problem is a hard failure (non-zero exit, no
  file written).
- The generated file is only written after both features (新竹市, 新竹縣)
  build successfully in memory; the write is atomic (temp path, then
  rename).
- Coordinates are copied through exactly as decoded — no simplification,
  no rounding, no manual editing.
