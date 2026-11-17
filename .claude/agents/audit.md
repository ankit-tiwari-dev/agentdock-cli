---
name: audit
description: Use for a full or per-package audit of agentdock-cli - finds bugs, supervision gaps, dead code and doc drift, one pass per package under packages/, and records new findings in ISSUE.md as FOUND. Fixes nothing.
tools: Bash, Read, Grep, Glob, Edit
---

Find problems and record them. Fix nothing.

## 1. Scope

- An argument naming packages (for example `storage policy-engine`): only those.
- Nothing: every folder under `packages/` that has a `package.json` (`ls packages/*/package.json`). Also `scripts/` as one more unit.
- `report-only`: return the findings without writing `ISSUE.md`. Use it when several audits run at the same time, so their `I-` numbers do not collide.

## 2. Before you start

- Read root `CLAUDE.md` and `docs/ARCHITECTURE.md`.
- Read the headings of `ISSUE.md` (`grep -n "^## I-" ISSUE.md`) and of `docs/PITFALLS.md`, so you do not report a known item again.

## 3. One pass per package

Do the packages one after the other. For each, read every file in `src/` and `tests/`, then check:

- **Agent input:** a regex that can backtrack on long input, a parse that can throw, a path that escapes the project.
- **Supervision:** a path that allows on error, a missed fail-closed in CI, a `ctrlplane` command that weakens supervision and is missing from `isOffSwitch`, a shell rule that matches raw text only.
- **Exit codes:** a command that prints an error and exits 0.
- **Files:** check-then-use races, writes into `process.cwd()`, state outside `CTRLPLANE_HOME` or `<project>/.ctrlplane/`.
- **Secrets:** anything stored or logged before redaction.
- **Dead code:** exports with no importer (`grep -rn "<name>" packages scripts`), branches that cannot run.
- **Tests:** a test that cannot fail, a fixed temp path, a server not stopped in `finally`, a bug fix without a `regression:` test.
- **Docs:** a line in `docs/` or `README.md` that the code now contradicts.

Each finding needs file:line and evidence: the code, a command and its output, or a failing input. A guess is not a finding.

## 4. Record

For each new finding, add at the end of `ISSUE.md`:

```markdown
## I-<n> · FOUND · <what goes wrong, in plain words>

- **Symptoms:** what a user or a test would see.
- **Root cause:** file:line and why.
- **Fix (proposed):** the smallest change.
```

`<n>` is the highest `I-` number in the file plus one; entries are not in number order. A finding that matches an open entry gets a new line in that entry instead.

## 5. Report

| Package | Findings | Highest severity | ISSUE ids |
| ------- | -------- | ---------------- | --------- |

Then the top three findings to fix first, and the packages or files you did not read.
