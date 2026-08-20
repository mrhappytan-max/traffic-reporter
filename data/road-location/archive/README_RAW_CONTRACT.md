# Traffic Reporter V1.8.6.5 — KM Location Resolver / raw layer

Generated 2026-08-20 (UTC). Official sources only. No TDX, no PBS. Production untouched, nothing deployed.

## Artifacts

| file | rows | source |
|---|---|---|
| `provincial.csv` | 30,079 | data.gov.tw 7040 — 公路局「省道里程坐標(里程牌標誌)」 |
| `freeway_milestones.csv` | 10,082 | data.gov.tw 95016 — 高公局「國道百公尺里程樁」 |
| `freeway_facilities.csv` | 236 | data.gov.tw 166496 + 8161 + freeway.gov.tw `cnid=1906` |

Each has a matching `*_SOURCE_META.json` (dataset id, publisher, portal URL, upstream
`modifiedDate`, update frequency, licence, column list, CRS, and a SHA-256 for every
original file retained under `raw/`).

## Key conventions

- `km_m` — integer metres from route origin. `km_label` — `NNNK+MMM`.
- Coordinates are WGS84 (`EPSG:4326`); provincial rows also carry TWD97 TM2 (`EPSG:3826`).
- `route_id` is normalised: `國1`, `國3甲`, `台13甲` … (`臺`→`台`, `國道N號`→`國N`, trailing `號` dropped).
- **Direction**: dataset 95016 publishes one centreline per route (`LR = M`). There is no
  per-carriageway geometry, so a `南向` request and a `北向` request at the same chainage
  resolve to the *same* point. Directional information lives in
  `freeway_facilities.csv` (`exit_guide_dir1/2`, `direction_note`), where the direction pair is
  南/北 on north-south routes and 東/西 on east-west routes — the axis is carried in the
  `*_label` columns rather than hard-coded.
- Interchange mileage from 166496 is published rounded to whole kilometres
  (`km_precision = km_rounded`). Service areas come from 8161 with exact mileage
  (`km_precision = exact`), one row per carriageway side.
- 95016 also covers 台26 (台2己 file) and 南港聯絡道; they are kept with their own `route_id`
  and `route_system` values rather than being dropped.

## QA (freeway_milestones.csv)

- 10,082 posts, 0 outside the Taiwan bounding box.
- Median distance between consecutive 100 m posts = 100.0–100.3 m on every route;
  largest observed step 100.4 m. No coordinate jumps.
- Route extents match published lengths (國1 374.4 km,國3 431.5 km, 國5 53.7 km …).

## provincial.csv (dataset 7040)

Source file was downloaded by the operator from the official data.gov.tw / 公路局 distribution
in a normal browser — this container's egress IP is refused by the site WAF — and staged
verbatim as `raw/thb_7040_milepost.csv`
(SHA-256 `db53339afa9463f8faa4f85dd73fb5623fbebeffe9369d44a9e89c0d67189373`, 5,246,831 bytes,
cp950). The uploaded original was not modified.

- 30,079 records, 101 routes; all 23 columns declared by dataset 7040 present and in published order.
- 0 missing chainage, 0 missing coordinates, 0 coordinates outside the Taiwan bounding box,
  0 duplicate/non-monotonic chainages.
- `route_system` = `provincial` (29,432) or `provincial_temporary` (647 — the 台N臨M detour routes).
- **Chainage is as-installed, not idealised.** A whole-kilometre sign is usually recorded a few
  metres off the round value. Resolve a `NK+000` request by `sign_face` (牌面內容), not by exact
  `km_m` equality. Left/right pairs appear as two rows ~1 m apart
  (`install_position` 左側/右側, `face_direction` 順向/逆向); 中央 signs are 雙向.
- Spacing histogram: ~100 m (百公尺牌), ~500 m (半公里牌), ~1,000 m (整公里牌), plus the 1 m pairs.
- Coordinate cross-check (reproject `坐標-X/Y-TWD97` and compare to the WGS84 columns):
  median 1.79 m, p99 2.01 m — a constant publisher-side conversion offset, not an error.
  32 rows carry their TWD97 pair in TM2 **zone 119** (EPSG:3825) rather than zone 121;
  6 further rows disagree by 90–320 m with no clean explanation. The WGS84 columns are correct
  in every case, and nothing was corrected in the raw layer — see
  `VERIFY.json → provincial_coordinate_consistency`.
