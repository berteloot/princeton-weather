-- One row per upload the HP2560 console pushes to /api/ingest (its
-- Customized server setting, every 60 seconds), converted to metric. The
-- newest row overlays the live reading on /api/weather; `readings` keeps the
-- 5-minute history from Ecowitt as before.
CREATE TABLE minutes (
  t INTEGER PRIMARY KEY,
  temp REAL, feels_like REAL, dew_point REAL, humidity REAL,
  wind_speed REAL, wind_gust REAL, wind_dir REAL,
  pressure_rel REAL, pressure_abs REAL,
  rain_rate REAL, rain_hour REAL, rain_event REAL, rain_day REAL,
  rain_week REAL, rain_month REAL, rain_year REAL, raining INTEGER,
  solar REAL, uvi REAL, battery_v REAL, capacitor_v REAL
);
