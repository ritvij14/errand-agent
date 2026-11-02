# Auth — sign up, sign in, sign out (FR-1)

**What it is.** Local username + password; an http-only session cookie; every mutating request needs `Sec-Fetch-Site: same-origin` + `Content-Type: application/json` (CSRF guard).

## Drive it over HTTP

- `POST /api/auth/sign-in` `{"username":"alice","password":"demo-password-1"}` with `-c cookie` → `{data:{user:{id:"u-demo-alice"}}}`.
- `GET /api/auth/me` with `-b cookie` → the user; without → 401.
- `POST /api/auth/sign-up` new name → 200 + cookie; an existing name → 409 `USERNAME_TAKEN`.
- `POST /api/auth/sign-out` → the cookie no longer works.

## Proof

- Missing `Sec-Fetch-Site` on any POST → 403 `CSRF_REJECTED`.
- Wrong password → 401 `WRONG_PASSWORD`; repeated failures → 429 `RATE_LIMITED` (the limiter is in-memory: restart the servers to clear it).

## Gotchas

- Demo users (alice / bob / charlie, `demo-password-1..3`) are seeded at every start and by `npm run reset`.
