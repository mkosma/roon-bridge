# Roon API perf baseline — Roon 2.67 build 1659

Captured: 2026-05-13
Host: mini (`127.0.0.1:9330`)
Library: 2715 albums / 1281 artists / 29078 tracks / 5448 composers
Script: `npm run perf:baseline` (best-of-3 with one prime)

| Test | Description | Best ms | Count | Notes |
|---|---|---:|---:|---|
| R7 | Library section counts (Albums/Artists/Tracks/Composers) | 110 | 4 | Artists=1281, Albums=2715, Tracks=29078, Composers=5448 |
| R1 | hierarchy=albums, load 100 | 2 | 100 |  |
| R2 | hierarchy=albums, load all (paged 100) | 27 | 2715 | 28 pages |
| R2b | hierarchy=albums, load all (paged 500) | 25 | 2715 | 6 pages |
| R3 | hierarchy=artists, load all (paged 100) | 13 | 1281 | 13 pages |
| R4 | hierarchy=artists -> drill into one artist | 6 | 4 | artist=…And You Will Know Us by the Trail of Dead |
| R5 | Search 'Murmur' | 153 | 6 |  |
| R6 | Search 'Built To Spill' | 157 | 7 |  |

## Notes

First baseline captured to disk. No prior numeric reference to diff against; future updates can compare here.

Browse/listing is cheap (single-digit to low-double-digit ms). Search dominates the cost at ~150ms, likely the bound on user-facing latency for any LLM tool that searches.

R2 vs R2b: 500-per-page is marginally faster than 100-per-page for full-library scans (25 vs 27 ms). Not worth tuning around unless we start doing full scans routinely.
