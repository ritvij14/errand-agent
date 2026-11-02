# API Contracts

> **Complete API reference for errand-agent.** This is the single place the HTTP API is defined; `docs/system-design.md` § 2.5.11 links here.
> This is the contract — it defines what the API promises to the chat page.
> Status: **Draft — part of the Level 1 system design, not built yet.** The scaffold's `POST /api/chat` stub is replaced by these endpoints at build time.
> Last updated: 2026-11-02

---

## Global Conventions

**Base URL:** the browser calls `http://localhost:5173/api/...` (Vite), which forwards to Express on `http://localhost:3001` (ADR-001).
**Auth:** every endpoint needs a signed-in auth session (cookie `session`, `docs/system-design.md` § 2.5.1) unless marked **Public**. Missing / expired → `401 UNAUTHENTICATED`.
**CSRF:** every non-GET request must carry `Sec-Fetch-Site: same-origin` and `Content-Type: application/json` → otherwise `403 CSRF_REJECTED`.
**Ownership:** any id in the path that isn't the signed-in user's → `404 NOT_FOUND` (same answer as "doesn't exist", so other users' ids aren't revealed).
**Content-Type:** `application/json` for all requests and responses.
**Ids:** UUIDs (v4) for every record.
**Times:** ISO 8601 with the IST offset, e.g. `2026-11-07T09:00:00+05:30`. A slot is identified by its start time.
**Money:** whole rupees as integers (`1200` = ₹1,200).

**Success response:**

```json
{ "data": { ... } }
```

**Error response:**

```json
{
  "error": "Human readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": {}
}
```

`details` is optional (e.g. which field failed validation). Error codes come from the error catalogue in `docs/system-design.md` § 2.5.3; conversation-level problems (e.g. `NOT_UNDERSTOOD`) are **not** HTTP errors — the run completes and the agent replies.

---

## Shared Shapes

### Reply

Returned by every endpoint that starts a run.

```json
{
  "runId": "uuid",
  "outcome": "completed | cap_model_calls | cap_tool_calls | cap_time | retries_exhausted | error | unknown_error",
  "message": {
    "id": "uuid",
    "role": "agent",
    "text": "string — the reply wording",
    "parts": [/* zero or more Parts, below */],
    "createdAt": "ISO 8601"
  }
}
```

### Parts

Structured pieces of an agent message. Always built from saved state, never from the model's text (`docs/system-design.md` § 2.5.3 step 7).

| `type`             | Fields                                                                                       | Shown as                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `option_blocks`    | `blocks: [{ number, provider: { id, name, rating, price }, slots: [{ letter, start }] }]`    | Provider blocks numbered 1…n, slots lettered a, b, c… in an accordion (FR-9). Each slot is a button.  |
| `approval_card`    | `approvalId, action, provider: { id, name }, slot, price, bookingId?, status`                | Card with Approve / Decline (FR-10)                                                                   |
| `provider_details` | `provider: { id, name, rating, price, attributes }, reviews: [{ text, suspectedInjection }]` | Details + "Reviews (from the provider, not checked)", with ⚠ badges (`docs/system-design.md` § 2.5.7) |
| `bookings_list`    | `bookings: [{ id, provider: { id, name }, service, slot, status }]`                          | List of the user's bookings (FR-5)                                                                    |
| `memory_list`      | `facts: [{ id, key, service?, value, source, status }]`                                      | Saved preferences with stated / inferred labels (FR-12)                                               |

---

## Endpoints

### Health

#### `GET /api/health` — Public

**Response `200`:** `{ "data": { "status": "ok" } }`

---

### Auth

Feature doc: `docs/system-design.md` § 2.5.1.

#### `POST /api/auth/sign-up` — Public

**Body:** `{ "username": "string — 3–32 chars, a–z 0–9 _", "password": "string — 8–64 printable chars, no leading/trailing spaces" }`
**Response `201`:** `{ "data": { "user": { "id", "username" } } }` + sets the `session` cookie.

| Code               | HTTP | When                                                         |
| ------------------ | ---- | ------------------------------------------------------------ |
| `VALIDATION_ERROR` | 400  | Username or password breaks the rules (`details` says which) |
| `USERNAME_TAKEN`   | 409  | Username exists                                              |
| `RATE_LIMITED`     | 429  | Too many attempts                                            |

#### `POST /api/auth/sign-in` — Public

**Body:** `{ "username", "password" }`
**Response `200`:** `{ "data": { "user": { "id", "username" } } }` + sets the `session` cookie.

| Code               | HTTP | When                                                            |
| ------------------ | ---- | --------------------------------------------------------------- |
| `NO_SUCH_USERNAME` | 401  | Unknown username                                                |
| `WRONG_PASSWORD`   | 401  | Wrong password                                                  |
| `RATE_LIMITED`     | 429  | More than 5 quick attempts for this username, then 1 per minute |

#### `POST /api/auth/sign-out`

**Response `204`.** Deletes the auth session and clears the cookie.

#### `GET /api/auth/me`

**Response `200`:** `{ "data": { "user": { "id", "username" } } }` · `401 UNAUTHENTICATED` if not signed in.

---

### Conversations

#### `GET /api/conversations`

**Response `200`:** `{ "data": [{ "id", "title", "createdAt", "updatedAt", "busy": boolean }] }` — newest first.

#### `POST /api/conversations`

**Body:** `{}` · **Response `201`:** `{ "data": { "id", "title", "createdAt", "updatedAt", "busy": false } }`

#### `GET /api/conversations/:id`

**Response `200`:** `{ "data": { "conversation": {...}, "messages": [ Message ], "busy": boolean } }` — messages oldest first, each with `role` (`user` | `agent`), `text`, `parts`, `runId` (agent messages).

#### `POST /api/conversations/:id/messages`

Starts a run with trigger `message`.
**Body:** `{ "text": "string — 1–2000 chars", "clientMessageId": "uuid", "approvalId": "uuid?" }` — `clientMessageId` is generated by the page for every send (R2). **Idempotent:** resending the same `clientMessageId` returns the stored reply and starts no new run. When the text answers an approval card (a plain yes or a typed decline), the page sends that card's `approvalId` (§ 2.5.5 rule 1); omitted means "the one currently waiting".
**Response `200`:** `{ "data": Reply }`

| Code                | HTTP | When                                               |
| ------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`  | 400  | Empty or too long                                  |
| `CONVERSATION_BUSY` | 409  | A run is already in progress for this conversation |
| `NOT_FOUND`         | 404  | Not this user's conversation                       |

#### `POST /api/conversations/:id/picks`

Starts a run when the user **clicks a slot button** — the exact choice, no reading needed.
**Body:** `{ "providerId": "uuid", "slot": "ISO 8601", "clientMessageId": "uuid" }`
**Response `200`:** `{ "data": Reply }` · errors as for messages. A pick that isn't among the options currently shown → the run replies with `NOTHING_TO_PICK`.

---

### Approvals

Feature doc: `docs/system-design.md` § 2.5.5.

#### `POST /api/approvals/:id/decision`

Starts a run with trigger `approval_decision` (Approve / Decline buttons).
**Body:** `{ "decision": "approve | decline" }`
**Response `200`:** `{ "data": Reply }`. A stale card (voided, expired, used) → the run replies with `APPROVAL_STALE` / `APPROVAL_ALREADY_USED` and current details.

| Code                | HTTP | When                                      |
| ------------------- | ---- | ----------------------------------------- |
| `VALIDATION_ERROR`  | 400  | `decision` not one of the two             |
| `CONVERSATION_BUSY` | 409  | A run is in progress for its conversation |
| `NOT_FOUND`         | 404  | Not this user's approval                  |

---

### Traces

Feature doc: `docs/system-design.md` § 2.5.9.

#### `GET /api/runs/:id/trace`

**Response `200`:** `{ "data": { "run": { "id", "conversationId", "trigger", "startedAt", "endedAt", "outcome", "modelCalls", "toolCalls" }, "events": [{ "seq", "type", "clockAt", "durationMs", ... }] } }` · `404 NOT_FOUND` if not this user's run.

---

### Memory

Feature doc: `docs/system-design.md` § 2.5.8. Panel actions change memory directly; they are not runs.

#### `GET /api/memory`

**Response `200`:** `{ "data": [{ "id", "key", "service", "value", "source", "status", "evidence", "updatedAt" }] }` — `active` and `awaiting_confirmation` facts only.

#### `PUT /api/memory/:id`

Correct a fact. **Body:** `{ "value": ... }` (validated per key: one of the 5 areas, a time `HH:MM`, or a provider id). Result: value replaced, `source = stated`. **Response `200`:** the fact.

#### `POST /api/memory/:id/confirm` · `POST /api/memory/:id/reject`

Confirm or reject an inferred fact waiting for confirmation → `active` / `forgotten`. **Response `200`:** the fact.

#### `DELETE /api/memory/:id`

Forget a fact → `forgotten` (kept as a hidden marker that blocks re-inferring it). **Response `200`:** `{ "data": { "id", "forgotten": true } }`

| Code               | HTTP | When                                       |
| ------------------ | ---- | ------------------------------------------ |
| `VALIDATION_ERROR` | 400  | Value invalid for this key                 |
| `NOT_FOUND`        | 404  | Not this user's fact, or already forgotten |

---

## Rate Limits

| Endpoint group                                     | Limit                                                                        | Why                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /api/auth/sign-in`, `POST /api/auth/sign-up` | per username: 5 quick attempts, then 1 per minute (token bucket, in memory)  | Brute-force protection (`docs/system-design.md` § 2.5.1) |
| Run-starting endpoints                             | one run per conversation at a time; extra requests → `409 CONVERSATION_BUSY` | No overlapping runs (`docs/system-design.md` § 2.3)      |
