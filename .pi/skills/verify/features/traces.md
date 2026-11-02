# Traces — panel and export (MH-7, FR-13)

**What it is.** The chat page shows one run's trace side-by-side: timeline lines coloured by type, click-to-expand fields, the latest reply's run auto-loaded, and a "trace" link under every agent reply to switch runs. `npm run trace:export -- <run id>` writes `traces/<run id>.json`.

## Drive it over HTTP

As alice: send "plumber in Indiranagar this week" (note the runId from the reply) → `GET /api/runs/<run id>/trace` (11-ish events, ordered) → `npm run trace:export -- <run id>` → `jq '.events | length' traces/<run id>.json`. Bob's request for the same run → 404.

## Proof

- `traces/<run id>.json` keys are exactly `events,run`; zero `password|cookie|authorization` hits in the file.

## Gotchas

- Traces are stored even when the reply errors — the panel shows `error` and `limit_hit` events too.
- A foreign-run 404 on the client renders the "No trace yet" placeholder (quiet, no error UI).
