# STREAK-TENDO

The #1 game on the Nintendo eShop, day by day, for several regions.
Live at https://streaktendo.github.io/

## How it's organized

- `index.html` is the one page design for every region. Change it once and every region updates.
- `data/<region>/history.json` holds each region's days; `data/<region>/art/` holds its box art.
- Regions are listed near the top of the script in `index.html` (`REGIONS`). To add one, add a
  line there and create `data/<id>/history.json` with `"region"` set, plus something that fills it.

## Where the data comes from

- **US** (`data/us`): the Mac reads the Best Sellers lists in the Nintendo Store app running in an
  Android emulator, every day at 9:15 AM Pacific. Code: `mac/streaktendo.py`, installed by `mac/setup.sh`.
- **Australia** (`data/au`): the GitHub Actions job `.github/workflows/record-au.yml` reads the
  Nintendo Australia store's chart pages every day at about 6:17 AM Pacific. Code: `scripts/scrape.mjs`.
