# Web Frontend — the chat page (§ 2.4, ADR-001)

> Status: **In progress** — U14 landed the skeleton; option blocks/approval cards (U26), details + trace panel (U31/U35), memory panel (U34) follow.

## What exists after U14

- **App.tsx**: `useMe()` gate → `<SignIn />` or `<Chat />`.
- **SignIn** (`screens/SignIn.tsx`): sign-in / sign-up with inline field errors rendered from the server's `details` (ApiError.details).
- **Chat** (`screens/Chat.tsx`): conversation list (title + busy marker), new conversation, messages oldest-first with roles, composer — **Send disabled while a reply is pending** (2.3); Enter submits; agent structural parts rendered via a part-renderer placeholder (U26 fills it).

## Rules

- **The only `fetch` lives in `shared/api-client.ts`** (`ApiError` carries `status/code/details`). Enforced by a structural test (`shared/no-direct-fetch.test.ts`).
- All server interaction goes through TanStack Query hooks in `shared/queries.ts` — components are presentational.
- `shared/uuid.ts` — client message ids (R2) without assuming `crypto.randomUUID` in test environments.
- CSRF: every mutating fetch sends `sec-fetch-site: same-origin` + JSON content type; cookies via `credentials: same-origin`.

## QA

RTL component tests (`client/src/screens/*.test.tsx`); the API path is proven through the Vite proxy (`:5173/api`) like the page does. The manual browser click-through comes once at U40 (ADR-006).