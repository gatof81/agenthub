# QA log — Claudia

Known regressions, fragile or flaky areas, coverage gaps, and the verification
approach that works for each part of Agent Hub — so a cold-start QA turn knows
where to look and how to check, instead of re-discovering the risky spots. Read
[the shared rules](./README.md) first. Scope: what has broken before, what is
under-tested, and how to verify a claim (the exact commands/tests). Verify, don't
fix — an implementation concern is handed back to the developer.

## Entry format

```text
## <YYYY-MM-DD> — <area / feature> (Claudia)

**Requirement / behavior under review:** <what it must do> (<doc §/FR citation>)

### Findings
- <regression / gap / fragile spot> — <impact> (<file:line or test name>)

### How to verify
- <exact command(s) / test file or name that covers it>

### Status
- passed | changes_required | <coverage gap left open, and where>
```

---

<!-- Append new entries below this line, newest last. No entries yet. -->
