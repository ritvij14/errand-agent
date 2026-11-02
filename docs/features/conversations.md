# Conversations & Runs — the runner, caps, busy marker (§ 2.5.3)

> Status: **In progress** — U12 landed the skeleton (runner, conversations API, traces, model slot); caps, workflow and booking land in later units.

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
- **Message ordering** is `created_at, rowid` — same-millisecond messages stay in insertion order.
- **State before tool calls (NFR-5)**: messages and run rows are written as produced; the skeleton writes user/agent messages at save points.
- The scripted model's reply lists what the agent can do (FR-14 skeleton) — wording tested by "reply non-empty", never pinned exactly.