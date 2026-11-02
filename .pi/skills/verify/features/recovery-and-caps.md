# Restart recovery and run caps (MH-3, MH-5)

**What it is.** A booking cut off mid-flight is finished by a `recovery` run at server start (and at the start of the conversation's next run). Every run stops at 6 model calls / 10 tool calls / 60 s with a clear message.

## Drive it

- **Recovery:** book on the dev server; set the operation back with `sqlite3 server/data/errand.db "UPDATE operation SET status='in_flight' WHERE …"` and the workflow phase to `verifying`; `npm run verify:down` then `npm run verify:up` → the conversation shows "Your booking went through: …", one `recovery` run `completed`, one booking.
- **Caps:** the eval rows 21a–21d prove each ending (`npm run evals`); read a capped run back with `sqlite3` on an eval db or `GET /api/runs/<id>/trace` (`limit_hit` event).

## Proof

- `SELECT trigger, outcome FROM run ORDER BY started_at DESC LIMIT 3` shows the `recovery` run.
- A capped run's trace ends with `limit_hit` then `run_ended` with outcome `cap_*`.

## Gotchas

- Edit the db only while the servers are **down**, except for single-row `UPDATE`s like the one above (no deletes under a live server).
