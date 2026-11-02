---
name: verify
description: Scripted way to launch, health-check, drive and clean up this repo's running app — the QA harness proving units on the real surface. Use before declaring user-visible work done, or when the app behaves oddly.
---

# Verify — drive the real errand-agent app

Architecture being verified: Express API on :3001, Vite dev server on :5173 proxying `/api` (ADR-001). The browser talks to :5173 only; agents drive the API directly on :3001.

## Launch

```bash
npm run dev   # starts Express (tsx watch on :3001) and Vite (:5173) concurrently
```

Run it in the background. Ready means usable, not just started: Express answers, the DB is migrated and seeded (demo users exist, mock world present). Seed/migrate runs on server start per the design.

To stop: kill the processes you started (the concurrently root). Never kill by port scan while another dev server might belong to someone else.

## Doctor (run first, and after anything looks off)

1. `curl -s http://localhost:3001/api/health` — expect 200 JSON (endpoint per `docs/infra/api-contracts.md`).
2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` — expect 200 (page served).
3. Sign in as a seeded demo user and confirm a 200 with a session cookie (Drive step 1). If only step 3 fails, the API is up but auth is broken — report it, do not paper over it.

If the doctor fails, say which step and why; do not drive a half-alive instance.

## Drive

The API is a first-class user surface — integration drives use real HTTP like the page does. Every mutating request must carry the same CSRF headers the browser would:

```
Sec-Fetch-Site: same-origin
Content-Type: application/json
```

1. `POST /api/auth/sign-in` → save the `session` cookie.
2. Use that cookie for all subsequent calls. Every call belongs to that signed-in user.
3. Drive the feature: conversations (`POST /api/conversations`, send message, pick slot), approval decisions, memory, traces — per `docs/infra/api-contracts.md`. Send messages whose meaning and timing matter (e.g. a yes during a pending run, a second tab's stale approval) and check both the HTTP outcome and the follow-up state.
4. Observe state directly, not just the reply body: read back the resource listed in the reply (trace endpoint, memory endpoint), and when checking booking behavior, the provider-side truth is `get_booking_status` / `list_bookings` — never the agent's claim.

UI verification (chat page, accordion, cards) is driven through the browser page at :5173 the same way a user would — check the visible reply, the option blocks, the approval card contents match the approval record, the trace panel. A screenshot or curl of the underlying API is acceptable evidence only if the page code renders directly from that endpoint's documented shape (`docs/infra/api-contracts.md`).

## Check

Automated proof stays separate from this harness:

- `npm test` — Vitest (unit + integration), then the eval runner once it exists; fails on either.
- `npm run evals` — eval suite only.

A unit is done when its tests are green AND its QA is driven here. Tests alone are not verification.

## Evidence

Capture the proof while it exists and keep it after teardown: curl transcripts or key responses into `/tmp/verify-<unit>/`, eval tables into `docs/evals/` (the runner writes this; committed), UI observations noted in the unit's reply. Evidence must survive cleanup.

## Cleanup

Tear down only what this drive started (dev servers, any temp DB you created). Never kill by process name. A restart-based scenario (restart mid-booking) is not failed state to clean — it is a test step; recovery must be allowed to run before teardown.

## Feature map

As features land, add one file per user-facing feature under `.pi/skills/verify/features/` (README index + one file per feature: what it is, how to drive it over HTTP and UI, the observable end state that proves it works, gotchas). The map is the QA checklist for the demo deliverable — keep it honest. If the app grows a feature this map cannot reach, that is drift: fix the map, report the gap; do not weaken a journey to make it pass.