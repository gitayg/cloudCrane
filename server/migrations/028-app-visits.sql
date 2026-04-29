CREATE TABLE IF NOT EXISTS app_visits (
  user_id INTEGER NOT NULL,
  app_id  INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  PRIMARY KEY (user_id, app_id, day)
);
