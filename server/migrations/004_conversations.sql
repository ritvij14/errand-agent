-- 004_conversations: conversations, runs, messages (§ 2.5.3, schema.md)
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX conversation_by_user ON conversation(user_id, updated_at);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('message','pick','approval_decision','recovery')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,                             -- completed | cap_* | retries_exhausted | error | unknown_error
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  run_id TEXT REFERENCES run(id),
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  text TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  client_message_id TEXT,                   -- user messages only; UNIQUE when set (R2: idempotent sends)
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX message_by_conversation ON message(conversation_id, created_at);
CREATE UNIQUE INDEX one_reply_per_client_message_id ON message(client_message_id) WHERE client_message_id IS NOT NULL;