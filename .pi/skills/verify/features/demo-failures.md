# Forced failures — the dev-only demo knob (2.5.4, R12)

**What it is.** `DEMO_FORCE="tool=outcome[,tool=outcome]"` makes the dev server force the **next** call of each named tool once (then draws normally until restart). Off unless set. Evals never read it. Outcomes: `book` → `timeout_booked` | `timeout` | `slot_taken` | `hold_expired`; `hold_slot` → `price_changed` | `slot_unavailable`.

## Drive it over HTTP (timeout after success, deliverable 5)

1. `DEMO_FORCE=book=timeout_booked npm run verify:reset` (fresh db, servers up with the knob armed).
2. As alice: "book a plumber in HSR Layout tomorrow morning" → pick a slot's `pickText` → "yes" with the card's `approvalId`.
3. Reply: "Booked: … Booking id: X." — straight away: the 10 s timeout pause is simulated. It counts toward the run's time cap (`run_ended.countedMs` ≈ 10 000) but never moves the app clock, which is real time (B14).
4. `GET /api/runs/<that run id>/trace` → `tool_call book` `errorCode: timeout`, then `tool_call get_booking_status` result `status: booked`.
5. `npm run trace:export -- <run id>` → `traces/<run id>.json`.

## Proof

- Committed file: `traces/61943514-4f6e-487c-8e2c-c53af40a62fe.json` (12 events, real `durationMs` on model/tool calls and `run_ended`; un-ignored in `.gitignore`).
- One provider booking: `sqlite3 server/data/errand.db "SELECT COUNT(*) FROM mock_booking WHERE user_id='u-demo-alice' AND status='booked'"` rises by one.

## Gotchas

- The knob is one-shot per process: re-arm with `DEMO_FORCE=… npm run verify:reset` (or `verify:down` then `DEMO_FORCE=… npm run verify:up`). A hot reload of `index.ts` re-arms it too.
- `npm run reset` wipes the db; never run it under a live server — `verify:reset` stops the servers first.
