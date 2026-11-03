# Traces (MH-7)

> Status: viewing, panel and export live (U35).

## What exists

- `trace_event` table (`migrations/003_trace_events.sql`) — one ordered event list per run; every trace write goes through `TRACE_EVENT_FIELDS` allow-lists in `tracing.ts`, so by construction no password, session token or cookie can be stored (I-9).
- **What a tool call and a model call keep (B19).** `tool_call.result` is the **full** structured result as JSON — never cut (it used to be sliced at 4,000 characters, which could leave broken JSON for a broad search); only review text is capped at 500. The write `model_call` records its `input` — `{ phase, code }`, the decision being worded — alongside the reply text; the read records the user's message.
- `server/src/tracing/trace.routes.ts` — `GET /api/runs/:id/trace`: the run row + its ordered events; only the run's own conversation's user (V-7: 404 otherwise), 401 unauthenticated. Mounted in `app.ts`.
- `server/src/tracing/export.ts` — `exportTrace` (run + events, exactly as stored) and `writeTraceFile`.
- `npm run trace:export -- <run id>` (`trace-export.cli.ts`) — deliverable 5: writes `traces/<run id>.json` from the app database (server/data/errand.db). `traces/` is git-ignored except the committed deliverable file.
- **Latency (U39, MH-7).** The event's `duration_ms` column is **real** elapsed time (the `shared/elapsed.ts` timer): measured around every tool call in the gateway, every model read/write in the conversation service, and the whole run (`run_ended`). It is never the simulated pause — in evals that shows as a `clock_at` jump; in the app `clock_at` is real time and the pause shows only in `countedMs` (B14). In-process mock tools take < 1 ms, so they record `0`. `run_ended.data.countedMs` is the run's time **as the caps count it** (real + simulated pauses and waits, R8), e.g. 10003 for a run with one 10 s timeout. Before U39 no event carried latency (`durationMs: null` everywhere) — found while writing the design note.

## The client panel (FR-13)

- `components/TracePanel.tsx` — a right-hand column in Chat: the run's outcome + model/tool call counts, then one timeline line per event coloured by type (`tool_call book → timeout (0 ms)`, `state searching → choosing`, …; latency in ms). A line expands to its raw fields (JSON); a second click collapses it.
- **Which run:** the latest agent reply's run loads automatically (`useTrace`); every agent reply that has a run shows a small "trace" link that switches the panel to that reply's run (`shownRunId = traceRunId ?? latestRunId`). The new reply's trace is prefetched from the POST response's `runId` at the same time as the conversation reload, instead of waiting for the reload to reveal `latestRunId` (one round trip fewer). A finished run's trace doesn't change (`staleTime: 60 s`, `retry: false` — a 404 for a foreign run shows the quiet placeholder).

## Invariants

- **I-9:** no trace holds a password, auth-session token or cookie — checked by the eval runner and by `trace-routes.test.ts` over stored rows ("demo-password", "set-cookie", the session id and its secret hash absent).

## QA evidence

- `trace-routes.test.ts` (10 tests): shape, ownership, 401, export writes exactly `run` + `events`, secrets sweep.
- API drive + export inspected with jq: `/tmp/verify-U35/drive.txt` — alice's 11-event trace, bob 404, `traces/<run id>.json` with `keys = events,run` and zero secret hits.
