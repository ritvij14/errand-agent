# errand-agent

> **Master context file. Single source of truth for this project. All docs/ files are modules that extend this.**
> `docs/problem-statement.md` is the fixed brief this whole project exists to satisfy.

---

## 1. Project Identity

**Name:** errand-agent
**Purpose:** A chat agent that books, reschedules and cancels home-service errands against mocked provider tools — with code-enforced approval, no double-booking, and injection-safe tool output.
**Type:** Full-Stack Web App (API server + single web chat page, one repo)
**Primary Users:** Local users who sign in with a username and password and chat through the web frontend; the grader, who runs tests and evals from the CLI.
**Stage:** MVP
**Repo:** TBD (local git only; no remote yet)

**Governing brief:** [`docs/problem-statement.md`](docs/problem-statement.md) — the graded assignment. The tool contract (§ Tool environment), the 8 must-haves, the 2 nice-to-haves and the 6 deliverables are fixed there and are never re-interpreted in code. When any section of this file conflicts with the brief, the brief wins.

---

## 2. Tech Stack

> Do not contradict this section anywhere else. If a technology decision changes, update here first.

COMPULSORY TASK - Always be clear on the major release of the tech stack being used, and also always link the documentation to that version in this section. For example, if we are using Tailwind V3, then it should clearly be mentioned as "Tailwind V3" and the documentation link should be to the V3 documentation.

**Language:** TypeScript 6.0 — https://www.typescriptlang.org/docs/ (chosen over TS 7: typescript-eslint, picked with ESLint, supports TS <6.1 today — see ADR log; revisit when typescript-eslint ships 7.x support)
**Runtime / Platform:** Node.js 24 LTS (installed: v24.22.2, pinned by `.nvmrc`) — https://nodejs.org/docs/latest-v24.x/api/
**Framework:**

- API server: Express 5 — https://expressjs.com/
- Frontend: React 19 — https://react.dev/ + Vite 8 — https://vite.dev/guide/ (dev mode; see ADR-001)
- Data fetching (client): TanStack Query 5 — https://tanstack.com/query/latest/docs/frontend/react/overview
- Styling: Tailwind CSS 4 — https://tailwindcss.com/docs
- Date parsing (server): chrono-node 2 — https://github.com/wanasit/chrono (turns "Saturday" / "10 a.m." into dates using our controllable clock's "now" and Asia/Kolkata; our own rules handle ranges and qualifiers — `docs/system-design.md` NFR-7)
- Dev orchestration: `concurrently` — one command starts Express + Vite dev server in parallel; the browser talks only to Vite, and Vite forwards `/api/...` calls to Express
- Lint / format: ESLint (current major 10 — the "ESLint 9" option label predated the 10 release; ESLint 10 is the same flat-config approach the choice intended) + Prettier 3

**Package Manager:** npm 11 (bundled with Node 24: v11.19.1; bump only if a project need appears) — https://docs.npmjs.com/

**Data:**

- Primary store: SQLite via better-sqlite3 13 — https://github.com/WiseLibs/better-sqlite3 (upgrade path decided later only if needed)
- Search: None
- Cache: None
- File storage: None (traces/artifacts storage decided at scaffold)

**Infrastructure:**

- Hosting: None — everything runs locally; this is a brief requirement
- Cloud provider: None
- CI/CD: None (add only if the project demands it)

**Auth:** Local username + password, hand-written Lucia-style auth sessions (no auth library, no outside service) — guide: https://auth.pilcrowonpaper.com/ ; reference: https://github.com/lucia-auth/lucia/blob/main/code/auth_session.ts . Passwords hashed with Argon2id via Node 24's built-in `crypto.argon2`. Full design: `docs/system-design.md` § 2.5.1; decision: ADR-005.

**Queue / Jobs:** None — synchronous, in-process.

**Testing:** Vitest 5 — https://vitest.dev/ (unit / integration / flow layers) + a custom offline eval CLI (a Node script that drives ≥15 scripted scenarios against the agent core and generates the eval table — MH-8, deliverable 3). The eval suite is kept separate from Vitest by design. Client component tests: React Testing Library 16 — https://testing-library.com/docs/react-testing-library/intro/ (on Vitest; added to `client` in plan unit U14 — ADR-006). Manual browser QA is one checklist at the end of the build plan, not per unit.

**Key External Integrations:**

- Provider tool mocks (in-process): implement the fixed tool contract from `docs/problem-statement.md` — `search_providers`, `get_provider`, `list_bookings`, `hold_slot`, `book`, `get_booking_status`, `cancel`, `reschedule`. Seeded randomness / configurable scenarios for reproducibility.
- LLM: **scripted model** (our own pattern-matching code) in the app, tests and all evals (ADR-002, phase 1). Deferred until the user says so: phase 2 recorded-model evals, phase 3 optional OpenRouter in the app only — evals never use a live LLM (`docs/system-design.md` § 2.4).

---

## 3. Architecture Overview

> How this system is structured at a high level. For deep dives, see docs/features/ and docs/infra/.

**Pattern:** Single repo, npm workspaces: `server/` (Express API + agent core + tool mocks) and `client/` (Vite + React chat page). Server is feature-based: routes → service → repository; no business logic in routes.

**Core modules and what each owns:**

> Full component design: `docs/system-design.md` § 2.4 (HLD) and § 2.5 (LLD). Names below match its components.

- `server/auth` — users, passwords, auth sessions, CSRF check (§ 2.5.1)
- `server/conversations` — conversations, messages, the conversation runner: runs, busy check, caps (MH-5, § 2.5.3) _(scaffold folder is still `server/chat`; renamed at build)_
- `server/agent` — state machine (MH-1, § 2.5.2) and the model slot / scripted model (§ 2.4)
- `server/tools` — tool gateway + mock provider API, the brief's 8 tools (§ 2.5.4)
- `server/booking` — booking operations: idempotency, retries, restart recovery (MH-3, § 2.5.6)
- `server/approval` — approval records checked before any book / cancel / reschedule (MH-2, § 2.5.5)
- `server/memory` — cross-session preferences, stated vs inferred (MH-6, § 2.5.8)
- `server/tracing` — one trace per run, export (MH-7, § 2.5.9)
- `server/evals` — eval runner + 23 scenarios + eval table (MH-8, § 2.5.10)
- `server/shared` — clock (IST), seeded random, database + migrations, error catalogue
- `client/src` — sign-in, chat with option blocks / approval cards, trace panel, memory panel
- `client/src/shared` — client utilities and types

**Data flow (happy path):**

Full 9-step flow: `docs/system-design.md` § 2.4. In short:

1. The chat page sends the message for a conversation (through Vite); the API checks the auth session, CSRF headers and ownership.
2. The conversation runner marks the conversation busy (or refuses with `CONVERSATION_BUSY`), starts a run and its trace, and finishes any in-flight booking first.
3. The scripted model reads the message; the state machine applies it and advances, calling tools only through the tool gateway; book / cancel / reschedule need a matching approval and are saved with an idempotency key before the call.
4. The model writes the reply; structured parts come from state; everything is saved; the page shows the reply and loads the run's trace.

**Key architectural decisions:**

> For full reasoning on each decision, see `docs/infra/decisions.md`

- HTTP API + React page over any CLI shell; browser talks only to Vite (ADR-001)
- Mock-first LLM, live model optional behind an adapter (ADR-002)
- SQLite for all persistence — chat, bookings, approvals, memory, traces (ADR-003)

**System design:** two levels in two docs. **Code follows Level 1 (assignment system) only** — [`docs/system-design.md`](docs/system-design.md). Level 2 (production system) — [`docs/system-design-production.md`](docs/system-design-production.md) — is TBD and not discussed until Level 1 is fully built; it is estimates, never built here — do not implement anything from it unless the user explicitly asks. The graded 2-page note (deliverable 2) will be `docs/design-note.md`, condensed from this doc after the build.

## 4. Conventions

> The coding agent must follow these at all times. These are non-negotiable.

### Naming

- Files: kebab-case (e.g. `tool-gateway.ts`). Types/classes: PascalCase. Functions/variables: camelCase. Constants: UPPER_SNAKE_CASE.
- Database tables/columns: snake_case. Environment variables: SCREAMING_SNAKE_CASE.

### Code Style

- Write as little code as possible to accomplish the task.
- Only do things you are more than 90% sure about. If unsure, ask the user a series of multiple-choice questions before writing any code.
- **Autonomy exception:** when executing an approved plan (`docs/plans/`), reversible execution decisions do not stop for MCQs — decide, act, and report the decision with its reasoning. MCQs remain for genuine product/preference calls no design section settles, and for anything irreversible.
- No over-complication. Prefer simple, obvious solutions over clever abstractions. If a simpler approach exists, take it.
- **DRY:** no duplicated logic across server, client, or tests — extract to a shared helper or a `server/shared` module instead. Tests may repeat setup; production code may not repeat rules.
- **KISS:** the simplest thing that satisfies the current requirement wins. Cleverness is a defect, not a feature. When two designs both work, pick the one easier to explain and delete.
- **YAGNI:** build only what a requirement (the brief, a feature doc, or an explicit user request) demands. No speculative features, no flexibility or configurability hooks, no abstractions for single-use code. If a need appears later, add it then.
- All functions must be arrow functions — no `function` keyword declarations.
- One component per file (client). A second component may share the file only if it is ≤20 LOC and tightly coupled to the primary component. Components live in `client/src`.
- **JSDoc for non-obvious reasoning:** If an implementation decision has a non-obvious "why" — a workaround for a specific bug, a subtle invariant, a constraint not visible from the call site — document it with a `@remarks` JSDoc tag or a short inline comment on the function. The "what" is in the code; the "why" belongs here. Do not write JSDoc for obvious implementations.
- **Living rule:** when a new global pattern or constraint is established that applies across all features (not just one), add it to these Conventions immediately — do not wait until session end.

### Code Structure

- One module per feature. Server: routes → service → repository. No business logic in routes.
- No direct database calls outside the repository layer.
- All async functions must handle errors explicitly — no unhandled promise rejections.
- **Client data fetching goes through the API client module + TanStack Query hooks** — components never call `fetch` directly.
- Input is validated at the API boundary; the client mirrors validation rules for inline field errors.

### useEffect Policy

> Client only. See also: [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)

Before writing a `useEffect`, check which category it falls into:

1. **Derived state** — Use `useMemo`, a plain `const`, or CSS. Never an effect.
2. **Syncing React to an external system** (pushing state to a server call, store, or manager) — Use ref callbacks or event handlers. Never an effect.
3. **"Do X when Y changes"** — Trigger from the event that _causes_ the change, not from observing the change.
4. **Subscribing to external event sources** (resize, WebSocket, beforeunload) — Legitimate, but prefer `useSyncExternalStore` or a custom hook. If a `useEffect` is truly needed, it must only exist at the React/browser boundary.

**Self-review checklist:**

- Can this be a ref callback instead?
- Can this be triggered by the user action that caused the state change?
- Am I watching state just to call another action? (anti-pattern)
- Does this have proper cleanup for every resource it acquires?

**Code review rule:** If you encounter a `useEffect` while reading or reviewing code, flag it with which category (1–4) it falls into and whether it should be refactored.

### Module Boundaries

- Never import from another feature's internal files. Cross-feature access goes through that feature's public API (index.ts / barrel file). If no public API exists, create one before importing.
- See `docs/infra/patterns.md` → Cross-Feature Access for the implementation pattern.

### Critical Paths — Confirm Before Modifying

> Files listed here are load-bearing. Do not refactor, rename, or change their interfaces without explicit user confirmation.

- `.pi/extensions/project-hooks.ts` — automatically starts documentation wrap-up before Pi finishes after file edits; changing its lifecycle or continuation guard can skip review or create an endless loop.

- **Living rule:** When a file or path is identified as load-bearing, add it here immediately with a one-line description of why it's critical.

### File Navigation

- For files exceeding ~500 lines, add a navigation comment block at the top of the file listing key sections with line ranges. Keep it updated when the file changes significantly.
- Format: `// === NAVIGATION === // L1-50: Exports and types // L120-200: Core processing // L450-500: Error handling`
- **Coding agent: when reading a file >500 lines, read only the first 50 lines first to check for a `NAVIGATION` block. Use it to read only the relevant section instead of the full file.**

### Error Handling

- Errors return `{ error: string, code?: string }` with the proper HTTP status — never raw stack traces to the client. Codes come from the shared error catalogue (`server/shared`).
- Validation errors return field-level `details` the client can render inline.
- Express 5 catches async handler rejections natively — unlike Express 4, routes do not need an async-handler wrapper.
- **Living rule:** when a project-wide error handling pattern is established, add it here immediately.

### Testing

- Full testing philosophy, taxonomy, and workflow: see `docs/infra/testing.md` — read it before writing any tests.
- **TDD is mandatory:** for every task, write the tests first (red), then implement until green. Bug fixes always start with a failing regression test that reproduces the bug. The only exceptions: docs, config, and pure styling tweaks with no behavior change. A healthy amount of tests per unit — happy path, bad input, authorization at minimum. Keep DRY, YAGNI and KISS in mind while writing code and tests.
- **Test behavior, not implementation:** every test asserts what a user or caller can observe (return values, errors, state readable back, effects on other tables or tools) — never internal call order or private helpers. Check: breaking the behavior must fail the test; refactoring the internals must keep it passing. Rewrite or delete tests that only pin implementation.
- Three layers required: unit (pure logic), integration (routes → service → database), flow (multi-step user journeys).
- Every endpoint needs: happy path, input validation, and authorization tests at minimum.
- Mock only at the external boundary (email, payment, third-party APIs). Never mock your own database in integration tests.
- Test names read as user-facing descriptions: `"returns 403 when agent accesses another agent's contact"`.
- Before opening a PR, do the QA review in `docs/infra/testing.md` → QA Review Step and reconcile its checklist against the test suite.
- Runner: Vitest 5 — `npm test` from the repo root; `npm run test:watch` for watch mode.

### Git

- Commit format: conventional commits — `feat:`, `fix:`, `chore:`, `docs:`.
- Work directly on `main` (solo project, local git only; no remote yet).
- Never commit `.env` — check `git status` before every push (once a remote exists).

### Other

- [Any other conventions critical to this project]

---

## 5. Environment & Configuration

**Environment files:**

- None committed. `.env` (never committed) is optional — the scaffold runs without it; add `.env.example` when a real variable appears.

**Required environment variables:**

None required to run (offline/local brief). The only known one:

```
PORT=3001              # Express port; Vite proxies /api here. Optional — this is the default
```

**Key configuration files:**

- `.nvmrc` — pins Node 24; run `nvm use` in the repo
- `tsconfig.base.json` — shared strict compiler options; both workspaces extend it
- `server/tsconfig.json` — Node target (nodenext); `server/tsconfig.build.json` — emit config for `npm run build -w server`
- `client/tsconfig.json` — bundler resolution for Vite/React
- `client/vite.config.ts` — React + Tailwind 4 plugins and the `/api` → `http://localhost:3001` dev proxy
- `eslint.config.js` + `.prettierrc.json` — ESLint 10 (typescript-eslint recommended) + Prettier 3

---

## 6. Development Setup

> How to get this running from scratch. These are the README's ≤3-command deliverable commands — keep them in sync.

```bash
# 1. Install dependencies (workspaces + all tooling)
npm install

# 2. Start both processes in parallel (Express :3001 + Vite :5173)
#    Browser talks only to http://localhost:5173 — Vite forwards /api to Express (ADR-001)
npm run dev

# 3. Run the test suite (server workspace, Vitest)
npm test
```

**Key scripts (all run from the repo root unless noted):**

- `npm run dev` — starts Express (tsx watch) and the Vite dev server concurrently
- `npm test` — server workspace test suite (Vitest); `npm run test:watch` for watch mode
- `npm run lint` / `npm run format` — ESLint / Prettier across the repo
- `npm run build` — compiles the server (`tsc`, emits `server/dist`) and builds the client (`vite build`)
- `npm run typecheck -w server` / same in `client/` — TypeScript-only sanity check

Eval CLI (MH-8, deliverable 3) gets its own script as `server/evals/` takes shape.

---

## 7. Feature Documentation Index

> Each feature has its own doc in docs/features/. Read the relevant doc before working on a feature.
> When a feature doc exceeds ~400 lines, it is promoted to a directory (docs/features/[feature]/).

> When this index exceeds 50+ features, group rows by domain (e.g. Auth & Identity, Contacts, Billing).
> All features below are planned against the must-haves in `docs/problem-statement.md` (MH-1…MH-8). Status stays Planned until real code ships; the doc file is created the moment work on that feature starts.

| Feature              | Doc                                 | From the brief                        | Status  |
| -------------------- | ----------------------------------- | ------------------------------------- | ------- |
| Auth                 | docs/features/auth.md               | Supports MH-6 (per-user memory), FR-1 | Planned |
| Conversations & runs | docs/features/conversations.md      | MH-5, MH-1 workflow state             | Planned |
| Agent core           | docs/features/agent-core.md         | MH-1, MH-5                            | Planned |
| Provider tool mocks  | docs/features/tool-mocks.md         | Fixed tool contract                   | Planned |
| Booking lifecycle    | docs/features/booking-lifecycle.md  | MH-3                                  | Planned |
| Approval gate        | docs/features/approval-gate.md      | MH-2                                  | Planned |
| Memory & preferences | docs/features/memory-preferences.md | MH-6                                  | Planned |
| Traces               | docs/features/traces.md             | MH-7                                  | Planned |
| Eval suite           | docs/features/eval-suite.md         | MH-8, deliverable 3                   | Planned |
| Web frontend         | docs/features/web-frontend.md       | Deliverable 6 demo                    | Planned |

---

## 8. Infrastructure Documentation Index

> Cross-cutting infrastructure docs. Referenced by feature docs when needed.

| Topic                   | Doc                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Architecture decisions  | [docs/infra/decisions.md](docs/infra/decisions.md)                                                             |
| Database schema         | [docs/infra/schema.md](docs/infra/schema.md)                                                                   |
| API contracts           | [docs/infra/api-contracts.md](docs/infra/api-contracts.md)                                                     |
| Deployment              | [docs/infra/deployment.md](docs/infra/deployment.md)                                                           |
| Patterns                | [docs/infra/patterns.md](docs/infra/patterns.md)                                                               |
| Testing                 | [docs/infra/testing.md](docs/infra/testing.md)                                                                 |
| System design (Level 1) | [docs/system-design.md](docs/system-design.md) — binding; the code follows it                                  |
| System design (Level 2) | [docs/system-design-production.md](docs/system-design-production.md) — TBD until Level 1 is built; never built |
| [Add more as needed]    |                                                                                                                |

---

## 9. Working With The Coding Agent

> Instructions the coding agent must follow in every session.

**At the start of every session:**

1. Read this file fully
2. Read the relevant feature doc from `docs/features/` for the current task
3. Read relevant infra docs only if the task touches that infra layer

**Context Loading Rules**

NEVER load all feature docs at once. Load ONLY:

1. This file (AGENTS.md) — always
2. The ONE feature doc relevant to the current task — always
3. Infra docs ONLY if the task explicitly touches that layer

For tasks that span multiple features, load the PRIMARY feature doc (the one being modified most) fully. For secondary features, load only their Data Model and Dependencies sections.

**How to find the right feature doc for a task:**

- Feature doc filenames match the feature area in kebab-case — e.g. "Contact Management" → `docs/features/contact-management.md`
- If a feature has been promoted to a directory, the index is at `docs/features/[feature-name]/README.md`
- Cross-reference Section 7 (Feature Documentation Index) if the mapping is unclear

If unsure which feature doc to load, ask before loading anything.

**Before starting any task:**

- If the task is ambiguous, read the feature doc before asking for clarification

**New Chat Session Rule:**
Before exploring code or doing any work in a fresh chat session, read this file and the key feature documentation first. Do NOT use explore tools immediately — use the documentation to understand the codebase first.

**Documentation Discrepancy = Urgent:**
If you discover any documentation that contradicts actual code behavior, STOP immediately and report to user. This is high-priority — fix the documentation before anything else. Do not continue working on any other task until resolved.

**During a session:**

- If you discover something that changes how a future task should be implemented, stop and update the relevant feature doc and this AGENTS.md BEFORE continuing. Do not defer this. Stale documentation compounds.

**Failure Recovery (5-Retry Limit):**
If any tool, command, MCP tool, skill, or sub-agent fails 5 times consecutively, STOP immediately:

1. Delete `.pi/session-changed` to cancel pending stop hooks
2. Do NOT invoke /wrap-up
3. Report to user: "Hit 5-retry limit on [operation]. Need your help to proceed. Note: I've cleared `.pi/session-changed` — once resolved, remind me to recreate it for documentation review at session end."
4. Wait for user input — do not attempt anything else.

**Before finishing after file edits:**

- **Wrap-up is automatic, not a user reminder.** `.pi/extensions/project-hooks.ts` marks `edit` / `write` tool results in `.pi/session-changed`. On `agent_before_settle`, it injects `.pi/prompts/wrap-up.md` and requests another model turn, including in headless mode. `/wrap-up` remains available manually.
- One automatic wrap-up attempt is allowed per user request. Its own documentation edits do not recursively start another attempt. If cleanup is incomplete or the prompt cannot load, retain the flag and report the failure; never claim review completed. Aborted or errored runs do not automatically restart model work.
- Review feature or infrastructure docs only where relevant; documentation-only work does not require unrelated feature-doc updates. Clear `.pi/session-changed` only after review and all edits are complete. Reload Pi with `/reload` after changing the extension.
