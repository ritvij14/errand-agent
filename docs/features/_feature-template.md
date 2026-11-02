# Feature: [Feature Name]

> **Module doc for `[feature-name]`.** Read this before working on anything in `src/[feature-name]/`.
> Part of: [PROJECT NAME] — see AGENTS.md for full project context.
> Status: [Stable / WIP / Outdated]
> Last updated: [YYYY-MM-DD]
>
> **Promotion threshold:** When this file exceeds ~400 lines, promote to `docs/features/[feature-name]/` directory. Use `docs/features/_feature-directory-index-template.md` as the template for the promoted `docs/features/[feature-name]/README.md`.

---

## What This Feature Does

[2-3 sentences. What problem does this feature solve? Who uses it? What is the end-to-end user experience?]

---

## Files & Ownership

> Every file in this module and what it owns. Update when files are added or removed.

```
src/[feature-name]/
├── routes.ts          # HTTP route definitions and request validation
├── service.ts         # Business logic — the core of this module
├── repository.ts      # All data access — reads and writes to the database
├── types.ts           # Types, interfaces, enums specific to this feature
├── [helpers].ts       # [Any helper files — describe what they do]
├── service.test.ts       # Unit tests, co-located with the file they test
└── [feature].integration.test.ts  # Integration tests
```

**What lives here vs. elsewhere:**

- Business logic → `service.ts` only. Never in routes or repository.
- Database queries → `repository.ts` only. Never called directly from service without going through repository interface.
- Shared types used by multiple features → `src/shared/types/` not here.
- [Any other ownership rules specific to this module]

---

## Data Model

> The shape of data this feature reads and writes. For full schema, see `docs/infra/schema.md`.
> **TBD — decision pending:** Whether to keep a full type copy here or link to `schema.md` instead. See the TBD note in `docs/infra/schema.md`.

**Primary entity: `[EntityName]`**

```typescript
// or use your project's language equivalent
type [EntityName] = {
  id: string
  [field]: [type]           // [what this field is for]
  [field]: [type]           // [what this field is for]
  [field]: [type]           // [what this field is for]
  createdAt: Date
  updatedAt: Date
}
```

**Related entities this feature reads (but does not own):**

- `[EntityName]` from `[feature]` — [why this feature needs it]
- [Add more as needed]

**Database collection/table:** `[collection_name]`
**Indexes:** [list any indexes on this collection relevant to this feature]

---

## API Endpoints

> All HTTP endpoints this feature exposes. For full API contract details, see `docs/infra/api-contracts.md`.

| Method | Path          | Auth Required | Description    |
| ------ | ------------- | ------------- | -------------- |
| GET    | `/[path]`     | Yes / No      | [what it does] |
| POST   | `/[path]`     | Yes / No      | [what it does] |
| PUT    | `/[path]/:id` | Yes / No      | [what it does] |
| DELETE | `/[path]/:id` | Yes / No      | [what it does] |

**Request/Response shapes for non-obvious endpoints:**

```
POST /[path]
Body: {
  [field]: [type] — [description]
  [field]: [type] — [description]
}
Response: {
  [field]: [type]
}
```

---

## Business Logic

> The rules this feature enforces. This is the most important section — it's what prevents bugs when requirements are misunderstood.

**Core rules:**

- [Rule 1 — e.g. A contact can only belong to one agent at a time]
- [Rule 2 — e.g. Deleting a contact soft-deletes, never hard-deletes]
- [Rule 3 — e.g. Status transitions must follow: pending → active → closed. No skipping states.]
- [Add all business rules]

**Validation rules:**

- [e.g. Email must be valid format and unique across all contacts]
- [e.g. Phone number stripped to digits only before storage]
- [Add validation rules]

**Edge cases that have caused bugs or need special handling:**

- [e.g. If a user submits the form twice rapidly, only one record should be created — idempotency key used]
- [e.g. When X happens, Y must also be updated atomically]
- [Add known edge cases]

---

## Dependencies

**This feature depends on:**

- `[feature/service]` — [why, what it uses from it]
- `[infra layer]` — [e.g. Elasticsearch for search queries]
- `[external service]` — [e.g. SendGrid for sending confirmation emails]

**Other features that depend on this:**

- `[feature]` — [what it uses from this feature]
- [Add dependents]

**Infra docs to read when working here:**

- [e.g. `docs/infra/schema.md` — for full data model context]
- [e.g. `docs/infra/api-contracts.md` — for auth header requirements]
- [Only list what's actually relevant to this feature]

---

## Key Flows

> Step-by-step traces of the most important operations. Read these to understand how the feature actually works end to end.

### [Flow 1 — e.g. Creating a Contact]

1. Request hits `POST /contacts` in `routes.ts`
2. Route validates request body against schema — returns 400 if invalid
3. Calls `ContactService.create(data, userId)`
4. Service checks [business rule] — throws if violated
5. Service calls `ContactRepository.insert(data)`
6. Repository writes to `[collection]` in [database]
7. [Any side effects — e.g. triggers search index update, sends email, etc.]
8. Returns created contact

### [Flow 2 — e.g. Searching Contacts]

1. [Step 1]
2. [Step 2]
3. [Continue]

---

## Error Handling

> How errors are handled in this feature specifically.

| Scenario                 | Error Code             | HTTP Status | Message                                    |
| ------------------------ | ---------------------- | ----------- | ------------------------------------------ |
| [e.g. Contact not found] | `CONTACT_NOT_FOUND`    | 404         | "Contact not found"                        |
| [e.g. Duplicate email]   | `EMAIL_ALREADY_EXISTS` | 409         | "A contact with this email already exists" |
| [e.g. Permission denied] | `UNAUTHORIZED`         | 403         | "You do not have access to this contact"   |
| [Add all error cases]    |                        |             |                                            |

---

## Testing

> What is tested and how. Update when tests are added.

**Unit tests cover:**

- [e.g. All service layer functions — happy path and error cases]
- [e.g. Validation logic in routes]

**Integration tests cover:**

- [e.g. Full CRUD flow against test database]
- [e.g. Permission boundary — agent cannot access another agent's contacts]

**What is NOT tested (and why):**

- [e.g. Repository layer — tested via integration tests, not mocked separately]

**To run tests for this feature:**

```bash
[test command with filter for this module]
```

---

## Known Issues & Tech Debt

> Honest list of what is not perfect. Helps the coding agent avoid making things worse.

- [e.g. Bulk import is not paginated — times out for >500 records. Tracked as task #22.]
- [e.g. Search index update is synchronous — blocks response. Should be async.]
- [e.g. No rate limiting on this endpoint yet.]
