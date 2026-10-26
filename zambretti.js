// The Zambretti forecaster (Negretti & Zambra, 1915), in the widely used
// electronic form published by beteljuice: sea-level pressure, its 3-hour
// trend, the wind direction and the season pick one of 26 forecasts for the
// next 12 hours. Used by the forecast in worker.js (barometer()).
//
// The trend is judged after taking out the atmosphere's daily pressure tide,
// which lifts pressure toward 10 AM and 10 PM and lowers it toward 4 AM and
// 4 PM local time whatever the weather does (about 0.3 to 0.6 hPa each way at
// middle latitudes, Dai & Wang 1999, J. Atmos. Sci.). On 26 Oct 2026 the old
// alert called a 3.1 hPa fall from 9:30 AM to 12:30 PM at 1024 hPa a storm
// sign; part of it was the tide and the forecast that day was sunny.

const NY = "America/New_York";
export const TIDE_HPA = 0.6;
export const TREND_HPA = 1.6; // per 3 hours, Zambretti's rising or falling step

export const FORECASTS = ["Settled fine", "Fine weather", "Becoming fine", "Fine, becoming less settled", "Fine, possible showers",
  "Fairly fine, improving", "Fairly fine, possible showers early", "Fairly fine, showery later", "Showery early, improving",
  "Changeable, mending", "Fairly fine, showers likely", "Rather unsettled, clearing later", "Unsettled, probably improving",
  "Showery, bright intervals", "Showery, becoming less settled", "Changeable, some rain", "Unsettled, short fine intervals",
  "Unsettled, rain later", "Unsettled, some rain", "Mostly very unsettled", "Occasional rain, worsening",
  "Rain at times, very unsettled", "Rain at frequent intervals", "Rain, very unsettled", "Stormy, may improve", "Stormy, much rain"];
// Index into FORECASTS for each of 22 pressure bands from 950 to 1050 hPa.
const RISE = [25, 25, 25, 24, 24, 19, 16, 12, 11, 9, 8, 6, 5, 2, 1, 1, 0, 0, 0, 0, 0, 0];
const STEADY = [25, 25, 25, 25, 25, 25, 23, 23, 22, 18, 15, 13, 10, 4, 1, 1, 0, 0, 0, 0, 0, 0];
const FALL = [25, 25, 25, 25, 25, 25, 25, 25, 23, 23, 21, 20, 17, 14, 7, 3, 1, 1, 1, 0, 0, 0];
// Northern hemisphere wind allowance, percent of the 100 hPa range, N first in 16 points.
const WIND = [6, 5, 5, 2, -0.5, -2, -5, -8.5, -12, -10, -6, -4.5, -3, -0.5, 1.5, 3];
// The page's icon for each forecast.
const ICON = ["sunny", "sunny", "sunny", "partly", "partly", "partly", "partly", "partly", "cloudy", "partly", "cloudy", "cloudy", "cloudy",
  "rainy", "rainy", "rainy", "cloudy", "rainy", "rainy", "rainy", "rainy", "rainy", "rainy", "rainy", "stormy", "stormy"];

function nyParts(t) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: NY, hourCycle: "h23", month: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(new Date(t * 1000)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
}

// The daily tide's share of pressure at time t (epoch seconds), hPa.
export function tide(t) {
  const q = nyParts(t), h = q.hour + q.minute / 60;
  return TIDE_HPA * Math.cos((2 * Math.PI * (h - 10)) / 12);
}

// Change from (t0, p0) to (t1, p1) with the daily tide taken out.
export function tideFree(t0, p0, t1, p1) {
  return (p1 - tide(t1)) - (p0 - tide(t0));
}

export function trendOf(change3h) {
  return change3h == null ? "steady" : change3h <= -TREND_HPA ? "falling" : change3h >= TREND_HPA ? "rising" : "steady";
}

// slp: sea-level pressure (hPa); trend: "rising", "falling" or "steady";
// windDeg: where the wind blows from, or null when calm or unknown; t: epoch
// seconds, for the season. Returns { index, letter, text, icon }.
export function zambretti(slp, trend, windDeg, t) {
  const top = 1050, bottom = 950, range = top - bottom;
  let p = slp;
  if (windDeg != null) p += (WIND[Math.round((((windDeg % 360) + 360) % 360) / 22.5) % 16] / 100) * range;
  const month = nyParts(t).month;
  if (month >= 4 && month <= 9) p += trend === "rising" ? 0.07 * range : trend === "falling" ? -0.07 * range : 0;
  if (p >= top) p = top - 1;
  let band = Math.floor((p - bottom) / (range / 22)), exceptional = false;
  if (band < 0 || band > 21) { band = Math.max(0, Math.min(21, band)); exceptional = true; }
  const index = (trend === "rising" ? RISE : trend === "falling" ? FALL : STEADY)[band];
  return { index, letter: String.fromCharCode(65 + index), text: (exceptional ? "Exceptional weather, " : "") + FORECASTS[index], icon: ICON[index] };
}
