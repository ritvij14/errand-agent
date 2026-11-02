# Stated memory (MH-6, U32)

**What it is.** "I live in HSR" saves a preference (per user). It fills missing workflow details in any later conversation — "Using your saved area: HSR Layout (say if that's changed)" — and a request that names a different area wins for that request only, with one note. "forget my area" marks it forgotten; the open workflow drops it at its next run (R6) and asks for the area again. "what do you remember about me?" lists what's saved.

## Drive it over HTTP

As alice: conversation 1 "I live in HSR"; conversation 2 "book an electrician" (note, no area asked); "forget my area"; "tomorrow morning" → "electrician — which area?".

## Proof

- `memory_fact` has one `area hsr_layout` row, `forgotten`; the workflow's area fact is gone; the reply asked for the area. A request area the user gave (`source: "user"`) survives any forget.

## Gotchas

- Stated saves are keyed on lasting phrasing — "plumber in HSR" is never saved.
- Correcting by chat ("my area is Koramangala now") also corrects an open workflow's detail.
