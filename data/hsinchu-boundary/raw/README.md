# Hsinchu boundary raw data — input contract (V2.4.5)

This directory holds the RAW input to `scripts/updateHsinchuBoundaryData.mjs`
(run via `npm run update:hsinchu-boundary-data`), which compiles it into the
compact, bundled dataset under `data/hsinchu-boundary/generated/` that
`src/tdx/hsinchuGeoResolver.js` actually reads at runtime.

## What's here

`counties-10t.json` — the whole-nation county/city TopoJSON from the
`taiwan-atlas` npm package (itself a redistribution of the Ministry of the
Interior's official 直轄市、縣市界線（TWD97經緯度） dataset, data.gov.tw
dataset ID **7442**). Staged verbatim, byte-for-byte — see `SOURCE_META.json`
in this directory for the full provenance record (npm package/version/file,
tarball shasum/integrity, fetch date, staged-file SHA-256, and the CRS
determination this round made).

**Why an npm mirror and not a direct data.gov.tw download**: this Claude
Code sandbox's network egress policy blocks `data.gov.tw` and every other
`*.gov.tw` host (confirmed exhaustively this round, same class of
constraint `data/road-location/raw/README.md`'s own V1.8.6.5 section
already documents for an earlier dataset). `registry.npmjs.org` is
reachable (it's in the egress proxy's own allowlist), and the
`taiwan-atlas` package explicitly redistributes this exact official
dataset unmodified.

## Regeneration

```
npm run update:hsinchu-boundary-data
```

Reads `counties-10t.json`, decodes it (via `topojson-client`, a
devDependency used only by this script — never bundled into the Worker),
extracts ONLY the 新竹市 (COUNTYID `O`, COUNTYCODE `10018`) and 新竹縣
(COUNTYID `J`, COUNTYCODE `10004`) features, validates each geometry is a
single well-formed closed `Polygon` ring, and atomically writes
`data/hsinchu-boundary/generated/hsinchuBoundary.js`.

## Getting a fresher or more precise boundary later

To re-extract with an updated official file: replace `counties-10t.json`
with a newer `taiwan-atlas` release's own `counties-10t.json` (or any other
verbatim, traceable copy of data.gov.tw dataset 7442), update
`SOURCE_META.json`'s provenance fields to match, and re-run the script
above. Never hand-edit `counties-10t.json` or the generated output —
regenerate from a real source file instead.

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
