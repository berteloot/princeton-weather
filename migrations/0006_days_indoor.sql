-- Indoor summary per day, so months and years of indoor history read one row
-- per day instead of every 5-minute reading. Written by DAY_SUMMARY in
-- worker.js with the rest of the row; backfilled here for the saved days.
ALTER TABLE days ADD COLUMN temp_in_low REAL;
ALTER TABLE days ADD COLUMN temp_in_high REAL;
ALTER TABLE days ADD COLUMN temp_in_avg REAL;
ALTER TABLE days ADD COLUMN humidity_in_low REAL;
ALTER TABLE days ADD COLUMN humidity_in_high REAL;
ALTER TABLE days ADD COLUMN humidity_in_avg REAL;
UPDATE days SET
  temp_in_low = (SELECT MIN(temp_in) FROM readings r WHERE r.day = days.day),
  temp_in_high = (SELECT MAX(temp_in) FROM readings r WHERE r.day = days.day),
  temp_in_avg = (SELECT ROUND(AVG(temp_in), 1) FROM readings r WHERE r.day = days.day),
  humidity_in_low = (SELECT MIN(humidity_in) FROM readings r WHERE r.day = days.day),
  humidity_in_high = (SELECT MAX(humidity_in) FROM readings r WHERE r.day = days.day),
  humidity_in_avg = (SELECT ROUND(AVG(humidity_in)) FROM readings r WHERE r.day = days.day);
