# Architecture Decisions

> **Architectural Decision Records (ADRs) for [PROJECT NAME].**
> When a key architectural decision is made, record it here with full reasoning.
> Referenced from AGENTS.md Section 3. Never contradict a decision here without updating this doc.
> Last updated: 2026-11-02

---

## How to Read This

Each decision is recorded with:

- **What** was decided
- **Why** it was chosen over alternatives
- **Tradeoffs** accepted
- **When to revisit** — the conditions under which this decision should be reconsidered

---

## Decision Log

---

### ADR-001: Chat surface is an HTTP API plus a utilitarian React page — no CLI shell

**Date:** 2026-11-02
**Status:** Active

**Decision:**
The agent runs behind an Express 5 HTTP API with server-side conversation state (a conversation id; renamed from "session" so it isn't confused with a login session — see ADR-005). The user chat surface is a Vite+React page: the browser talks only to the Vite dev server, and Vite forwards `/api/...` requests to Express. One root command (`npm run dev` via `concurrently`) starts both processes in parallel. No CLI REPL.

**Context:**
The brief requires a recorded demo showing the agent's chat and its trace side by side, plus reproducible offline evals. Chat history and booking state must survive process restarts. Operator explicitly wants a frontend they can test locally where the page calls the backend through Vite.

**Options considered:**

- **Option 3 ([chosen]):** Browser → Vite (dev mode) always; Vite forwards `/api` to Express; demo recorded in dev mode
- **Option 1:** Hot-reload dev via Vite proxy + single-port demo with Express serving the built page
- **Option 2:** Express always serves the built page (no Vite dev server)
- **CLI REPL** — rejected

**Reasoning:**
A web page is the natural surface for the demo deliverable — chat and trace can be rendered side by side on screen. Server-side history answers the chat-history question cleanly (one `POST /api/conversations/:id/messages` call carrying just the new message — full contract in `api-contracts.md`), and evals still hit the agent core in-process, so reproducibility is unaffected. The browser-only-talks-to-Vite arrangement gives the operator the exact dev loop they want, and dev mode doubles as the demo environment. The frontend is explicitly utilitarian: per operator decision, it does NOT claim the brief's single nice-to-have slot — proactive follow-up / model routing remain the reserved nice-to-haves.

**Tradeoffs accepted:**

- Demo runs on dev-mode Vite: a mid-recording crash shows Vite's error overlay, and assets load slower on first open
- Two processes run even during the demo
- No extra credit for the frontend — grading criteria only cover the must-haves

**Revisit when:**
If frontend work grows beyond a thin page, or a recorded crash-into-overlay risk materialises — fallback is Option 1's single-port demo build.

---

### ADR-002: Mock-first LLM — the agent runs on a scripted/recorded mock model by default

**Date:** 2026-11-02
**Status:** Active

**Decision:**
The model behind the agent loop is a scripted/recorded mock by default. Evals, tests and the demo never need a live LLM. A live provider can be added later, only behind a model adapter.

**Context:**
MH-8 requires evals to be offline and reproducible, "run against a scripted or recorded model rather than a live LLM", and the brief states an LLM API is optional. No real LLM is needed for grading.

**Options considered:**

- **Option A ([chosen]):** Mock-first, live LLM optional behind an adapter
- **Option B:** Wire OpenAI behind an adapter from day one
- **Option C:** Wire Anthropic behind an adapter from day one

**Reasoning:**
Mock-first keeps the whole system runnable locally with zero API keys, satisfies MH-8's offline requirement by construction, and removes cost and flakiness from every test run. The adapter rule keeps the door open without committing any provider protocol into the core.

**Tradeoffs accepted:**

- Demo realism limited by scripted behaviour rather than true model responses
- Record/replay machinery must be designed early (eval scenarios + traces)

**Revisit when:**
If a live model materially improves the recorded demo, or the agent needs genuinely open-ended turns we cannot script.

**Amendment (2026-11-02) — phased plan, operator decision:**

1. **Phase 1 (required):** a scripted model — our own pattern-matching code (stored words, regex, chrono-node) with predefined responses — is used in the app, the demo, all tests and all evals.
2. **Phase 2 (if time allows):** extra evals that replay a recorded model (LLM answers captured once, replayed offline).
3. **Phase 3 (if time allows):** an optional OpenRouter connection. If an API key + model are set in environment variables, the live LLM is used in the app. Evals always ignore it (MH-8).

Phases 2 and 3 are deferred until the operator says to build them. Submission-readiness comes first. Details: `docs/system-design.md` § 2.4.

---

### ADR-003: SQLite via better-sqlite3 for all persistence, upgrade deferred

**Date:** 2026-11-02
**Status:** Active

**Decision:**
All state — chat history, workflow state, bookings, approval records, memory facts, traces — persists in a single local SQLite database via better-sqlite3 13.

**Context:**
MH-3 explicitly includes "a restart mid-booking", so state must survive process death. Everything runs locally with no services (brief requirement).

**Options considered:**

- **Option A ([chosen]):** SQLite — zero-setup file DB with real transactional persistence
- **Option B:** JSON files — simplest, but RAM/file state-drift risk
- **Option C:** In-memory only

**Reasoning:**
SQLite is a genuine database with none of a server-DB's setup burden, so the restart scenario is tested for real, not simulated. better-sqlite3 is synchronous, which fits the brief's single local user. Operator decision: start with SQLite, upgrade to a stronger DB only if a real need appears.

**Tradeoffs accepted:**

- Single-writer DB — acceptable for one local user
- Upgrade path (e.g. Postgres) deliberately unmade

**Revisit when:**
Concurrency beyond one local user, or a hosting requirement appears.

---

### ADR-004: TypeScript 6.0 over the new TS 7 (Go) compiler

**Date:** 2026-11-02
**Status:** Active — supersedes the stack table's earlier "TypeScript 7" pin

**Decision:**
The project compiles with TypeScript 6.0.3 — the final JavaScript-based line — not the new Go-native TS 7 compiler.

**Context:**
Operator initially chose TS 7 (current major on npm). Scaffolding discovered typescript-eslint (the TS plugin required by the independently chosen ESLint setup) caps its TypeScript peer at <6.1.0, so TS 7 cannot lint with it today.

**Options considered:**

- **Option A ([chosen]):** TS 6.0.3 — full toolchain compatibility
- **Option B:** TS 7 + plain ESLint — loses all TS-aware lint rules
- **Option C:** TS 7 + typescript-eslint 8.72.2 alphas — nightly-alpha dependency, fragile

**Reasoning:**
Both ESLint (with TS rules) and TypeScript were operator choices; only the TS7-vs-TS6 line was resolvable without losing one of them. TS 6 keeps every chosen tool working and stays one release behind the cutting edge rather than on it.

**Tradeoffs accepted:**

- Not on the newest major; the 6.x line is terminal for the JS-based compiler
- Compile-speed benefits of the Go compiler are forgone

**Revisit when:**
typescript-eslint publishes stable support for TS ≥7.

---

### ADR-005: Local username/password auth with hand-written Lucia-style sessions

**Date:** 2026-11-02
**Status:** Active

**Decision:**
Users sign in with a username and password stored in our own SQLite. Login sessions follow the Lucia / Pilcrow guide (https://auth.pilcrowonpaper.com/, reference `auth_session.ts`): random `<id>.<secret>` token, only the SHA-256 of the secret stored, 10-day sliding expiry, HttpOnly + SameSite=Lax cookie, `Sec-Fetch-Site` CSRF check. Passwords hashed with Argon2id via Node 24's built-in `crypto.argon2`. Full design: `docs/system-design.md` § 2.5.1.

**Context:**
Memory must persist across sessions per user, and `list_bookings` takes a `user_id`, so the system must know who is talking. The operator wanted real authentication.

**Options considered:**

- **Option A ([chosen]):** Local username + password, hand-written sessions
- **Option B:** Google sign-in — rejected: the brief says "No real providers, payments or external services"; it also needs internet and an OAuth client ID, breaking offline evals and the 3-command setup
- **Option C:** Seeded users picked from a dropdown, no passwords — simplest, but not real auth

**Reasoning:**
Option A is real authentication that stays fully local. Following the Lucia guide instead of a library keeps it small and auditable, and Node 24's built-in Argon2id means no native password-hashing dependency.

**Tradeoffs accepted:**

- Extra code and tests that the brief does not grade
- No breached-password check (Have I Been Pwned is an outside service)
- Sign-in rate limit lives in memory and resets on restart

**Revisit when:**
The system is deployed beyond one machine (Level 2): HTTPS + `Secure` cookies, shared rate-limit storage, breached-password checks.

---

### ADR-006: Client QA uses Vitest + React Testing Library; the manual browser checklist comes once, at the end

**Date:** 2026-11-02
**Status:** Active

**Decision:**
The `client` workspace gets Vitest + React Testing Library 16 for component tests (rendering from API part shapes, disabled states, inline errors). Each client unit in `docs/plans/build.md` is proven by those tests plus a curl drive of the same endpoints through Vite (`:5173/api`). The operator's manual click-through in a browser is written once as a checklist in the final plan unit (U40), not run per unit.

**Context:**
The build plan needs every unit to be verifiable on its own. Server units are proven by Vitest, eval scenarios and API drives; the client had no test tooling. Operator chose this option on 2026-11-02 and asked to defer their manual checklist until all units are done.

**Options considered:**

- **RTL component tests + deferred manual checklist ([chosen])**
- **Playwright headless e2e** — strongest end-to-end proof and screenshots, but adds a ~150 MB browser download and a second test tool
- **Manual checklist only** — least code, but nothing reruns automatically

**Reasoning:**
One test runner (Vitest) across both workspaces keeps tooling small. The client is a thin page that renders server-built parts, so component tests cover most of its logic; the server's own tests and evals cover the behavior behind it.

**Tradeoffs accepted:**

- No automated proof that the real page works end to end in a browser until the U40 manual pass
- UI regressions between units can only be caught by component tests

**Revisit when:**
A UI bug slips past component tests and is found in the manual pass — then add a Playwright smoke for that journey.

---

<!-- Add new ADRs below as decisions are made -->
