-- One row a day, with one number in it. Nothing about visitors.
CREATE TABLE daily_requests (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
