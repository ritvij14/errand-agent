-- 006_approval: what the user picked and held, and the approval it waits on (§ 2.5.5)
ALTER TABLE workflow ADD COLUMN selection TEXT; -- JSON: { providerId, slot }
ALTER TABLE workflow ADD COLUMN hold TEXT;      -- JSON: { holdId, expiresAt, quotedPrice }

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  action TEXT NOT NULL CHECK (action IN ('book','cancel','reschedule')),
  provider_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  price INTEGER NOT NULL,
  booking_id TEXT,                          -- reschedule / cancel
  hold_id TEXT,                             -- book; reference only, not part of what is approved
  status TEXT NOT NULL CHECK (status IN ('pending','approved','used','declined','voided')),
  decided_via TEXT CHECK (decided_via IN ('button','typed')),
  void_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  used_at INTEGER
) STRICT;
-- At most one waiting approval per workflow:
CREATE UNIQUE INDEX one_open_approval ON approval(workflow_id)
  WHERE status IN ('pending','approved');
