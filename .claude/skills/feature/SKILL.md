---
name: feature
description: Use when adding or changing behaviour in agentdock-cli - a ctrlplane command, a policy rule, a hook, a storage field, a new package. Plan in small steps, get approval, write failing tests first, implement, try it by hand, pass `make ci`, and record any decision in docs/DECISIONS.md.
---

# Building a feature in agentdock-cli

The rules the code must keep are in root `CLAUDE.md`. This skill is the order of work.

## 1. Understand before planning

- Find the package that owns the area in `docs/ARCHITECTURE.md`. Dependencies only point down: `core` depends on nothing, `cli` sits on top.
- Grep `docs/PITFALLS.md`, `docs/DECISIONS.md` and `ISSUE.md` for the files and names you expect to touch. Read the matching entries.
- Read the code you will change, its callers, and how the repo already does the same job. Reuse that helper instead of adding a new one.
- Check the list in [what each kind of change needs](#what-each-kind-of-change-needs).

## 2. Plan, then stop

Write the plan in plain words, as small numbered steps. For each step: the files, the test that proves it, and the `CLAUDE.md` invariant it touches.

Also say:

- whether it adds a `ctrlplane` command that weakens supervision or writes what the next session is told (then it goes in `isOffSwitch`);
- whether it makes a design choice that needs a `docs/DECISIONS.md` entry;
- what is out of scope.

Wait for the developer's yes. After that, run every step without stopping, unless something destructive or outside the plan comes up.

## 3. Tests first

- For each behaviour, write a test in `packages/<pkg>/tests/` that fails now. Run it and see it fail for the right reason.
- When the feature closes a gap that let something wrong through, name the test `regression: ...`.
- Use the patterns in `.claude/docs/rules.md` → Tests: own `mkdtemp` folder, `CTRLPLANE_HOME` inside it, servers stopped in `finally`.

## 4. Implement one step at a time

- After each step, run that package's test file: `node --test --test-timeout=60000 packages/<pkg>/tests/<file>.test.ts`.
- Erasable TypeScript only, relative imports ending in `.ts`, no per-package tsconfig.
- Comments only for a non-obvious reason, in one sentence.
- Post one short line per finished step.

## 5. Try it by hand

Follow the `agentdock-cli` skill: a throwaway project with `CTRLPLANE_HOME` inside the temp folder, then the command, `policies test`, or a hook payload. Show the output and the exit code. Never try it in this repo or a real project.

## 6. Run every gate

```bash
make ci > "$(mktemp -d)/ci.log" 2>&1; echo "make ci rc=$?"
```

Only rc 0 is done. Never pipe `make` into `tail`. On red, use the `verify` agent or read the log, fix, and run again.

## 7. Update the docs

- **A decision** (you chose between real options): append `## D-<n> · <title>` to `docs/DECISIONS.md` with **Decision:**, **Why:** and **Cost:**. `<n>` is the highest `D-` number plus one. Never edit an old entry. To change one, add a new entry that names the one it supersedes.
- **A package, a state path or the hook flow changed:** update `docs/ARCHITECTURE.md`.
- **A user-visible command or option changed:** update `README.md` and the help text in `packages/cli/src/cli.ts`.
- **A trap you hit:** add `P-<n>` to `docs/PITFALLS.md`.
- Docs point at code. No test-run results or "phase done" notes in any doc.

## 8. Report

1. What the feature does now, in plain words.
2. Each changed file, what changed, and what depends on it.
3. The commands you ran and what they proved: the tests that failed first, the manual try, `make ci` rc.
4. What is left, if anything.

## What each kind of change needs

| Change                  | Also needs                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `ctrlplane` command | A `case` in `packages/cli/src/cli.ts`, a handler in `packages/cli/src/commands/`, a line in the help text, a non-zero exit code on error. Decide whether it belongs in `isOffSwitch`.                          |
| New or changed rule     | A rule in `packages/policy-engine/src/default-rules.ts` (or its own file), shell matching on parsed words (`shell.ts`), deny and allow tests in `packages/policy-engine/tests/`. Keep it cheap: hooks load it. |
| Hook change             | Stays under the 1500 ms budget, still works with no daemon, still fails closed in CI. Test with and without a daemon.                                                                                          |
| New field in `audit.db` | A column in `packages/storage/src/db.ts`, plus `upgradeSchema` so an older database gets it on open. Test an old database.                                                                                     |
| Anything stored         | Redacted before it is written.                                                                                                                                                                                 |
| Context pack change     | Only an approved spec, the session's own captures and developer memory (`packages/context/src/pack.ts`). Nothing an agent controls may read as an instruction.                                                 |
| New package             | `packages/<name>/package.json`, a real test in `tests/`, `npm install` to update `package-lock.json`, a row in the `docs/ARCHITECTURE.md` table.                                                               |
