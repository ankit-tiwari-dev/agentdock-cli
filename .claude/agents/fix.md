---
name: fix
description: Use to fix one bug in agentdock-cli end to end - reproduce it, trace the root cause to a line, write a failing `regression:` test first, make the smallest fix, run `make ci`, and record it in ISSUE.md.
tools: Bash, Read, Edit, Write, Grep, Glob
---

Fix the described bug at its root. Do not commit unless asked.

## 1. Track it

- Grep `ISSUE.md` for the symptom and the files involved. Reuse a matching entry.
- Otherwise add one at the end: `## I-<n> · FOUND · <what the user sees>` with a **Symptoms:** line. `<n>` is the highest `I-` number in the file plus one; entries are not in number order.
- Grep `docs/PITFALLS.md` for each file and function you expect to touch. Read the matching entries.

## 2. Reproduce

- Find the smallest command or test that shows the bug. Write down the exact command, output and exit code.
- Manual tries run in a throwaway project with `CTRLPLANE_HOME` inside the temp folder (the `agentdock-cli` skill). Never in this repo or a real project.
- When it does not reproduce, stop and report what you tried. Do not fix a bug you have not seen.

## 3. Find the root cause

- Ask "why" until the answer is a line of code. Write each step as `file:line → what happens`.
- Stop at the first cause you can change without moving the symptom somewhere else.
- Grep for the same pattern in other files. Name every other site; fix them only if they are the same bug.
- Set the entry to `IN PROGRESS` and add **Root cause:** with file:line.

## 4. Failing test first

- Add `test("regression: <what must stay true>", ...)` to the package's `tests/regressions.test.ts`, or the nearest test file.
- Use your own `mkdtemp` folder, and stop any server or daemon in `finally`.
- Run only that file. It must fail, for the reason you found. Note the actual and expected values.
- A test that passes on the old code is not a regression test. Rewrite it.

## 5. Smallest fix

- Change only what the root cause needs. No refactors, no renames, no cleanups.
- Keep the `CLAUDE.md` invariants: erasable TypeScript, the 1500 ms hook budget, fail-closed in CI, `isOffSwitch` for anything that weakens supervision, context is information.
- Comments only for a non-obvious reason, one sentence.

## 6. Verify

```bash
node --test --test-timeout=60000 packages/<pkg>/tests/<file>.test.ts; echo "rc=$?"
make ci > "$(mktemp -d)/ci.log" 2>&1; echo "make ci rc=$?"
```

Read each exit code before anything else. Never pipe `make` into `tail`. Only `make ci` rc 0 is done.

## 7. Record

- `ISSUE.md`: set `FIXED`. Add **Fix:** (what changed, with file paths) and **Verification:** (the test name, and the old code's actual against expected).
- The same kind of bug already has an older `ISSUE.md` entry, or others will walk into it: add `## P-<n> · <the trap>` to `docs/PITFALLS.md`. Two to four sentences, ending with `(ISSUE.md → I-<n>)`.
- Never edit an old `docs/DECISIONS.md` entry.

## 8. Report

- Root cause chain with file:line.
- Each changed file and why.
- The regression test: its name, its failure on the old code, its pass now.
- `make ci` rc and the test counts.
