# Testing

> **The testing philosophy, taxonomy, and workflow for any project built on this template.**
> This is the single source of truth for how tests are written, structured, and added over time.
> Per-feature test coverage notes live in `docs/features/[feature].md` → Testing section.
> Last updated: [YYYY-MM-DD]

---

## Index

- [Philosophy](#philosophy)
- [Test Taxonomy](#test-taxonomy)
- [Path Coverage Framework](#path-coverage-framework)
- [Writing Tests — By Type](#writing-tests--by-type)
- [Workflow: Adding Tests for a Feature](#workflow-adding-tests-for-a-feature)
- [Test File Structure & Naming](#test-file-structure--naming)
- [QA Review Step](#qa-review-step)
- [Test Quality Checklist](#test-quality-checklist)

---

## Philosophy

**Tests exist to simulate users, not to satisfy a coverage number.**

A test suite that passes 100% but only checks the happy path is useless in production. Real users:

- Submit forms with missing or malformed fields
- Click buttons twice
- Access resources they shouldn't
- Use the app while the network is slow or an external API is degraded
- Reach edge states the developer never imagined

Every flow in the system has at least three versions worth testing: the user who does everything right, the user who makes a mistake, and the user who is trying to do something they're not allowed to do. All three should be tested.

**Guiding principles:**

1. **Behavior over implementation.** Tests verify what the system _does_, not how it does it. If the internals change and the behavior stays the same, no tests should break.
2. **Real paths over mocked shortcuts.** Mock at the boundary of the system (external APIs, email senders, payment processors). Never mock your own database layer in integration tests — that removes the category of bug that bites hardest in production.
3. **Bad paths are first-class citizens.** For every happy path test, there should be at least one error/failure/rejection test. Edge cases that have caused bugs once are never removed — they live forever as regression tests.
4. **Readable failures.** A failing test should tell you _exactly_ what user scenario broke. Name tests as user stories: `"returns 403 when agent tries to access another agent's contact"`, not `"test permission check"`.

---

## Test Taxonomy

Three layers. Most projects need all three. Don't skip integration tests in favor of pure unit tests — that is where the hardest bugs hide.

| Layer           | What it tests                                              | Speed  | Isolation                       | When to write                                                             |
| --------------- | ---------------------------------------------------------- | ------ | ------------------------------- | ------------------------------------------------------------------------- |
| **Unit**        | Pure logic, transformations, validators, utility functions | Fast   | Fully isolated — no I/O         | When a function has logic that can go wrong independent of infrastructure |
| **Integration** | A feature's full stack from route → service → database     | Medium | Real database, mocked externals | For every API endpoint and every business rule that touches data          |
| **Flow / E2E**  | Multi-step user journeys spanning multiple features        | Slow   | Real or staging environment     | For critical user journeys (signup → onboard → core action → result)      |

**Rule of thumb on ratio:** roughly 30% unit, 60% integration, 10% flow. Resist the urge to invert this — a test suite heavy on unit tests and light on integration tests gives false confidence.

---

## Path Coverage Framework

Before writing any test, map the paths for the flow you are testing. A complete path map for any feature looks like this:

### 1. Happy Path

The user does everything correctly with valid data and the right permissions.

> Example: authenticated user creates a contact with all required fields → 201 response, record appears in database

### 2. Input Validation Failures

The user submits bad data. Each validation rule is its own path.

> Examples:
>
> - Missing required field → 400 with specific field error
> - Field too long → 400
> - Invalid format (bad email, negative number) → 400
> - Correct fields but logically invalid (end date before start date) → 400 or 422

### 3. Authorization Failures

The user does not have permission to perform this action.

> Examples:
>
> - Unauthenticated request → 401
> - Authenticated but wrong role → 403
> - Authenticated with right role but accessing another user's resource → 403 or 404 (depending on whether existence should be revealed)

### 4. State Conflict Paths

The system is in a state that makes the action invalid.

> Examples:
>
> - Creating a resource that already exists → 409
> - Updating a resource that has been deleted → 404
> - Transitioning a state machine in an invalid direction (e.g. closing an already-closed order) → 409 or 422
> - Acting on a resource that belongs to a deleted parent → behavior depends on business rule

### 5. Concurrency / Idempotency

The user submits the same action more than once, or two users act simultaneously.

> Examples:
>
> - Double form submission → second request should be a no-op or clearly rejected
> - Two users editing the same record simultaneously → last-write-wins or conflict error (per business rule)

### 6. External Dependency Failures

A downstream service the feature depends on is unavailable or returns an error.

> Examples:
>
> - Email provider is down when a confirmation email should send → operation still succeeds, email queued or retried
> - Payment gateway times out → appropriate error surfaced, no charge created, retryable
> - Search index write fails → operation succeeds, search index is eventually consistent (or fails atomically per business rule)

### 7. Throttled Network

The user is on a slow, intermittent, or high-latency connection. This path is critical for mobile users and emerging markets and is one of the most commonly skipped test categories.

> What to simulate:
>
> - Requests that take longer than the UI's loading state timeout
> - Requests that time out entirely on the client side — does the UI surface a recoverable error or silently fail?
> - Partial responses — what happens if a response is cut off mid-stream?
> - Retry behavior — if the client retries a timed-out request, does the server handle the duplicate gracefully (idempotency)?
> - Offline → online transitions — does a queued action fire correctly when connectivity is restored?

> How to simulate in tests:
>
> - Introduce artificial latency in your HTTP mock layer (e.g. `setTimeout` wrapping the mock resolver)
> - Test client-side timeout logic by mocking the response to never resolve within the configured threshold
> - For E2E tests, use browser/device throttling APIs (e.g. Chrome DevTools Protocol network conditions, or platform-specific tools)

### 8. Throttled Device Resources

The user is on a low-end device with constrained CPU, memory, or battery. Especially relevant for mobile apps, real-time features, and any UI with heavy computation.

> What to simulate:
>
> - Long lists or large datasets rendered on a slow CPU — does the UI stay interactive or freeze?
> - Memory-intensive operations (image processing, large JSON parsing) — does the app crash or degrade gracefully under memory pressure?
> - Background-to-foreground transitions on a resource-constrained device — does the app recover its state correctly?
> - Operations that compete with other app processes for CPU — does a data-heavy background sync block the UI thread?
> - Battery saver mode behavior — do timers, background tasks, and polling intervals behave correctly when the OS throttles them?

> How to simulate in tests:
>
> - For mobile: use emulators with low-tier device profiles (e.g. 1-2 CPU cores, 512MB RAM); most platforms expose device throttling in emulator settings
> - For web: use browser CPU throttling in DevTools (4x–6x slowdown) combined with performance profiling to catch jank
> - Write performance assertions that fail if an operation exceeds a time budget (e.g. "list renders within 100ms for 500 items")
> - Test graceful degradation explicitly: if a resource limit is hit, the app should show a degraded-but-functional state, not a blank screen or crash

**Minimum bar for any new feature:** paths 1, 2, and 3 must always be tested. Paths 4, 5, and 6 must be tested wherever the business rules document them as requirements. Paths 7 and 8 must be tested for any user-facing flow expected to work on mobile or low-end hardware.

---

## Writing Tests — By Type

### Unit Tests

Use for: validation functions, data transformations, business logic that is pure (input → output with no I/O).

**Structure:**

```
describe('[function or class name]', () => {
  describe('[method or scenario group]', () => {
    it('[does X when Y]', () => {
      // Arrange
      const input = [valid input]

      // Act
      const result = [function under test](input)

      // Assert
      expect(result).toEqual([expected output])
    })
  })
})
```

**What belongs in a unit test:**

- Input sanitization functions
- Price / tax / discount calculation logic
- Status transition validators
- Permission check helpers (the pure logic, not the middleware)
- Data mapping / serialization functions

**What does NOT belong in a unit test:**

- Anything that reads from or writes to a database
- Anything that makes an HTTP call
- Anything that depends on environment state

---

### Integration Tests

Use for: every API endpoint, every database operation, every business rule that involves persisted data.

**Structure:**

```
describe('[Feature] — [Endpoint or operation]', () => {
  beforeEach(async () => {
    await [reset test database or clear relevant collections]
    await [seed required baseline data]
  })

  describe('happy path', () => {
    it('creates [resource] and returns 201 when request is valid', async () => {
      // Arrange
      const payload = [valid input]
      const authToken = [test user token with correct permissions]

      // Act
      const response = await request(app)
        .post('/[endpoint]')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload)

      // Assert
      expect(response.status).toBe(201)
      expect(response.body.[field]).toBe(payload.[field])

      // Verify persistence
      const record = await [repository].findById(response.body.id)
      expect(record).not.toBeNull()
    })
  })

  describe('input validation', () => {
    it.each([
      ['missing required field X', { ...validPayload, x: undefined }, 'X is required'],
      ['invalid email format', { ...validPayload, email: 'not-an-email' }, 'Invalid email'],
      // add one row per validation rule
    ])('%s → returns 400', async (_, payload, expectedMessage) => {
      const response = await request(app)
        .post('/[endpoint]')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload)

      expect(response.status).toBe(400)
      expect(response.body.error).toContain(expectedMessage)
    })
  })

  describe('authorization', () => {
    it('returns 401 when request has no auth token', async () => { ... })
    it('returns 403 when user lacks [required role]', async () => { ... })
    it('returns 403 when user accesses another user\'s resource', async () => { ... })
  })

  describe('state conflicts', () => {
    it('returns 409 when [resource] already exists', async () => { ... })
  })
})
```

**Integration test rules:**

- Use a real test database. Never mock the database layer in integration tests.
- Reset state in `beforeEach`, not `afterEach` — ensures a clean slate even when a test crashes.
- Mock at the external boundary only: email, SMS, payment, third-party APIs.
- Each test must be independent — no test should rely on side effects from another.
- Seed the minimum data needed. Don't share large fixtures across unrelated tests.

---

### Flow / E2E Tests

Use for: the critical end-to-end journeys that represent real value delivery to the user. Not every feature needs an E2E test — only the journeys where partial failure would be catastrophic.

**Identifying which flows warrant E2E tests:**

Ask: "If this flow silently broke and no integration test caught it, how bad would it be?" If the answer is "very bad" (lost revenue, data corruption, users locked out), write an E2E test.

Common candidates:

- User registration and first login
- Core value-delivery action (the thing users pay for)
- Payment / checkout flows
- Any flow that crosses 3+ features and whose failure would not be obvious from individual integration tests

**Structure:**

```
describe('User Journey: [name of journey]', () => {
  it('[user story in plain English]', async () => {
    // Step 1: [action with comment explaining what user is doing]
    const signupResponse = await [signup action]
    expect(signupResponse.status).toBe(201)

    // Step 2: [next action]
    const loginResponse = await [login action]
    const token = loginResponse.body.token

    // Step 3: [core action]
    const actionResponse = await [core action with token]
    expect(actionResponse.status).toBe(200)

    // Step 4: Verify the outcome is real and complete
    const finalState = await [read the expected final state]
    expect(finalState).toMatchObject({ [field]: [expected value] })
  })
})
```

**Flow tests simulate real user sequences.** Each step feeds into the next — the token from login is used in subsequent requests, the resource created in step 3 is verified in step 4. This is what distinguishes a flow test from just another integration test.

---

## Workflow: Adding Tests for a Feature

Follow this workflow every time a new feature or endpoint is built. Do not defer tests to after the feature is "done" — tests written alongside the code catch bugs that would otherwise reach review.

### Step 1 — Map the paths before writing code

Before writing any test, complete this checklist for the feature:

```
[ ] Happy path identified
[ ] All input validation rules listed
[ ] All permission boundaries identified (who can and cannot call this)
[ ] State conflicts identified (what prior states would make this invalid)
[ ] External dependencies identified (what services must succeed for this to work)
```

Write these down as comments in the test file before writing any assertions.

### Step 2 — Write the happy path test first

Get the green path working end-to-end in a test. This confirms the feature is wired up correctly before adding complexity.

### Step 3 — Write input validation tests

Use `it.each` / parameterized tests. One row per validation rule. If you have 5 validation rules, you need at minimum 5 tests in this group.

### Step 4 — Write authorization tests

Every protected endpoint needs at minimum:

- Unauthenticated request → 401
- Authenticated but wrong role → 403
- Authenticated with right role but wrong ownership → 403 or 404

### Step 5 — Write state conflict and edge case tests

Cover path categories 4–8 from the [Path Coverage Framework](#path-coverage-framework) where applicable.

### Step 6 — Update the feature doc

In `docs/features/[feature].md` → Testing section, update:

- What is now covered by unit tests
- What is now covered by integration tests
- What is explicitly not tested and why
- How to run tests for this feature

### Step 7 — Run the QA review

Before marking the task done or opening a PR, invoke the QA review step (see below).

---

## Test File Structure & Naming

```
src/[feature-name]/
├── [feature].service.ts
├── [feature].service.test.ts       ← unit tests for service logic
├── [feature].routes.ts
├── [feature].integration.test.ts   ← integration tests for routes
└── [feature].validators.test.ts    ← unit tests for validators (if complex)

tests/
└── flows/
    └── [journey-name].flow.test.ts ← E2E flow tests
```

**Naming rules:**

- Unit test files: `[file-being-tested].test.ts` — lives next to the file it tests
- Integration test files: `[feature].integration.test.ts` — lives in the feature directory
- Flow test files: `[journey-name].flow.test.ts` — lives in `tests/flows/`
- Test names: plain English user-facing descriptions, not implementation descriptions

**Test name format:** `[subject] [verb] [condition]`

```
✅ "returns 403 when agent accesses another agent's contact"
✅ "creates contact and sends welcome email when signup completes"
✅ "returns 400 with field-specific error when email is malformed"

❌ "test permission check"
❌ "error case"
❌ "validates input"
```

---

## QA Review Step

Before opening a PR for any feature, do a QA review of the changes. The review:

- Reads the changes made
- Identifies user-facing behavior that changed
- Produces a testing checklist of scenarios to verify manually and via tests
- Flags edge cases that may not be covered

**When to do it:**

```
After implementing a feature but before creating the PR
When changes touch authorization or permission logic
When changes affect core business flows (payments, data mutations, auth)
After any database migration
```

**How to do it:**

Review the diff (or a description of the changes made) against the four points above and write out the checklist.

The resulting checklist should be reviewed against your test suite. Any item on the checklist not covered by an automated test either needs a test added or a documented reason why it is covered by manual QA instead.

---

## Test Quality Checklist

Run through this before marking any testing task done.

**Coverage**

- [ ] Happy path has at least one test
- [ ] Every input validation rule has a test
- [ ] Every permission boundary has a test (unauthenticated, wrong role, wrong ownership)
- [ ] State conflicts relevant to this feature are tested
- [ ] External dependency failures are tested where the business rule specifies behavior

**Test quality**

- [ ] No test depends on state left by another test
- [ ] Database is reset in `beforeEach`, not `afterEach`
- [ ] External services are mocked at the boundary (not internal layers)
- [ ] Test names read as user-facing descriptions
- [ ] Each test has a single assertion focus (a test can have multiple expects, but they should all be about one scenario)

**Documentation**

- [ ] Feature doc Testing section updated with what is now covered
- [ ] Any test deliberately omitted has a reason documented

**Regression**

- [ ] Any bug fixed in this session has a test that would have caught it
- [ ] Any edge case discovered during testing is captured as a test, not just fixed

---

<!-- This doc is the authoritative source for testing conventions. -->
<!-- Per-feature coverage notes go in docs/features/[feature].md → Testing section. -->
<!-- Add new patterns to this doc when a recurring test scenario type emerges that is not covered above. -->
