# Developer log — Claudio

Implementation notes, non-obvious gotchas, and conventions discovered while
working the Agent Hub code — the engineering notebook a cold-start developer
would otherwise have to rebuild every turn. Read [the shared rules](./README.md)
first. Scope: how the code actually behaves (not how it should — that is the
spec), the traps that cost time, and the patterns to imitate. Prefer pointing at
an existing helper/module over restating it.

## Entry format

```text
## <YYYY-MM-DD> — <area / module> (Claudio)

**Context:** <what you were doing / the task>

### Gotcha or pattern
- <the non-obvious thing> — <why it bites, or why it's the right pattern> (<file:line>)

### Reuse / avoid
- Use <existing helper/type by exact name> instead of <the reinvention it prevents> (<citation>)

### Status
- <resolved by PR/commit, or still open>
```

---

<!-- Append new entries below this line, newest last. No entries yet. -->
