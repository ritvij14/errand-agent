# errand-agent

> **Deliverable #1 requirement: this README must get the project running and tested in 3 commands or fewer.**
> Fill in as decisions land. Keep the final command count honest and verified.

A locally-run chat agent that books, reschedules and cancels home-service errands against mocked provider tools — and never double-books, never acts without approval, and never gets talked into anything by a provider review.

---

## What It Does

errand-agent is a conversational booking agent for home services (plumbers, electricians, AC servicing). You type requests in natural language — like "Find a plumber for my kitchen tap this week, mornings only, under ₹1,500" — and the agent searches mocked providers, proposes an option, and holds and books a slot only after you explicitly approve the exact provider, slot and price.

The agent's behavior is governed by hard guarantees enforced in code, not in prompts: every mutating action needs a checked approval record held by the code; booking retries and timeouts resolve against an authoritative status check so no booking is ever claimed before verified or duplicated; and provider reviews are treated as untrusted data, so text inside them cannot change what the agent does.

It also remembers your stable preferences across sessions (area, earliest time, preferred technician) and lets you view, correct and forget them. Every run is traced: state transitions, tool calls, latency, tokens and cost.

Everything runs locally with zero API keys — the language model behind the agent is a scripted/recorded mock by default, which also keeps all tests and evals offline and reproducible.

---

## Tech Stack

- **Language:** TypeScript 6.0 (Node.js 24 LTS)
- **API server:** Express 5
- **Frontend:** React 19 + Vite — dev-mode chat page with a side-by-side trace view; browser talks only to Vite, which forwards API calls to Express (one `npm run dev` starts both)
- **Styling & data fetching:** Tailwind CSS 4, TanStack Query 5
- **Database:** SQLite (better-sqlite3 13) — chat history, bookings, approvals, memory, traces
- **LLM:** scripted/recorded mock model by default (see ADR-002 in docs/infra/decisions.md); live LLM optional behind an adapter
- **Tests:** Vitest 5 + a custom offline eval CLI (15+ scripted scenarios, generates the eval table)
- **Lint / format:** ESLint 10 + Prettier 3

---

## Getting Started

```bash
# 1. Install dependencies (both workspaces + tooling)
npm install

# 2. Start both processes in parallel: Express API on :3001, chat page on :5173
npm run dev

# 3. Run tests + evals (server workspace)
npm test
```

Open http://localhost:5173 — the browser talks only to Vite; API calls forward to Express (ADR-001 in `docs/infra/decisions.md`). Total: 3 commands from clean clone to running + tested.

**Requirements:**

- Node.js 24 (LTS) — pinned by `.nvmrc`; run `nvm use` in the repo. Nothing else: no API keys, no services, everything runs locally.

---

## Project Structure

Core modules:

- `src/[module]` — [one line]
- `src/[module]` — [one line]
- `src/[module]` — [one line]

---

## Documentation

- [`AGENTS.md`](AGENTS.md) — Master context file with architecture, conventions, and requirements
- [`docs/problem-statement.md`](docs/problem-statement.md) — The full graded brief: tools, must-haves, deliverables
- [`docs/system-design.md`](docs/system-design.md) — Design note (deliverable #2)
- [`docs/features/`](docs/features/) — Feature-specific documentation
- [`docs/infra/`](docs/infra/) — Schema, API contracts, patterns
