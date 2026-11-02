-- Memory facts (MH-6, 2.5.8): stable per-user preferences. Only the memory module
-- touches this table. Values are checked against shapes in code (areas, "HH:mm"); the
-- forgotten row doubles as the re-inference blocker (key + value remain).
CREATE TABLE memory_fact (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  service       TEXT,
  value         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('stated', 'inferred')),
  status        TEXT NOT NULL CHECK (status IN ('active', 'awaiting_confirmation', 'forgotten')),
  evidence      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  confirmed_at  INTEGER,
  forgotten_at  INTEGER
) STRICT;

CREATE INDEX idx_memory_fact_user ON memory_fact (user_id, key, status);