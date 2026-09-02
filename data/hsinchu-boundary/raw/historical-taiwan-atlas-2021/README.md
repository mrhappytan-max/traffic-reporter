# Historical — no longer Production authority (V2.4.5 hotfix)

This `counties-10t.json` (taiwan-atlas npm 2021.9.20) + its own `SOURCE_META.json`
were the Production positive-authority boundary source for TDX's Hsinchu
geographic resolver from the original V2.4.5 round until the
`V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE` hotfix, which
replaced them with a directly human-sourced official NLSC shapefile — see
`../SOURCE_META.json` and `../nlsc-shp-2020/` for the current source, and
that hotfix's own completion report in `07_KNOWN_ISSUES.md` for the full
geometry-diff evidence showing no material boundary difference between
the two.

Kept here verbatim, unmodified, purely as a historical comparison / test
fixture per that hotfix order's own section 七 ("可以：移除 或 保留成 test
fixture / historical comparison"). `scripts/updateHsinchuBoundaryData.mjs`
no longer reads this directory at all.
