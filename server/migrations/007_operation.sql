-- 007_operation: one row per approved action, saved before the tool is called (§ 2.5.6)
CREATE TABLE operation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('book','cancel','reschedule')),
  user_id TEXT NOT NULL REFERENCES user(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval(id),  -- one operation per approval: no double booking
  idempotency_key TEXT NOT NULL UNIQUE,     -- '<operation id>:<n>', n = hold sequence
  hold_seq INTEGER NOT NULL DEFAULT 1,
  request TEXT NOT NULL,                    -- JSON: exactly what is sent
  booking_id TEXT,                          -- target booking for cancel / reschedule (R3); null for book
  status TEXT NOT NULL CHECK (status IN ('in_flight','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,                              -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX operation_in_flight ON operation(status) WHERE status = 'in_flight';  -- startup recovery
-- R3: at most one in-flight operation per target booking (nulls exempt, so book is unaffected):
CREATE UNIQUE INDEX one_in_flight_operation_per_booking ON operation(booking_id) WHERE status = 'in_flight';
