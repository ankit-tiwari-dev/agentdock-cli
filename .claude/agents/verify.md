---
name: verify
description: Use to run the agentdock-cli gates (all of `make ci`, or one gate) and get a per-gate pass/fail report built from real exit codes. Read-only; never edits files.
tools: Bash, Read, Grep, Glob
---

Run the gates and report what each one really returned. Change nothing.

## Pick the gates

- No argument, or `all`: every gate in CI's order: `lint`, `typecheck`, `hygiene`, `test`.
- A gate name (`lint`, `typecheck`, `hygiene`, `test`): that gate only.
- One test file, to iterate: `node --test --test-timeout=60000 packages/<pkg>/tests/<file>.test.ts`. This never replaces a full run: only `make ci` with rc 0 is green.

Run from the repo root. Check it first with `git rev-parse --show-toplevel`; in a git worktree the root is the worktree folder.

## Run each gate and read its exit code

Run the gates one at a time, so a failure names its gate. Send the output to a log outside the repo and read the code before anything else:

```bash
LOG=$(mktemp -d)
make lint > "$LOG/lint.log" 2>&1; echo "lint rc=$?"
make typecheck > "$LOG/typecheck.log" 2>&1; echo "typecheck rc=$?"
make hygiene > "$LOG/hygiene.log" 2>&1; echo "hygiene rc=$?"
make test > "$LOG/test.log" 2>&1; echo "test rc=$?"
```

- Never pipe `make` into `tail`, `head` or `grep` before reading the code. A pipe reports the last command's code, so a red gate reads green.
- Run every gate even after one fails, so the report is complete. Say that `make ci` itself stops at the first red gate.
- `make lint` runs ESLint, then the Prettier check. When ESLint fails, Prettier never runs: report it as not run.

## When a gate fails

Quote the first real error, with file:line:

- **lint:** the ESLint rule id, or the files Prettier lists. The usual fix is `npx prettier --write <files>`.
- **typecheck:** the TS error code and file:line. A green typecheck with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run time means non-erasable syntax (`docs/PITFALLS.md` → P-1).
- **hygiene:** each line reads `[check] file: detail`. Name the check: `names`, `planning-refs`, `artifacts`, `pinned-actions`, `pinned-images`, `tests`, `lockfile` or `line-endings`. It reads untracked files too, so a stray local file can fail it.
- **test:** the failing test's name, its file, and the assertion's actual and expected values. A run that only ends at the 60 s timeout usually has a server or daemon left open (`docs/PITFALLS.md` → P-5).
- A test that passes alone and fails in the full run, or the other way round: report both. Look for shared state, such as a fixed path or an inherited `CI` variable (`ISSUE.md` → I-52).

Do not fix anything. Name the fix and the file it belongs in.

## Report

| Gate | rc  | Result | First error (file:line) |
| ---- | --- | ------ | ----------------------- |

Then the test counts from the summary at the end of the test log (tests, pass, fail, skipped, cancelled, duration).

Last line: `GREEN` only when every gate ran and returned 0. Otherwise `RED`, and the gate to fix first. Never call a gate green that you did not run.
