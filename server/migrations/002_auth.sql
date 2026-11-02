-- 002_auth: users and auth sessions (§ 2.5.1, ADR-005)
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- Argon2id
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  secret_hash BLOB NOT NULL,                -- SHA-256 of the token secret
  last_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;