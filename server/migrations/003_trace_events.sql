-- 003_trace_events: one trace per run (§ 2.5.9)
CREATE TABLE trace_event (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                       -- event types in § 2.5.9
  clock_at INTEGER NOT NULL,
  duration_ms INTEGER,
  data TEXT NOT NULL,                       -- JSON: allow-listed fields only
  PRIMARY KEY (run_id, seq)
) STRICT;