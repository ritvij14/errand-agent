# errand-agent: design note

One Express process, one SQLite file and a React chat page, all local, over the brief's 8 mocked tools. Full design: `docs/system-design.md`. Claims below are backed by tests or evals (`docs/evals/eval-table.md`, 30/30).

## 1. State model

**Code decides; the model reads and writes text.** On each message the model does two jobs: _read_ the message into a structured update (intent, details, a pick, yes/no) and _write_ the reply the code chose. A state machine (`server/src/agent/workflow.ts`) decides every step and tool call. The model never calls a tool or decides approval. It is a scripted pattern matcher (ADR-002), so tests and evals are offline and repeatable.

A conversation has at most one active **workflow** (a database rule). Booking runs `collecting → searching → choosing → holding → awaiting_approval → executing → verifying → done`. It can also end in `failed` or `abandoned`. State is built in a chain, `facts → candidates → selection → hold → approval`. A correction changes one fact and clears only what was built from it, so known details are never asked again. The hold comes _before_ approval because the exact price exists only once `hold_slot` quotes it. In `executing`/`verifying`, corrections wait for the outcome.

## 2. Approval enforcement

An **approval record** is created by code from the stored selection and hold: action, provider, slot, price (and booking id for cancel/reschedule). The card is drawn from that record, not the reply text. The Approve button and a typed "yes" (which carries the shown card's id) both resolve to it by id. A provider, slot or price change, a correction, a task switch, or a booking changed elsewhere voids it.

Two separate gates stand before any `book` / `cancel` / `reschedule`:

- **Gate 1 (creating the operation):** only an `approved`, unused record whose fields equal the request. In the same transaction the record becomes `used`. A unique `approval_id` on operations makes the database refuse a second use.
- **Gate 2 (the tool gateway, every call and retry):** only a saved `in_flight` operation whose used approval and request match the call's exact arguments. With no authorizer, every write is refused.

So no single bug can act unapproved: a used approval can't start an operation, and an unused one can't reach a tool. Provider text never reaches the read step, approvals or memory. The injection badge is only a label (eval 4).

## 3. Idempotency and recovery

Each approved action becomes an **operation row saved before the tool call**, with key `<operation id>:<n>`. Retries reuse the key, so the provider can't book twice. A re-hold after `hold_expired` gets `:n+1`, and the approval stands only if the new quote equals the approved price. The mock commits a booking and its key's result in one transaction. A timeout is never reported. The code calls `get_booking_status(key)`: `booked` means done, and `not_found` means wait 0.5 s / 1 s, then retry with the same key, up to 3 attempts. A repeated "yes" reports the existing operation (evals 13–14). A partial unique index allows one in-flight operation per booking. At **startup**, and at each run's start, every `in_flight` operation is resolved first via `get_booking_status`/`list_bookings`, as a traced `recovery` run that resumes only while the hold is valid (evals 20a–c). Runs are capped at 6 model calls, 10 tool calls and 60 s, and every ending is recorded with a truthful message (evals 21a–d).

## 4. Memory

Per user, the brief's three keys: area, earliest time, preferred provider (per service). **Stated** facts come only from lasting phrasing ("I live in HSR", "never before 10"). A one-off "plumber in HSR" is not saved, because people book for others. **Inferred** facts come from structured history: the same provider, or the same area, in 2 completed bookings; the same "not before X" in 2 finished bookings. They start `awaiting_confirmation` and are used only after a Keep or "yes" bound to that fact's id, like an approval (I-7). Fills carry the fact id and are re-checked at every run start, so a forget or correction (chat or panel) reaches open workflows (I-6). A forgotten row blocks re-inferring that value. A request that differs from memory wins for that request only, with a one-line note (evals 16–19).

## 5. Observability

One trace per run in SQLite: state transitions, model calls, tool name + args + cleaned result, approvals, operations, memory, limits, errors. Fields are allow-listed per event type, so no secret can be written (I-9 sweeps every eval). `clock_at` is the app's clock: real time in the app, the fixed and advanceable clock in evals; `duration_ms` is real latency; `run_ended.countedMs` is the time the caps count (real + simulated pauses); tokens/cost are `null` ("scripted model"). The chat page shows the trace beside the reply; `npm run trace:export -- <run id>` writes the raw file.

**Annotated excerpt.** Timeout after success: `traces/61943514-4f6e-487c-8e2c-c53af40a62fe.json`, a real dev-app run with the dev-only `DEMO_FORCE=book=timeout_booked` switch.

```
#3  approval_event   approved via typed: book mp-011, Wed 4 Nov 09:00, ₹578     ← the user's yes, bound to the card's id
#5  operation_event  created book, key c09b7e75…:1                              ← saved before any provider call
#6  tool_call        book(hold f9aa347e…, key …:1) → error: timeout   1 ms real (10 s pause simulated)
#7  state            executing → verifying                                    ← a timeout is never reported as either outcome
#8  tool_call        get_booking_status(key …:1) → {status: booked, bec91eb1…}  ← the provider did book
#9  operation_event  succeeded → bec91eb1…                                     ← no second book call
#11 model_call       write "Booked: Deva Pipe Care … Booking id: bec91eb1…"     ← success stated only after verification
#12 run_ended        completed, 2 model / 2 tool calls, countedMs 10008         ← the simulated pause counts toward the 60 s cap
```

## 6. What breaks first at 100×, and what we'd change

At 100× (hundreds chatting at once instead of one), in order:

1. **Process-local state.** The "conversation busy" marker and the sign-in rate limiter are in-memory, so a second process would allow two runs on one conversation and split the limit. _Change:_ a short-lived lock on the conversation row (one conditional update) and a shared limiter; then run several processes.
2. **One SQLite writer.** Every trace event is its own synchronous insert mid-run, beside workflow, approval and operation writes, all behind one write lock, and nothing is deleted. _Change:_ Postgres (the unique indexes carry over as-is); buffer each run's trace into one write at run end, with retention.
3. **The scripted reader's phrasing coverage.** Real users bring a long tail ("Saturday evening" was silently ignored until bug B6). _Change:_ an LLM behind the same `read` interface, its output schema-checked into the same structured update, with evals on recorded output. Approvals, operations and caps stay in code, so a wrong read can only ask, never act.
4. **Startup recovery** resolves every in-flight operation, one at a time, before serving. _Change:_ serve at once and recover per conversation on first touch (already done at every run start).
