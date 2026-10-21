-- The console also sends the 10-minute average wind direction and the
-- 24-hour rain; VPD is computed from its temperature and humidity.
ALTER TABLE minutes ADD COLUMN wind_dir_avg10 REAL;
ALTER TABLE minutes ADD COLUMN vpd_kpa REAL;
ALTER TABLE minutes ADD COLUMN rain_24h REAL;
