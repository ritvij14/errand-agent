-- 001_mock_world: the provider side (§ 2.5.4). No FKs to user tables — the mock
-- records user ids as plain text; ownership of mock data is enforced by the tool
-- client being bound to the signed-in user, never by these tables.
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

CREATE TABLE mock_hold (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                    -- the calling user (tool client is bound to them)
  provider_id TEXT NOT NULL REFERENCES mock_provider(id),
  slot TEXT NOT NULL,
  quoted_price INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

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