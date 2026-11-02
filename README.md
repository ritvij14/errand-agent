# errand-agent

A locally-run chat agent that books, reschedules and cancels home-service errands against mocked provider tools. It never double-books, never acts without your approval, and never gets talked into anything by a provider review.

## Run it (3 commands)

Requires **Node.js 24** (pinned by `.nvmrc`: run `nvm use` first). No API keys, no outside services.

```bash
npm install   # 1. both workspaces + tooling
npm test      # 2. server tests, then the 30 offline evals (writes docs/evals/eval-table.md), then client tests
npm run dev   # 3. Express API on :3001 + chat page on http://localhost:5173
```

Open http://localhost:5173 and sign in as a demo user:

| Username  | Password          |
| --------- | ----------------- |
| `alice`   | `demo-password-1` |
| `bob`     | `demo-password-2` |
| `charlie` | `demo-password-3` |

Alice already has seeded bookings, so she's the best user for cancel and reschedule.

## Things to try in the chat

- `book a plumber in HSR Layout tomorrow morning` → tap a slot → Confirm → Approve
- `show my bookings`, `cancel my AC servicing`, `reschedule my AC servicing to Saturday`
- `book a plumber in Indiranagar this week`, then the **Details** link on Sri Sai Plumbing Works. One of its reviews is a prompt-injection attempt. It is shown as untrusted text and never obeyed.
- `I live in Koramangala` (saved to memory; view, correct or forget it in the memory panel)
- Every agent reply has a **trace** link. The right-hand panel shows that run's state transitions and tool calls.

## Other commands

| Command                                        | What it does                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run evals`                                | The eval suite on its own (≥15 scenarios, all 8 must-cover categories)        |
| `npm run reset`                                | Wipe and reseed the database (stop `npm run dev` first)                       |
| `npm run trace:export -- <run id>`             | Write a run's raw trace to `traces/<run id>.json`                             |
| `DEMO_FORCE="book=timeout_booked" npm run dev` | Dev/demo only: force the next `book` call to time out after succeeding (once) |
| `npm run lint` / `npm run build`               | ESLint / compile server + build client                                        |

## How it works (short)

- **State machine in code** (`server/src/agent`). A scripted model only reads messages and writes replies. Code decides every step and every tool call.
- **Approval gate** (`server/src/booking`, `server/src/approval`). `book`, `cancel` and `reschedule` run only against a stored, matching, single-use approval. The approval card shows what was stored.
- **Idempotency and recovery.** Each booking operation is saved with its idempotency key before the call. Timeouts are resolved by `get_booking_status`. A restart finishes in-flight bookings first.
- **Untrusted tool output.** Reviews are cut to length, labelled untrusted, and flagged when they look like injection. They never reach a decision.
- **Memory** (`server/src/memory`). Stated preferences are saved. Inferred ones are used only after you confirm them.
- **Traces** (`server/src/tracing`). One trace per run, with caps of 6 model calls, 10 tool calls and 60 s.

## Deliverables

| #   | Deliverable                      | Where                                                                                                  |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Code + this README               | here                                                                                                   |
| 2   | Design note                      | [`docs/design-note.md`](docs/design-note.md)                                                           |
| 3   | Eval table                       | [`docs/evals/eval-table.md`](docs/evals/eval-table.md)                                                 |
| 4   | Three bugs with regression tests | [`docs/bugs.md`](docs/bugs.md)                                                                         |
| 5   | Timeout-after-success trace      | [`traces/5993634e-0780-4a50-9882-c56114f26e3d.json`](traces/5993634e-0780-4a50-9882-c56114f26e3d.json) |
| 6   | Demo recording                   | see [`docs/submission-checklist.md`](docs/submission-checklist.md)                                     |

## Documentation

- [`docs/problem-statement.md`](docs/problem-statement.md): the brief
- [`docs/system-design.md`](docs/system-design.md): full design (the code follows it)
- [`AGENTS.md`](AGENTS.md): architecture, conventions, stack versions
- [`docs/features/`](docs/features/) and [`docs/infra/`](docs/infra/): per-feature and cross-cutting docs
