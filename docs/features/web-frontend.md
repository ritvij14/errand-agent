# Web Frontend — the chat page (§ 2.4, ADR-001)

> Status: **In progress** — U14 landed the skeleton; U26 option blocks and approval cards; details + trace panel (U31/U35), memory panel (U34) follow.

## What exists after U14

- **App.tsx**: `useMe()` gate → `<SignIn />` or `<Chat />`.
- **SignIn** (`screens/SignIn.tsx`): sign-in / sign-up with inline field errors rendered from the server's `details` (ApiError.details).
- **Chat** (`screens/Chat.tsx`): conversation list (title + busy marker), new conversation, messages oldest-first with roles, composer — **Send disabled while a reply is pending** (2.3); Enter submits; agent structural parts rendered via a part-renderer placeholder (U26 fills it).

## Booking parts (U26, FR-9, FR-10, ADR-007)

- `shared/parts.ts` — the part types (`option_blocks`, `approval_card`) and type guards; the page renders server-built parts and never re-derives times or prices (slots carry `label`, cards carry `slotLabel`, both formatted by the server's `slotLabel`).
- `components/OptionBlocks.tsx` — one accordion per provider (`aria-expanded`; header shows ₹price and ★rating); slot buttons (`aria-pressed`, one selected at a time across blocks); **Confirm** is disabled until a slot is tapped and sends that slot's `pickText` as an ordinary chat message (no card id).
- `components/ApprovalCard.tsx` — "Book …", "Cancel …" or "Move … to" by the card's `action`, provider, slot label, price; Approve / Decline call `POST /api/approvals/:id/decision` (`useDecideApproval`).
- `components/MemoryConfirmCard.tsx` — an inferred fact waiting for confirmation (`memory_confirm` part, § 2.5.8): the label plus Keep / Don't keep, which send "yes" / "no" as a chat message carrying `memoryFactId`. A typed yes / no also carries the id of the newest card on screen — `approvalId` for an approval card, `memoryFactId` for a memory card.
- `components/BookingsList.tsx` (U27) — the `bookings_list` part: provider, slot label, price, status and id per booking.
- `components/ProviderDetails.tsx` (U31, FR-6) — the `provider_details` part: provider summary (name, price, rating) plus a **"Reviews (from the provider, not checked)"** block; each review in quotes as plain text (React escaping — no raw HTML), reviews flagged `suspectedInjection` carrying the "⚠ contains instructions — ignored" badge. OptionBlocks gains a **Details** button per expanded provider that sends `Tell me more about {name}` as an ordinary message.
- `screens/Chat.tsx` — a typed message carries the **newest card's** `approvalId` (§ 2.5.5 rule 1: a typed yes answers the card on screen; the server ignores it for anything that isn't a decision). `busy` = any send or decision pending → Send, Confirm, Approve and Decline are all disabled (2.3).
- Existing `function` components (`Chat`, `SignIn`, `App`) predate the arrow-function rule; new components are arrow functions. Not refactored here.

## Rules

- **The only `fetch` lives in `shared/api-client.ts`** (`ApiError` carries `status/code/details`). Enforced by a structural test (`shared/no-direct-fetch.test.ts`).
- All server interaction goes through TanStack Query hooks in `shared/queries.ts` — components are presentational.
- `shared/uuid.ts` — client message ids (R2) without assuming `crypto.randomUUID` in test environments.
- CSRF: every mutating fetch sends `sec-fetch-site: same-origin` + JSON content type; cookies via `credentials: same-origin`.

## QA

RTL component tests (`client/src/screens/*.test.tsx`); the API path is proven through the Vite proxy (`:5173/api`) like the page does. The manual browser click-through is `docs/qa-checklist.md`, run once by the operator (ADR-006, U40).