-- strikes: the lightning sensor's (WH57) strikes, kept from the console's
-- uploads for the lightning card's approach chart. The console sends only its
-- latest strike and the day's count, so one row is a strike time and n is the
-- rise in that count since the day's previous row.
CREATE TABLE strikes (
  t INTEGER PRIMARY KEY,  -- unix seconds, the console's strike time
  day TEXT,               -- New York date
  distance_km REAL,       -- the sensor's estimate
  count_day INTEGER,      -- the console's count for the day after this strike
  n INTEGER               -- strikes this row stands for
);
