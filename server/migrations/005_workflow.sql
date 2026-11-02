-- 005_workflow: the task a conversation is working on (§ 2.5.2)
CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  intent TEXT CHECK (intent IN ('book','reschedule','cancel') OR intent IS NULL),
  phase TEXT NOT NULL DEFAULT 'collecting',
  facts TEXT NOT NULL DEFAULT '{}',          -- JSON: { service, area, time_window, budget, preferences }
  target_booking_id TEXT,                    -- reschedule / cancel
  candidates TEXT,                           -- JSON: the last search results shown (U18)
  pending_question TEXT,                     -- JSON: the one explicit question (R9), null if none
  version INTEGER NOT NULL DEFAULT 0,        -- +1 per save; stale saves rejected
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- At most one active workflow per conversation (2.5.2); finished ones stay as history.
CREATE UNIQUE INDEX one_active_workflow ON workflow(conversation_id)
  WHERE phase NOT IN ('done', 'failed', 'abandoned');