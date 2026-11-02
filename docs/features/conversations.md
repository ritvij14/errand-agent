# Conversations & Runs — the runner, caps, busy marker (§ 2.5.3)

> Status: **In progress** — U12 landed the skeleton (runner, conversations API, traces, model slot); U23 busy refusal, U24 recovery, U25 caps and endings.

## What exists after U12

- **The run lifecycle**: `POST /api/conversations/:id/messages` → mark busy (or `409 CONVERSATION_BUSY`) → run row → trace (`run_started` → `model_call` read → `model_call` write → `run_ended`) → reply saved (user message + agent reply) → busy released (guaranteed by `finally`).
- **Model slot (ADR-002)**: `agent/index.ts` exposes `AgentModel { read(job) → ReadResult; write(job) → string }`, shipped with the scripted model (v0: every message is `kind: "unknown"` → the help reply). `createApp` takes `model` as a dep — tests inject a gated/fake model; evals will inject the scripted one.
- **Idempotent sends (R2)**: every send carries a `clientMessageId`; a resend replays the stored reply and starts no new run (unique index `one_reply_per_client_message_id`).
- **The scaffold echo route (`server/src/chat`) is deleted**; `AGENTS.md` § 3's rename note is resolved.

## Module map

| File | Owns |
| ---- | ---- |
| `conversations/conversations.repo.ts` | conversations, runs, messages tables (only module touching them) |
| `conversations/conversations.service.ts` | run orchestration, busy marker, replay, trace wiring, `runTrace` |
| `conversations/conversations.routes.ts` | the endpoints + `requireUser` + catalogue-code → HTTP status map |
| `agent/index.ts` | `AgentModel` interface + scripted model v0 |

## Invariants worth keeping

- **Busy marker is in-memory** (2.3): one Node process; cleared on every end path via `finally`; a restart clears it (recovery comes in U24).
- **Recovery first** (U24, § 2.5.2 rule 5): every `message` / `approval_decision` run first calls `workflowStore.recover` — a booking a restart cut off is finished and its outcome saved as an agent message *before* the user's message is saved and read. `recoverInFlight()` runs the same check as `recovery`-trigger runs at server start (`src/index.ts`).
- **When `CONVERSATION_BUSY` is actually seen** (U23): a run never waits on real time — the clock is controllable and the scripted model answers at once — so Node finishes one HTTP request's run before it reads the next. Two parallel HTTP requests therefore run one after the other (both 200; the second sees the first's result, e.g. "Already booked"). The refusal fires when a message arrives *during* a run, which in-process callers can do: `booking.flow.test.ts` (`Promise.all` of an Approve click and a "yes") and eval 14 prove it is refused, not queued. It will matter on the real surface once a run can wait on real time (a live model, phase 3).
- **Caps (U25, NFR-1, § 2.5.3)** — `shared/run-budget.ts`, one budget per run: 6 model calls / 10 tool calls / 60 s (`CAPS`, the one definition; evals import it). Checked **before** every model call, tool call and wait (a refused call is never made) and **re-checked after** awaited work returns; model calls are raced against the time left (R8). Time = the elapsed timer **plus this run's simulated pauses and waits** (the mock's timeout pause and the retry waits go through `budget.wait`, cut short at the deadline) — never the calendar clock, so an eval's `advance` can't satisfy or skip a cap. A cap throws `CapHit`; the runner ends the run with outcome `cap_model_calls` / `cap_tool_calls` / `cap_time`, records `limit_hit`, and replies with the limit and what it leaves: mid-booking → "Your booking check didn't finish — message me anything and I'll check and tell you right away." (the operation stays `in_flight`; the next run's recovery resolves it), otherwise "Nothing was booked or changed". `ConversationsDeps.caps` shrinks them in tests.
- **The model slot inside a run** goes through a counted model (`useRun({ model })`): each read/write is counted, raced, and traced as `model_call`. The write job counts even when the code already decided the wording, so a normal message run is 2 model calls. A read of kind `unusable` is read again (`applyUserText`); only an eval can force it (`force model_read=unusable`) with the scripted model, and the model-call cap ends a model that never gives a usable read (eval 21a).
- **Every ending is recorded** with its reply (I-5): `completed`; `retries_exhausted` (3 timeouts, worded from the checked status); `error` (a known conversation-level failure); `cap_*`; `unknown_error` — anything unforeseen: details go only to the trace (`error` event, `internalDetails`), the reply comes from the operation's checked status (R5, `workflowStore.afterUnknownError`): no operation → "Nothing was booked or changed"; provider record absent → operation closed `failed`, "Nothing was booked"; found → reported; unreadable → "I couldn't confirm whether it went through — don't book again yet", operation left for recovery. A `SimulatedCrash` is the one error not handled — it plays the process dying.
- **Message ordering** is `created_at, rowid` — same-millisecond messages stay in insertion order.
- **State before tool calls (NFR-5)**: messages and run rows are written as produced; the skeleton writes user/agent messages at save points.
- The scripted model's reply lists what the agent can do (FR-14 skeleton) — wording tested by "reply non-empty", never pinned exactly.