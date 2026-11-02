# Database Schema

> **Complete data model for errand-agent.** The single place tables are defined; `docs/system-design.md` § 2.5.12 links here.
> When this file exceeds ~500 lines, split into per-domain files (e.g. `docs/infra/schema/auth.md`) and keep this file as an index.
>
> **TBD — decision pending:** Whether feature docs (`docs/features/`) keep their own copy of entity type definitions or link here instead. Decide before the first feature data model is written.
>
> Status: **Draft — part of the Level 1 system design, not built yet.**
> Last updated: 2026-11-02

---

## Database Overview

**Type:** SQLite, one file, via better-sqlite3 13 (ADR-003). Tables use `STRICT`. Foreign keys on.
**Location:** `server/data/errand.db` (git-ignored). Evals use a fresh temporary file per scenario.
**Ids:** UUID v4 text for every record.
**Times:** record timestamps are `INTEGER` unix milliseconds from the controllable clock. Slots are `TEXT` ISO 8601 start times with the IST offset (`2026-11-07T09:00:00+05:30`) — they identify a slot.
**Money:** `INTEGER` whole rupees.
**Ownership:** each component owns its tables; only it reads or writes them (`docs/system-design.md` § 2.4). Two groups:

- **Our tables** — the agent's own records.
- **`mock_` tables** — the provider's side (the mock provider API). The agent never touches them directly; only through the 8 tools.

**No local copy of bookings** in our tables — the provider side is the only record (`docs/system-design.md` § 2.5.6).

---

## Our Tables

### Auth — owned by Auth (§ 2.5.1)

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- Argon2id encoded string (includes salt + settings)
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,                      -- first half of the token
  user_id TEXT NOT NULL REFERENCES user(id),
  secret_hash BLOB NOT NULL,                -- SHA-256 of the token secret
  last_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
```

### Conversations, messages, runs, traces — owned by the conversation runner and Traces (§ 2.5.3, § 2.5.9)

```sql
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
  run_id TEXT REFERENCES run(id),           -- the run that produced (agent) or received (user) it
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  text TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',         -- JSON: Parts (api-contracts.md)
  client_message_id TEXT,                   -- user messages only; UNIQUE when set (R2: idempotent sends)
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX message_by_conversation ON message(conversation_id, created_at);
CREATE UNIQUE INDEX one_reply_per_client_message_id ON message(client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE trace_event (
  run_id TEXT NOT NULL REFERENCES run(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                       -- event types in § 2.5.9
  clock_at INTEGER NOT NULL,
  duration_ms INTEGER,
  data TEXT NOT NULL,                       -- JSON: allow-listed fields only
  PRIMARY KEY (run_id, seq)
) STRICT;
```

### Workflow — owned by the state machine (§ 2.5.2)

```sql
CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  intent TEXT NOT NULL CHECK (intent IN ('book','reschedule','cancel')),
  phase TEXT NOT NULL,                      -- § 2.5.2 phases
  facts TEXT NOT NULL DEFAULT '{}',         -- JSON: { key: { value, source, updated_at } }
  target_booking_id TEXT,
  candidates TEXT,                          -- JSON: last search results shown
  selection TEXT,                           -- JSON: { provider_id, slot }
  hold TEXT,                                -- JSON: { hold_id, expires_at, quoted_price }
  approval_id TEXT,
  operation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,       -- a save with an old version is rejected
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- At most one active workflow per conversation, enforced by the database:
CREATE UNIQUE INDEX one_active_workflow ON workflow(conversation_id)
  WHERE phase NOT IN ('done','failed','abandoned');
```

### Approvals — owned by Approvals (§ 2.5.5)

```sql
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
```

### Operations — owned by booking operations (§ 2.5.6)

```sql
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
  booking_id TEXT,                          -- extract of request for cancel / reschedule (R3); null for book
  status TEXT NOT NULL CHECK (status IN ('in_flight','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,                              -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX operation_in_flight ON operation(status) WHERE status = 'in_flight';  -- startup recovery
-- R3: at most one in-flight operation per target booking (nulls exempt, so book is unaffected):
CREATE UNIQUE INDEX one_in_flight_operation_per_booking ON operation(booking_id) WHERE status = 'in_flight';
```

### Memory — owned by Memory (§ 2.5.8)

```sql
CREATE TABLE memory_fact (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  key TEXT NOT NULL CHECK (key IN ('area','earliest_time','preferred_provider')),
  service TEXT,                             -- only for preferred_provider
  value TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stated','inferred')),
  status TEXT NOT NULL CHECK (status IN ('active','awaiting_confirmation','forgotten')),
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  forgotten_at INTEGER
) STRICT;
-- One live fact per user + key (+ service):
CREATE UNIQUE INDEX one_live_fact ON memory_fact(user_id, key, IFNULL(service, ''))
  WHERE status IN ('active','awaiting_confirmation');
```

Forgotten rows stay as hidden markers that block re-inferring the same value.

### Migrations bookkeeping

```sql
CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;
```

---

## Provider Side — `mock_` Tables (§ 2.5.4)

Owned by the mock provider API. Free slots are **not stored** — they are calculated from the seed for any date; holds and bookings remove them.

```sql
CREATE TABLE mock_provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  price INTEGER NOT NULL,                   -- the search price
  rating REAL NOT NULL,
  attributes TEXT NOT NULL                  -- JSON
) STRICT;

CREATE TABLE mock_provider_area (
  provider_id TEXT NOT NULL REFERENCES mock_provider(id),
  area TEXT NOT NULL,
  PRIMARY KEY (provider_id, area)
) STRICT;

CREATE TABLE mock_review (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES mock_provider(id),
  text TEXT NOT NULL,
  injection_kind TEXT                       -- fixture label for evals; never returned by the tools
) STRICT;

CREATE TABLE mock_hold (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                    -- the calling user (tool client is bound to them)
  provider_id TEXT NOT NULL REFERENCES mock_provider(id),
  slot TEXT NOT NULL,
  quoted_price INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE mock_booking (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES mock_provider(id),
  service TEXT NOT NULL,
  area TEXT NOT NULL,                       -- the area the booking was made for (R4 reading)
  slot TEXT NOT NULL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked','cancelled')),  -- 'completed' is derived: slot in the past
  cancel_503_served INTEGER NOT NULL DEFAULT 0,  -- first cancel call per booking returns 503
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- The provider can't double-book a slot:
CREATE UNIQUE INDEX one_booking_per_slot ON mock_booking(provider_id, slot) WHERE status = 'booked';

CREATE TABLE mock_idempotency (
  key TEXT PRIMARY KEY,                     -- idempotency key from book / cancel / reschedule
  user_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  final_result TEXT NOT NULL,               -- JSON: booked / slot_taken / hold_expired / cancelled / updated booking
  booking_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE mock_attempt (
  tool TEXT NOT NULL,
  call_key TEXT NOT NULL,                   -- idempotency key, or the call's inputs for other tools
  attempts INTEGER NOT NULL,
  PRIMARY KEY (tool, call_key)
) STRICT;
```

Forced outcomes for evals are queued **in memory** on the mock instance, not stored.

---

## Relationships

```
user 1──N auth_session
user 1──N conversation 1──N message
                       1──N run 1──N trace_event
                       1──N workflow 1──N approval 1──1 operation
user 1──N memory_fact

(provider side)
mock_provider 1──N mock_provider_area
mock_provider 1──N mock_review
mock_provider 1──N mock_hold
mock_provider 1──N mock_booking
```

`operation.idempotency_key` ↔ `mock_idempotency.key` is the only link between our side and the provider side — through tool calls, never a database join.

---

## Delete Policy

No soft-delete column. Nothing is deleted in normal use (`docs/system-design.md` § 2.3); the reset command wipes the database file and recreates the seeded world. Memory "forget" is a status (`forgotten`), not a delete.

---

## Migration History

Numbered SQL files in `server/migrations/`, applied in order on start; applied versions are recorded in `schema_migration`.

| Migration  | Date | What changed                                                                                                               |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| _none yet_ | —    | Planned: `001_auth`, `002_conversations_runs_traces`, `003_workflow_approval_operation`, `004_memory`, `005_mock_provider` |
