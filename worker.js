// Worker behind the Princeton weather page (altilead.com/princeton-weather).
// The page is a static asset in public/; this script answers /api/weather,
// /api/history and /api/ingest (run_worker_first in wrangler.jsonc) and hands
// every other request back to the assets.
//
// /api/weather proxies the Ecowitt v3 API for the Princeton station. The keys
// and the station MAC are Worker secrets (ECOWITT_APP, ECOWITT_API,
// ECOWITT_MAC) and never reach the browser. The response is trimmed to
// outdoor readings in metric: no MAC, no coordinates, no indoor data.
//
// The forecast copies the Ecowitt console: it comes from the station's own
// barometer only (see barometer() below).
//
// An hourly cron (scheduled()) also saves the station's 5-minute history to
// D1, see archive().
//
// The HP2560 console also pushes every reading itself (its Customized server
// setting, Ecowitt protocol, every 60 seconds) to /api/ingest/<INGEST_TOKEN>,
// see ingest(). The newest push, when fresh, replaces the live part of the
// Ecowitt reading on /api/weather, and Ecowitt is then asked less often.

const ECOWITT = "https://api.ecowitt.net/api/v3/device/";
const CACHE_SECONDS = 60;
const STALE_SECONDS = 1800;
// The edge keeps the last Ecowitt body this long, so fresh console pushes can
// still be laid over it while Ecowitt is down; without a push it is served
// for STALE_SECONDS only, as before.
const KEEP_SECONDS = 6 * 3600;
const HISTORY_SECONDS = 900;
const BARO_SECONDS = 6 * 3600;
// Pages on other origins allowed to read /api/weather from the browser:
// Princeton Live's weather card, and local dev servers.
const CORS_ORIGINS = /^(https:\/\/princetonlive\.berteloot\.org|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const METRIC = { temp_unitid: 1, pressure_unitid: 3, wind_speed_unitid: 7, rainfall_unitid: 12, solar_irradiance_unitid: 16 };
// A push older than this is ignored and the page falls back to Ecowitt alone.
const PUSH_FRESH_SECONDS = 180;
// While pushes arrive, the Ecowitt reading (history, rose, forecast, the
// fields the console does not send) is refreshed this often instead of every
// CACHE_SECONDS.
const PUSH_REFRESH_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/ingest/")) return ingest(request, env, url);
    if (url.pathname !== "/api/weather" && url.pathname !== "/api/history") return env.ASSETS.fetch(request);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const origin = request.headers.get("origin") || "";
    const cors = CORS_ORIGINS.test(origin) ? origin : null;
    if (url.pathname === "/api/history") return stationHistory(env, url, cors);

    // Ecowitt takes 8 to 12 seconds to answer, so visitors never wait on it:
    // the last good reading is served at once (up to STALE_SECONDS old, or
    // KEEP_SECONDS while console pushes arrive), and a reading older than
    // CACHE_SECONDS is refreshed in the background. Only a cold cache makes a
    // visitor wait.
    const cache = caches.default;
    const key = new Request(url.origin + "/api/weather", { method: "GET" });
    const [hit, push] = await Promise.all([cache.match(key), latestPush(env)]);
    const age = hit ? Date.now() / 1000 - Number(hit.headers.get("x-fetched-at") || 0) : Infinity;
    if (hit && (push || age <= STALE_SECONDS)) {
      if (age > (push ? PUSH_REFRESH_SECONDS : CACHE_SECONDS)) ctx.waitUntil(refresh(env, cache, key).catch((err) => console.error("refresh failed", String(err))));
      return client(await overlay(hit, push), cors);
    }

    try {
      return client(await overlay(await refresh(env, cache, key), push), cors);
    } catch (err) {
      console.error("weather failed", String(err));
      return withCors(json({ error: "station unavailable" }, 502, 15), cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(archive(env).then(
      (n) => console.log("archive saved", n, "readings"),
      (err) => { console.error("archive failed", String(err)); throw err; },
    ));
  },
};

// Hourly copy of the station's 5-minute history into D1 (binding DB), because
// Ecowitt keeps 5-minute detail for a limited time only. Each run starts an
// hour before the newest saved reading, so a late or corrected point is
// rewritten, and catches up a missed stretch one day per call, up to
// ARCHIVE_DAYS_PER_RUN days. A cursor in `meta` moves past stretches Ecowitt
// has nothing for once they are ARCHIVE_SETTLE_SECONDS old, so a long outage
// cannot pin every run to the same empty days. Nothing before ARCHIVE_START is
// saved: the station went up on the evening of 19 Oct 2026 and spent it
// cooling from indoor temperature (20.9 °C at 9 PM, falling all evening),
// which would have stood as the warmest reading on record. Midnight 20 Oct in
// Princeton. After saving, the days touched are summarized into `days`.
const ARCHIVE_START = Date.UTC(2026, 9, 20, 4) / 1000;
const ARCHIVE_DAYS_PER_RUN = 4;
const ARCHIVE_SETTLE_SECONDS = 6 * 3600;
const ARCHIVE_FIELDS = {
  temp: ["outdoor", "temperature"], feels_like: ["outdoor", "feels_like"], dew_point: ["outdoor", "dew_point"],
  humidity: ["outdoor", "humidity"], vpd_kpa: ["outdoor", "vpd"],
  wind_speed: ["wind", "wind_speed"], wind_gust: ["wind", "wind_gust"], wind_dir: ["wind", "wind_direction"],
  wind_dir_avg10: ["wind", "10_minute_average_wind_direction"],
  pressure_rel: ["pressure", "relative"], pressure_abs: ["pressure", "absolute"],
  rain_rate: ["rainfall_piezo", "rain_rate"], rain_daily: ["rainfall_piezo", "daily"], rain_event: ["rainfall_piezo", "event"],
  solar: ["solar_and_uvi", "solar"], uvi: ["solar_and_uvi", "uvi"],
};

async function archive(env) {
  if (!env.DB) throw new Error("DB binding missing");
  const auth = ecowittAuth(env);
  const [last, cursor] = await env.DB.batch([
    env.DB.prepare("SELECT MAX(t) AS t FROM readings"),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'archive_cursor'"),
  ]);
  const lastT = last.results[0]?.t ?? 0, cur = Number(cursor.results[0]?.value ?? 0);
  const now = Math.floor(Date.now() / 1000);
  let from = Math.max(lastT - 3600, cur - 3600, ARCHIVE_START);
  let saved = 0;
  const touched = new Set();
  for (let i = 0; i < ARCHIVE_DAYS_PER_RUN && from < now; i++) {
    const to = Math.min(from + 86400, now);
    saved += await archiveRange(env.DB, auth, from, to, touched);
    from = to;
  }
  const writes = [...touched].map((day) => env.DB.prepare(DAY_SUMMARY).bind(day));
  const progress = Math.min(from, now - ARCHIVE_SETTLE_SECONDS);
  if (progress > cur) {
    writes.push(env.DB.prepare("INSERT INTO meta (key, value) VALUES ('archive_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(progress)));
  }
  if (writes.length) await env.DB.batch(writes);
  return saved;
}

async function archiveRange(db, auth, from, to, touched) {
  const h = await call("history", {
    ...auth, ...METRIC, start_date: nyTime(new Date(from * 1000)), end_date: nyTime(new Date(to * 1000)),
    cycle_type: "5min", call_back: "outdoor,wind,pressure,rainfall_piezo,solar_and_uvi",
  });
  const cols = Object.keys(ARCHIVE_FIELDS);
  const rows = new Map();
  cols.forEach((col, i) => {
    const [group, name] = ARCHIVE_FIELDS[col];
    const field = h?.data?.[group]?.[name];
    for (let [t, v] of points(field)) {
      if (col === "vpd_kpa") v = kpa({ value: String(v), unit: field.unit });
      if (!rows.has(t)) rows.set(t, Array(cols.length).fill(null));
      rows.get(t)[i] = v;
    }
  });
  if (!rows.size) return 0;
  const sql = `INSERT INTO readings (t, day, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
    ON CONFLICT(t) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`;
  const stmt = db.prepare(sql);
  await db.batch([...rows].map(([t, vals]) => {
    const day = nyTime(new Date(t * 1000)).slice(0, 10);
    touched.add(day);
    return stmt.bind(t, day, ...vals);
  }));
  return rows.size;
}

// One Princeton date's summary from its readings (the backfill in
// migrations/0002_days_table.sql is the same SELECT over every day). Rain is
// the day's last running total.
const DAY_SUMMARY = `INSERT INTO days (day, temp_low, temp_high, temp_avg, humidity_avg, gust_max, wind_avg,
    rain_mm, rain_rate_max, pressure_low, pressure_high, solar_max, uvi_max, readings)
  SELECT day, MIN(temp), MAX(temp), ROUND(AVG(temp), 1), ROUND(AVG(humidity)), MAX(wind_gust), ROUND(AVG(wind_speed), 1),
    (SELECT r.rain_daily FROM readings r WHERE r.day = readings.day AND r.rain_daily IS NOT NULL ORDER BY r.t DESC LIMIT 1),
    MAX(rain_rate), MIN(pressure_rel), MAX(pressure_rel), MAX(solar), MAX(uvi), COUNT(*)
  FROM readings WHERE day = ? GROUP BY day
  ON CONFLICT(day) DO UPDATE SET temp_low = excluded.temp_low, temp_high = excluded.temp_high, temp_avg = excluded.temp_avg,
    humidity_avg = excluded.humidity_avg, gust_max = excluded.gust_max, wind_avg = excluded.wind_avg, rain_mm = excluded.rain_mm,
    rain_rate_max = excluded.rain_rate_max, pressure_low = excluded.pressure_low, pressure_high = excluded.pressure_high,
    solar_max = excluded.solar_max, uvi_max = excluded.uvi_max, readings = excluded.readings`;

// /api/history: what the saved readings add to the page. Hourly points for the
// 7-day charts, one row per day (`days`) for the 30-day charts, the season
// cards and the year-on-year strip, all-time records with their day, today's
// calendar date in earlier years, and the first and newest saved reading
// (`latest` shows whether the cron is keeping up). D1 only, no Ecowitt call;
// the edge keeps a copy for HISTORY_API_SECONDS.
const HISTORY_API_SECONDS = 600;
async function stationHistory(env, url, cors) {
  const cache = caches.default;
  const key = new Request(url.origin + "/api/history", { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return client(hit, cors);
  try {
    if (!env.DB) throw new Error("DB binding missing");
    const now = Math.floor(Date.now() / 1000);
    const today = nyTime(new Date(now * 1000)).slice(0, 10);
    const top = (col, dir) => `SELECT day, ${col} AS v FROM days WHERE ${col} IS NOT NULL ORDER BY ${col} ${dir}, day LIMIT 1`;
    const [hourly, daily, hi, lo, gust, wet, span, same] = await env.DB.batch([
      env.DB.prepare(`SELECT (t / 3600) * 3600 AS h, ROUND(AVG(temp), 2) AS ta, MIN(temp) AS tl, MAX(temp) AS th,
          ROUND(AVG(wind_speed), 2) AS wa, MAX(wind_gust) AS wg
        FROM readings WHERE t >= ? GROUP BY h ORDER BY h`).bind(now - 7 * 86400),
      // 400 days: the 30-day charts, this season, and the same week a year ago.
      env.DB.prepare(`SELECT day, temp_low, temp_high, temp_avg, gust_max, wind_avg, rain_mm, readings
        FROM days WHERE day >= ? ORDER BY day`).bind(nyTime(new Date((now - 400 * 86400) * 1000)).slice(0, 10)),
      env.DB.prepare(top("temp_high", "DESC")), env.DB.prepare(top("temp_low", "ASC")),
      env.DB.prepare(top("gust_max", "DESC")), env.DB.prepare(top("rain_mm", "DESC")),
      // Two subqueries, so each uses the primary key (2 rows read); MIN and MAX in
      // one SELECT scan the whole table.
      env.DB.prepare("SELECT (SELECT MIN(t) FROM readings) AS first, (SELECT MAX(t) FROM readings) AS last"),
      // This calendar date in earlier years, for "Warmest October 21 on this station".
      env.DB.prepare("SELECT MAX(temp_high) AS high, MIN(temp_low) AS low, COUNT(*) AS n FROM days WHERE substr(day, 6) = ? AND day < ?")
        .bind(today.slice(5), today),
    ]);
    const row = (r) => r.results[0] || null;
    const body = {
      since: row(span)?.first ?? null,
      latest: row(span)?.last ?? null,
      hourly: hourly.results.map((r) => [r.h, r.ta, r.tl, r.th, r.wa, r.wg]),
      daily: daily.results.map((r) => [r.day, r.temp_low, r.temp_high, r.temp_avg, r.gust_max, r.wind_avg, r.rain_mm, r.readings]),
      records: { warmest: row(hi), coldest: row(lo), gust: row(gust), wettest: row(wet) },
      same_date: { day: today, ...row(same) },
    };
    const res = json(body, 200, HISTORY_API_SECONDS);
    await cache.put(key, res.clone());
    return client(res, cors);
  } catch (err) {
    console.error("history failed", String(err));
    return withCors(json({ error: "history unavailable" }, 502, 15), cors);
  }
}

async function refresh(env, cache, key) {
  const res = json(await weather(env), 200, KEEP_SECONDS);
  res.headers.set("x-fetched-at", String(Math.floor(Date.now() / 1000)));
  await cache.put(key, res.clone());
  return res;
}

// Browsers keep it for a minute at most; the long TTL is only for the edge copy.
function client(res, cors) {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", `public, max-age=${CACHE_SECONDS}`);
  out.headers.delete("x-fetched-at");
  return withCors(out, cors);
}

// The edge copy is shared by every origin, so the CORS header is added per
// request here, never stored in the cache.
function withCors(res, cors) {
  res.headers.set("vary", "Origin");
  if (cors) res.headers.set("access-control-allow-origin", cors);
  return res;
}

// Console uploads (Ecowitt protocol: a form post in imperial units). The path
// token keeps strangers out, since the console can only post plain HTTP; the
// PASSKEY the console adds (MD5 of its MAC) is checked when INGEST_PASSKEY is
// set; values outside physical ranges are dropped. The field names of the
// last upload, never the values, go to meta `ingest_fields` for debugging.
const MPH = 1.609344, INHG = 33.8639, INCH = 25.4;
async function ingest(request, env, url) {
  const token = url.pathname.slice("/api/ingest/".length);
  if (!env.INGEST_TOKEN || !env.DB || !sameText(token, env.INGEST_TOKEN)) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let form;
  try {
    form = Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ error: "bad form" }, 400);
  }
  if (env.INGEST_PASSKEY && !sameText(String(form.PASSKEY || ""), env.INGEST_PASSKEY)) {
    console.error("ingest passkey mismatch");
    return json({ error: "forbidden" }, 403);
  }

  const f = (...keys) => {
    for (const k of keys) {
      const v = Number(form[k]);
      if (form[k] != null && form[k] !== "" && Number.isFinite(v)) return v;
    }
    return null;
  };
  const within = (v, lo, hi) => (v != null && v >= lo && v <= hi ? v : null);
  const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const times = (v, k) => (v == null ? null : v * k);

  const now = Math.floor(Date.now() / 1000);
  const sent = Date.parse(String(form.dateutc || "").replace(" ", "T") + "Z") / 1000;
  const t = Number.isFinite(sent) && Math.abs(now - sent) < 600 ? Math.floor(sent) : now;
  const tf = f("tempf");
  const temp = within(round(tf == null ? null : (tf - 32) * 5 / 9), -50, 60);
  const humidity = within(f("humidity"), 1, 100);
  const windSpeed = within(round(times(f("windspeedmph"), MPH)), 0, 300);
  const rain = (piezo, plain) => within(round(times(f(piezo, plain), INCH)), 0, 5000);
  const raining = f("srain_piezo");
  const row = {
    t, temp, feels_like: feelsLike(temp, humidity, windSpeed), dew_point: dewPoint(temp, humidity), humidity,
    wind_speed: windSpeed, wind_gust: within(round(times(f("windgustmph"), MPH)), 0, 400), wind_dir: within(f("winddir"), 0, 360),
    wind_dir_avg10: within(f("winddir_avg10m"), 0, 360), vpd_kpa: vpdKpa(temp, humidity), rain_24h: rain("last24hrain_piezo", "last24hrainin"),
    pressure_rel: within(round(times(f("baromrelin"), INHG)), 870, 1090), pressure_abs: within(round(times(f("baromabsin"), INHG)), 600, 1090),
    rain_rate: rain("rrain_piezo", "rainratein"), rain_hour: rain("hrain_piezo", "hourlyrainin"), rain_event: rain("erain_piezo", "eventrainin"),
    rain_day: rain("drain_piezo", "dailyrainin"), rain_week: rain("wrain_piezo", "weeklyrainin"), rain_month: rain("mrain_piezo", "monthlyrainin"),
    rain_year: rain("yrain_piezo", "yearlyrainin"), raining: raining == null ? null : raining > 0 ? 1 : 0,
    solar: within(f("solarradiation"), 0, 2000), uvi: within(f("uv"), 0, 20),
    battery_v: within(f("wh90batt"), 0, 10), capacitor_v: within(f("ws90cap_volt"), 0, 10),
  };
  // A reading without a usable temperature is noise; it must not overwrite a
  // good row from the same second.
  if (temp == null) return json({ error: "no temperature" }, 400);
  const cols = Object.keys(row);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO minutes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT(t) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`).bind(...cols.map((c) => row[c])),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('ingest_fields', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(Object.keys(form).filter((k) => k !== "PASSKEY").sort().join(",")),
  ]);
  return new Response("OK");
}

// The newest console upload as page fields, or null when there is none
// fresher than PUSH_FRESH_SECONDS (or no table yet).
async function latestPush(env) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare("SELECT * FROM minutes ORDER BY t DESC LIMIT 1").first();
    if (!r || Date.now() / 1000 - r.t > PUSH_FRESH_SECONDS) return null;
    const now = {
      temp: r.temp, feels_like: r.feels_like, dew_point: r.dew_point, humidity: r.humidity,
      wind_speed: r.wind_speed, wind_gust: r.wind_gust, wind_dir: r.wind_dir, pressure: r.pressure_rel,
      wind_dir_avg10: r.wind_dir_avg10, vpd_kpa: r.vpd_kpa, rain_24h: r.rain_24h,
      raining: r.raining == null ? null : r.raining === 1,
      rain_rate: r.rain_rate, rain_1h: r.rain_hour, rain_event: r.rain_event, rain_day: r.rain_day,
      rain_week: r.rain_week, rain_month: r.rain_month, rain_year: r.rain_year,
      solar: r.solar, uvi: r.uvi, battery_v: r.battery_v, capacitor_v: r.capacitor_v,
    };
    for (const k of Object.keys(now)) if (now[k] == null) delete now[k];
    return { t: r.t, now };
  } catch (err) {
    console.error("push read failed", String(err));
    return null;
  }
}

// The Ecowitt body with the console's fresher live values laid over it.
async function overlay(res, push) {
  if (!push) return res;
  const body = await res.json();
  if (push.t < (body.observed || 0)) return json(body, 200);
  return json({ ...body, observed: push.t, source: "console", now: { ...body.now, ...push.now } }, 200);
}

// Vapour pressure deficit in kPa (Tetens saturation pressure).
function vpdKpa(temp, rh) {
  if (temp == null || rh == null) return null;
  const es = 0.6108 * Math.exp((17.27 * temp) / (temp + 237.3));
  return Math.round(es * (1 - rh / 100) * 1000) / 1000;
}

// Magnus formula, °C.
function dewPoint(temp, rh) {
  if (temp == null || rh == null || rh <= 0) return null;
  const g = Math.log(rh / 100) + (17.62 * temp) / (243.12 + temp);
  return Math.round(((243.12 * g) / (17.62 - g)) * 10) / 10;
}

// As the console computes it: wind chill at or below 10 °C with wind over
// 4.8 km/h, heat index from 26.7 °C, the air temperature in between.
function feelsLike(temp, rh, wind) {
  if (temp == null) return null;
  let v = temp;
  if (temp <= 10 && wind != null && wind > 4.8) {
    const w = wind ** 0.16;
    v = 13.12 + 0.6215 * temp - 11.37 * w + 0.3965 * temp * w;
  } else if (temp >= 26.7 && rh != null) {
    const T = temp * 9 / 5 + 32, R = rh;
    const hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T
      - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    v = ((hi - 32) * 5) / 9;
  }
  return Math.round(v * 10) / 10;
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ecowittAuth(env) {
  if (!env.ECOWITT_APP || !env.ECOWITT_API || !env.ECOWITT_MAC) throw new Error("ecowitt secrets missing");
  return { application_key: env.ECOWITT_APP, api_key: env.ECOWITT_API, mac: env.ECOWITT_MAC };
}

async function weather(env) {
  const auth = ecowittAuth(env);

  // Ecowitt answers "Operation too frequent" to two history calls at once, so
  // the two history reads run one after the other.
  const [rt, [history, month]] = await Promise.all([
    call("real_time", { ...auth, ...METRIC, call_back: "outdoor,wind,pressure,rainfall_piezo,solar_and_uvi,battery,lightning" }),
    chart(auth).then(async (h) => [h, await pressureMonth(auth)]),
  ]);

  const d = rt.data || {};
  const o = d.outdoor || {}, w = d.wind || {}, p = d.pressure || {}, r = d.rainfall_piezo || {}, s = d.solar_and_uvi || {}, b = d.battery || {};
  const l = d.lightning;

  return {
    station: "Princeton, NJ",
    observed: Number(o.temperature?.time || rt.time || 0),
    now: {
      temp: num(o.temperature), feels_like: num(o.feels_like), dew_point: num(o.dew_point),
      humidity: num(o.humidity),
      wind_speed: num(w.wind_speed), wind_gust: num(w.wind_gust), wind_dir: num(w.wind_direction),
      wind_dir_avg10: num(w["10_minute_average_wind_direction"]),
      pressure: num(p.relative),
      raining: r.state ? r.state.value === "1" : null,
      rain_rate: num(r.rain_rate), rain_1h: num(r["1_hour"]), rain_24h: num(r["24_hours"]), rain_event: num(r.event),
      rain_day: num(r.daily), rain_week: num(r.weekly), rain_month: num(r.monthly), rain_year: num(r.yearly),
      solar: num(s.solar), uvi: num(s.uvi),
      vpd_kpa: kpa(o.vpd),
      battery_v: num(b.haptic_array_battery), capacitor_v: num(b.haptic_array_capacitor),
    },
    lightning: lightning(l, b.lightning_sensor),
    history: history.temp,
    wind_history: history.wind.map(([t, speed, gust]) => [t, speed, gust]),
    today: today(history),
    forecast: barometer(history.pressure, month, num(o.temperature)),
  };
}

// Ecowitt caps how often its API can be called (it answered "The number of
// interface accesses reached the upper limit" on 20 Oct 2026), and history
// changes slowly, so each history read runs at most every maxAge seconds and
// the last good copy is served when Ecowitt fails.
async function cached(name, maxAge, load, empty) {
  const cache = caches.default;
  const key = new Request("https://altilead.com/__cache/" + name, { method: "GET" });
  const hit = await cache.match(key);
  const age = hit ? Date.now() / 1000 - Number(hit.headers.get("x-fetched-at") || 0) : Infinity;
  if (hit && age < maxAge) return hit.json();

  try {
    const value = await load();
    const res = json(value, 200, maxAge * 4);
    res.headers.set("x-fetched-at", String(Math.floor(Date.now() / 1000)));
    await cache.put(key, res);
    return value;
  } catch (err) {
    console.error(name + " failed", String(err));
    return hit ? hit.json() : empty; // charts and forecast are optional; live readings are not
  }
}

async function history(auth, days, cycle, fields) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400 * 1000);
  return call("history", { ...auth, ...METRIC, start_date: nyTime(start), end_date: nyTime(end), cycle_type: cycle, call_back: fields });
}

// The last 24 hours at 5-minute steps: temperature for the chart and today's
// high and low, pressure for the forecast, wind for the peak gust and the rose.
function chart(auth) {
  return cached("weather-history-v3", HISTORY_SECONDS, async () => {
    const h = await history(auth, 1, "5min", "outdoor.temperature,pressure.relative,wind.wind_speed,wind.wind_gust,wind.wind_direction");
    const speed = new Map(points(h?.data?.wind?.wind_speed)), gust = new Map(points(h?.data?.wind?.wind_gust));
    return {
      temp: points(h?.data?.outdoor?.temperature),
      pressure: points(h?.data?.pressure?.relative),
      wind: points(h?.data?.wind?.wind_direction).map(([t, dir]) => [t, speed.get(t) ?? null, gust.get(t) ?? null, dir]),
    };
  }, { temp: [], pressure: [], wind: [] });
}

// Since midnight in Princeton: high and low with their times, the strongest
// gust, and a 16-sector wind rose (share of readings per sector and their
// average speed; a speed that rounds to 0 km/h counts as calm, Beaufort force 0). The page folds in the live
// reading, which history trails by a few minutes.
function today(history) {
  const start = nyMidnight();
  const temp = history.temp.filter(([t]) => t >= start);
  const wind = (history.wind || []).filter(([t]) => t >= start);
  const pick = (xs, better) => xs.reduce((best, x) => (best == null || better(x[1], best[1]) ? x : best), null);
  const sectors = Array.from({ length: 16 }, () => ({ n: 0, sum: 0 }));
  let calm = 0;
  for (const [, speed, , dir] of wind) {
    if (speed == null || dir == null) continue;
    if (Math.round(speed) < 1) { calm++; continue; } // Beaufort force 0, as the page rounds it
    const s = sectors[Math.round(dir / 22.5) % 16];
    s.n++; s.sum += speed;
  }
  const gusts = wind.filter(([, , g]) => g != null).map(([t, , g]) => [t, g]);
  return {
    since: start,
    high: pick(temp, (a, b) => a > b),
    low: pick(temp, (a, b) => a < b),
    gust: pick(gusts, (a, b) => a > b),
    rose: { calm, total: calm + sectors.reduce((a, s) => a + s.n, 0), sectors: sectors.map((s) => [s.n, s.n ? Math.round((s.sum / s.n) * 10) / 10 : 0]) },
  };
}

// Epoch seconds of the last midnight in Princeton. The UTC offset is read at
// midnight itself, not now, so the two daylight-saving days come out right.
function nyMidnight(now = new Date()) {
  const parts = (date) => Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]),
  );
  const offset = (date) => { // New York minus UTC, in ms
    const q = parts(date);
    return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - Math.floor(date.getTime() / 1000) * 1000;
  };
  const p = parts(now);
  const local = Date.UTC(p.year, p.month - 1, p.day);
  let guess = local - offset(now);
  guess = local - offset(new Date(guess));
  return Math.floor(guess / 1000);
}

// 30 days of pressure at 4-hour steps, for the console's "learning" baseline.
function pressureMonth(auth) {
  return cached("weather-pressure-month", BARO_SECONDS, async () => {
    const h = await history(auth, 30, "4hour", "pressure.relative");
    return points(h?.data?.pressure?.relative);
  }, []);
}

// The Ecowitt console forecast (the station's HP2560_C console; the WS2910
// manual, section 5.2.2, gives the detail in the same words): six outcomes
// from the rate of change of pressure, and Snowy in place of Rainy or Stormy at
// or below 0 °C. The manual gives the 1 hPa tendency step; Ecowitt does not
// publish the rest, so "sustained" here means the 6-hour change agrees and
// "rapid" means 3 hPa or more in 3 hours. Like the console, a steady barometer
// keeps the last outcome, so the series is replayed from its start, seeded
// from today's average against the 30-day average (the console's "learning"
// graph). Returns null until there are 3 hours of pressure to judge from.
const RAPID_FALL = -3, TENDENCY = 1, SUSTAINED = 2;
function barometer(series, month, tempC) {
  const all = series.filter(([, v]) => v > 800);
  if (all.length < 2 || all[all.length - 1][0] - all[0][0] < 3 * 3600) return null;
  // The console updates its pressure trend every 30 minutes (manual 5.2.3), so
  // decisions step through readings at least 30 minutes apart; the 5-minute
  // series still goes back whole for the chart.
  const p = [];
  for (const point of all) if (!p.length || point[0] - p[p.length - 1][0] >= 1800) p.push(point);
  if (p[p.length - 1] !== all[all.length - 1]) p.push(all[all.length - 1]); // always judge the latest reading
  const avg = (xs) => (xs.length ? xs.reduce((a, [, v]) => a + v, 0) / xs.length : null);
  const now = Date.now() / 1000;
  const day = avg(p.filter(([t]) => t > now - 86400));
  const base = avg(month.filter(([, v]) => v > 800));
  const anomaly = day != null && base != null ? Math.round((day - base) * 10) / 10 : null;
  const learned = month.length ? Math.min(30, Math.max(1, Math.ceil((now - month[0][0]) / 86400))) : 0;

  // Change over the last `hours`, read by time because Ecowitt's history has
  // gaps: the reading closest to that time, if one is within 45 minutes.
  const change = (i, hours) => {
    const target = p[i][0] - hours * 3600;
    let best = null;
    for (let j = 0; j < i; j++) if (best == null || Math.abs(p[j][0] - target) < Math.abs(p[best][0] - target)) best = j;
    return best != null && Math.abs(p[best][0] - target) <= 2700 ? p[i][1] - p[best][1] : null;
  };

  let state = anomaly == null ? "partly" : anomaly >= 3 ? "sunny" : anomaly >= 0 ? "partly" : anomaly > -3 ? "cloudy" : "rainy";
  let since = p[0][0];
  for (let i = 1; i < p.length; i++) {
    const d3 = change(i, 3), d6 = change(i, 6);
    if (d3 == null) continue;
    let next = state;
    if (d3 <= RAPID_FALL) next = "stormy";
    else if (d3 < -TENDENCY) next = d6 != null && d6 <= -SUSTAINED ? "rainy" : "cloudy";
    else if (d3 > TENDENCY) next = d6 != null && d6 >= SUSTAINED ? "sunny" : "partly";
    if (next !== state) { state = next; since = p[i][0]; }
  }
  if (tempC != null && tempC <= 0 && (state === "rainy" || state === "stormy")) state = state === "stormy" ? "stormsnow" : "snowy";

  const d3 = change(p.length - 1, 3);
  return {
    state,
    since,
    change3h: d3 == null ? null : Math.round(d3 * 10) / 10,
    anomaly,
    learned,
    pressure: all,
  };
}

function points(field) {
  return Object.entries(field?.list || {})
    .map(([t, v]) => [Number(t), Number(v)])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
}

async function call(endpoint, params) {
  const res = await fetch(ECOWITT + endpoint + "?" + new URLSearchParams(params), {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`${endpoint} http ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`${endpoint} code ${body.code} ${body.msg}`);
  return body;
}

// Ecowitt reads start_date/end_date in the station's own time zone.
function nyTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// WH57 lightning sensor. Null until it is paired: Ecowitt then sends no
// lightning group, and the page shows the card's "on its way" state. The
// distance timestamp is the time of the latest strike; the count is today's.
// Battery is a 0 to 5 level (5 = 81 to 100%), not volts.
function lightning(l, battery) {
  if (!l || (!l.distance && !l.count)) return null;
  const miles = String(l.distance?.unit || "").toLowerCase().startsWith("mi");
  const d = num(l.distance);
  const at = Number(l.distance?.time || 0);
  return {
    distance_km: d == null ? null : Math.round((miles ? d * 1.609344 : d) * 10) / 10,
    last_strike: d == null || !at ? null : at,
    count_today: num(l.count),
    battery_level: num(battery),
  };
}

// Ecowitt reports VPD in the pressure unit family it picks (inHg here), so it
// is converted by its own unit field.
function kpa(field) {
  const v = num(field);
  if (v == null) return null;
  const unit = String(field.unit || "").toLowerCase();
  const k = unit.includes("inhg") ? v * 3.38639 : unit.includes("hpa") ? v / 10 : unit.includes("mmhg") ? v * 0.133322 : v;
  return Math.round(k * 100) / 100;
}

function num(field) {
  const v = Number(field?.value);
  return field && field.value !== "" && Number.isFinite(v) ? v : null;
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
