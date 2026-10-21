-- One row per 5-minute Ecowitt history point, metric units as the API sends
-- them (VPD converted to kPa). `t` is epoch seconds; `day` is the Princeton
-- calendar date, so daily figures need no time-zone math in SQL.
CREATE TABLE readings (
  t INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  temp REAL,          -- °C
  feels_like REAL,    -- °C
  dew_point REAL,     -- °C
  humidity REAL,      -- %
  vpd_kpa REAL,
  wind_speed REAL,    -- km/h
  wind_gust REAL,     -- km/h
  wind_dir REAL,      -- degrees
  wind_dir_avg10 REAL,
  pressure_rel REAL,  -- hPa
  pressure_abs REAL,  -- hPa
  rain_rate REAL,     -- mm/h
  rain_daily REAL,    -- mm since local midnight (running total)
  rain_event REAL,    -- mm
  solar REAL,         -- W/m²
  uvi REAL
);
CREATE INDEX readings_day ON readings(day);

-- Daily summary, derived, so it never disagrees with the readings.
CREATE VIEW daily AS
SELECT day,
  MIN(temp) AS temp_low, MAX(temp) AS temp_high, ROUND(AVG(temp), 1) AS temp_avg,
  ROUND(AVG(humidity), 0) AS humidity_avg,
  MAX(wind_gust) AS gust_max, ROUND(AVG(wind_speed), 1) AS wind_avg,
  MAX(rain_daily) AS rain_mm, MAX(rain_rate) AS rain_rate_max,
  MIN(pressure_rel) AS pressure_low, MAX(pressure_rel) AS pressure_high,
  MAX(solar) AS solar_max, MAX(uvi) AS uvi_max,
  COUNT(*) AS readings
FROM readings GROUP BY day;
