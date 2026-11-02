# Feature: [Feature Name] — Index

> **This feature was promoted from a single doc to a directory because it exceeded ~400 lines.**
> Start here. This index links to all sub-docs for this feature.
> Part of: [PROJECT NAME] — see AGENTS.md for full project context.
> Status: [Stable / WIP / Outdated]
> Last updated: [YYYY-MM-DD]

---

## What This Feature Does

[2-3 sentences. Same as what was in the original single-file doc before promotion.]

---

## Sub-Documents

> Read the sub-doc relevant to what you are working on. You do not need to read all of them for every task.

| Sub-doc                                  | What it covers                        | When to read it                                            |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| [data-model.md](./data-model.md)         | Entity shapes, schema, indexes        | Anytime you touch the database layer                       |
| [api.md](./api.md)                       | Endpoints, request/response shapes    | Anytime you touch routes or add endpoints                  |
| [business-logic.md](./business-logic.md) | Rules, validations, edge cases        | Before writing any service layer code                      |
| [flows.md](./flows.md)                   | Step-by-step traces of key operations | When you need to understand how something works end-to-end |
| [testing.md](./testing.md)               | What is tested and how                | Before adding or modifying tests                           |
| [errors.md](./errors.md)                 | Error codes, messages, HTTP status    | When adding error handling                                 |

---

## Files & Ownership

```
src/[feature-name]/
├── routes.ts
├── service.ts
├── repository.ts
├── types.ts
├── [helpers].ts
└── [feature].test.ts
```

---

## Dependencies

**This feature depends on:**

- `[feature/service]` — [why]
- `[infra layer]` — [why]

**Other features that depend on this:**

- `[feature]` — [what it uses]

**Infra docs relevant to this feature:**

- [link to relevant infra doc]

---

## Known Issues & Tech Debt

- [Issue + task reference]
- [Issue + task reference]
