# Princeton Weather, Live

This repository holds the code behind my Princeton weather page, live at [altilead.com/princeton-weather](https://altilead.com/princeton-weather). The readings come from an Ecowitt Wittboy Pro (WS90 sensor array, HP2560 console) in my backyard. The console pushes each reading to a Cloudflare Worker every minute. The Worker also reads the Ecowitt API for history and as a backup. Every hour it saves the 5-minute readings to a Cloudflare D1 database and updates a daily summary. Station records and the 7- and 30-day charts are computed from that saved history.

## What's in it

- `public/index.html`: the page. Plain HTML, CSS and JavaScript, no build step.
- `worker.js`: the Cloudflare Worker.
  - `/api/weather` proxies the Ecowitt v3 API, trimmed to outdoor readings in metric. It never sends your keys, MAC address or coordinates to the browser.
  - `/api/history` serves hourly and daily history, station records and same-date comparisons from D1.
  - `/api/ingest/<token>` receives the readings the console pushes itself every minute (see below). While those arrive, `/api/weather` shows them instead of the slower Ecowitt cloud reading.
  - `scheduled()` runs every hour and copies the station's 5-minute history into D1.
- `zambretti.js`: the Zambretti forecaster (Negretti & Zambra, 1915) in beteljuice's electronic form, plus my own removal of the daily pressure cycle before the 3-hour trend is judged (see below).
- `migrations/`: the D1 schema (`readings`, `days`, `meta`, `minutes`).
- `wrangler.example.jsonc`: the Worker configuration, with placeholders.

The radar layer is the NEXRAD base reflectivity mosaic from the [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/). Map tiles are © OpenStreetMap contributors.

## The forecast: Zambretti method

The "Next 12 hours, by Zambretti" card runs the Zambretti forecaster (Negretti & Zambra, 1915) in beteljuice's electronic form. Four inputs pick one of 26 forecasts, from "Settled fine" to "Stormy, much rain":

- sea-level pressure, from the console barometer plus the console's own offset
- the 3-hour trend, with 1.6 hPa as the threshold for rising or falling
- the WS90's 10-minute average wind direction on 16 points, ignored when calm
- the season, with April to September counted as summer

In worker.js, `barometer()` replays the trend every 30 minutes over the last day. At or below 0 °C, a rainy or stormy outlook shows as snow. To reuse it, import `zambretti`, `tideFree` and `trendOf`.

### My addition: the daily pressure cycle

This is my code (`tide`, `tideFree` in zambretti.js). Neither Zambretti nor beteljuice's version does it.

Hourly Trenton-Mercer (KTTN) reports, Iowa Environmental Mesonet, Oct 2021 to Oct 2026, show pressure swinging daily whatever the weather: a 24-hour wave of 0.61 hPa and a 12-hour wave of 0.56 hPa. On an average day it falls about 2.1 hPa from 10 AM to 4 PM. The 12-hour wave matches the mid-latitude atmospheric tide (Dai & Wang 1999, J. Atmos. Sci.), and the 24-hour wave is mostly daytime heating.

Fitted on Oct 2021 to Mar 2024, scored on later years against rain within 12 hours, cycle removed vs raw:

- Fast-fall warning (3 hPa in 3 hours), Apr 2024 to Oct 2026: 116 days vs 184, rain after 63% vs 49%. A clear gain.
- Forecast, on the Trenton test years: hours right 76.0% vs 75.0%, dry rain calls 59% vs 61%, but rain caught 30% vs 33%. Fewer false alarms, and a little less rain caught.

The cycle is set for New Jersey (America/New_York). Elsewhere, measure your own: subtract a centered 24-hour mean, average by hour, fit both waves.

## Run your own

You need a Cloudflare account, Node.js, and an Ecowitt station with an application key and an API key from ecowitt.net.

```sh
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create weather            # paste the database_id into wrangler.jsonc
npx wrangler d1 migrations apply weather --remote
npx wrangler secret put ECOWITT_APP       # Ecowitt application key
npx wrangler secret put ECOWITT_API       # Ecowitt API key
npx wrangler secret put ECOWITT_MAC       # your station's MAC address
npx wrangler deploy
```

For local development, put the same three values in a `.dev.vars` file (git-ignored) and run `npx wrangler dev`.

### Optional: let the console push its readings

Ecowitt consoles and gateways can send every reading straight to your own server ("Customized" upload, Ecowitt protocol). The page then updates every minute without calling the Ecowitt cloud, and keeps updating if that cloud is down.

```sh
npx wrangler secret put INGEST_TOKEN      # a long random string, e.g. from: openssl rand -hex 16
npx wrangler secret put INGEST_PASSKEY    # the PASSKEY your console sends: MD5 of its MAC address, uppercase
```

Then, in the Ecowitt app (Weather Services, Customized) or on the console:
- Protocol: Ecowitt
- Server: your domain
- Path: `/api/ingest/<your INGEST_TOKEN>`
- Port: 80
- Interval: 60 seconds

The console can only send plain HTTP, so keep the token long and private. The Worker also checks the PASSKEY and drops values outside physical ranges.

Before deploying for your own station, change these:
- `ARCHIVE_START` in `worker.js`, the first moment worth saving.
- `CALIBRATED_AT`, `CALIBRATING_FROM`, `CALIBRATING_TO` and `REL_OFFSET` in `worker.js`: they correct my station's pressure history from before its altitude was set. Set `REL_OFFSET` to 0 for yours.
- `CORS_ORIGINS` in `worker.js`, the other sites allowed to read the API.
- The time zone (`America/New_York`) in `worker.js` and `public/index.html`, plus the page text and the radar map center in `public/index.html`.

## Who built it

I built this with my own team of AI agents on Claude Code over two days in October 2026. Through my consulting practice, Altilead, I build the same kind of live dashboard and data pipeline on a company's own data: campaign results, CRM records, buying signals. If you want one on yours, get in touch through the [Altilead contact section](https://altilead.com/#contact).

## License

MIT, see [LICENSE](LICENSE).
