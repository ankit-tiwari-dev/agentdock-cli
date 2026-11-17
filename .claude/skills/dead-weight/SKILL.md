---
name: dead-weight
description: Use before merging a branch of agentdock-cli, or after removing a command, rule or option. Finds code the branch left unused, exports with no importer, and docs that now contradict the code; proves each with a grep of its call sites; removes them after a yes; then runs `make ci`.
---

# Removing what a branch leaves behind

A branch that removes or replaces something often leaves the old helper, its export, its test and its docs behind. This skill finds them, proves each one is dead, and removes it.

## 1. Read the branch

```bash
git fetch origin
git diff --name-only origin/main...HEAD
git diff origin/main...HEAD
```

With an argument naming a path or package, look only there.

## 2. List candidates

- **Exports with no importer:** each `export` in a changed file, and each export whose last caller the branch removed (look at the `-` lines).
- **Files no longer imported:** a changed or touched `src/` file that no other file imports.
- **Options, flags and variables no longer read:** a `--flag` in `packages/cli/src/cli.ts`, a config key, an environment variable.
- **Tests of removed code:** a test that only exercises what is gone.
- **Docs that contradict the code:** grep `docs/`, `README.md`, `CLAUDE.md`, `.claude/skills/` and `.claude/agents/` for every removed or renamed name, command, path and rule id. The help text in `packages/cli/src/cli.ts` counts too.

## 3. Prove each one

For each candidate, run the grep and keep its output:

```bash
grep -rn "<name>" packages scripts --include=*.ts
```

It is dead only when the only hits are its own definition and its own tests. Before you call it dead, also check the uses a grep for the name misses:

- a command name or hook event chosen from a string (the `switch` in `packages/cli/src/cli.ts`, hook event names);
- a rule id named in a `policies.json` or in a test;
- an export from a package's `src/index.ts` that a custom rules module could import. Ask before removing one.

## 4. Keep what hygiene needs

- `make hygiene` fails when a package has no `tests/*.test.ts` that declares a test. Never remove a package's last test without removing the package.
- Removing a whole package also needs `npm install` (the lockfile check) and its row removed from `docs/ARCHITECTURE.md`.
- `ISSUE.md` is history. A FIXED entry that names removed code stays as it is.
- Old `docs/DECISIONS.md` entries are never edited. When the branch reverses a decision, add a new entry that supersedes it.

## 5. Show the list, then remove

Show a table and wait for a yes. Remove only what the developer asked to remove.

| Candidate | Kind | Proof (grep and hit count) | Action |
| --------- | ---- | -------------------------- | ------ |

Then:

- Remove the approved items. Fix each doc line so it matches the code.
- Run `git diff --stat` and check that each removal landed.
- Run the gates:

```bash
make ci > "$(mktemp -d)/ci.log" 2>&1; echo "make ci rc=$?"
```

Only rc 0 is done. Never pipe `make` into `tail`.

## 6. Report

The table with the final action for each row, the files changed, and `make ci` rc with the test counts.
