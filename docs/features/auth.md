# Auth — login sessions and the HTTP boundary (§ 2.5.1, ADR-005)

> Status: **In progress** — U10 landed sign-up/sign-in/sign-out/me; later units reuse `verifyUser` for ownership.

## What it is

Local username + password auth with hand-written Lucia-style sessions (no library). Passwords hashed with Argon2id via Node 24's `crypto.argon2Sync` (19 MiB, 3 passes, parallelism 1, 16-byte salt; parameters stored with the hash since Node has no verify API; compared with `timingSafeEqual`). Token `<id>.<secret>`; DB stores only the SHA-256 of the secret. 10-day sliding expiry, bumped at most hourly. Cookie `session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 10 d).

Every mutating request needs `Sec-Fetch-Site: same-origin` + `Content-Type: application/json` (checked before body parsing — 403 `CSRF_REJECTED` otherwise). Sign-in rate limit: per username, 5 quick attempts then 1/min (in-memory).

## Modules

- `auth/auth-core.ts` — passwords, sessions, verify, rate bucket, `seedDemoUsers`
- `auth/auth.routes.ts` — the 4 endpoints; `readToken`; validation (username 3–32 `[a-z0-9_]`, password 8–64 printable)
- `auth/index.ts` — the feature's public API: `createAuthRouter`, `COOKIE_NAME`, `verifyUser(db, clock, req)`, `seedDemoUsers`
- `shared/errors.ts` — the HTTP error catalogue + `sendError` ({ error, code, details? }; never raw stack traces)

## Demo users (fix from 2.3 / R4)

`shared/demo-users.ts`: `alice` / `bob` / `charlie`, ids `u-demo-alice`, `u-demo-bob`, `u-demo-charlie`, passwords `demo-password-1..3`. Seeded at server start; the mock world books for the ids.

## Node version gotcha

Node 24 is pinned (`.nvmrc`) and `crypto.argon2Sync` needs ≥ 24. Shells that default to Node 22 fail auth tests with "argon2Sync is not a function" — use the v24 binary (`export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"`) before npm commands in agent sessions.