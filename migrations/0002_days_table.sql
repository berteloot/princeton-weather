-- The `daily` view recomputed every day from all readings on each read, so a
-- year of history meant ~100k rows read per query. `days` holds one row per
-- Princeton date instead, rewritten by the hourly cron for the days it saved
-- (worker.js, DAY_SUMMARY). Rain is the day's last running total, not its
-- maximum, so a midnight reading that still carries yesterday's total cannot
-- leak into the new day.
DROP VIEW daily;
CREATE TABLE days (
  day TEXT PRIMARY KEY,
  temp_low REAL, temp_high REAL, temp_avg REAL,
  humidity_avg REAL,
  gust_max REAL, wind_avg REAL,
  rain_mm REAL, rain_rate_max REAL,
  pressure_low REAL, pressure_high REAL,
  solar_max REAL, uvi_max REAL,
  readings INTEGER NOT NULL
);
-- Archive progress past stretches Ecowitt has no data for (station offline),
-- so the cron never rescans the same empty days.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Backfill every saved day with the summary the cron writes (DAY_SUMMARY in worker.js).
INSERT INTO days (day, temp_low, temp_high, temp_avg, humidity_avg, gust_max, wind_avg,
    rain_mm, rain_rate_max, pressure_low, pressure_high, solar_max, uvi_max, readings)
  SELECT day, MIN(temp), MAX(temp), ROUND(AVG(temp), 1), ROUND(AVG(humidity)), MAX(wind_gust), ROUND(AVG(wind_speed), 1),
    (SELECT r.rain_daily FROM readings r WHERE r.day = readings.day AND r.rain_daily IS NOT NULL ORDER BY r.t DESC LIMIT 1),
    MAX(rain_rate), MIN(pressure_rel), MAX(pressure_rel), MAX(solar), MAX(uvi), COUNT(*)
  FROM readings WHERE true GROUP BY day;
