-- Indoor temperature (°C) and humidity (%) from the HP2560 console, kept
-- for your own use. /api/weather never returns them.
ALTER TABLE minutes ADD COLUMN temp_in REAL;
ALTER TABLE minutes ADD COLUMN humidity_in REAL;
ALTER TABLE readings ADD COLUMN temp_in REAL;
ALTER TABLE readings ADD COLUMN humidity_in REAL;
