# AgentDock CLI: rules for working in this repo

The code invariants that are easy to break. The how and why live in `docs/` (index: `docs/README.md`).

## Run everything through make

- Read `CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass. `make constraints` runs its checks; the hooks in `.claude/settings.json` run them after each edit and at task end.
- `make ci` runs every gate CI runs, in the same order. Run it before you call work done.
- `make lint`, `make typecheck`, `make hygiene`, `make test`: the single gates. Never report a gate green from piped output; read its exit code.
- `make hygiene` (`scripts/hygiene.ts`) fails on tracked build output, CRLF in the index, unpinned workflow actions, lockfile drift, a package without tests, and names or planning references that must not appear in the repo.
- Every `uses:` in `.github/workflows/` is pinned to a full commit SHA, with the version in a trailing comment.
- A security-scan exception goes in `osv-scanner.toml` or `.gitleaks.toml` with a reason, and an OSV exception also gets an expiry date (`docs/DECISIONS.md` → D-9).

## Code invariants

- Node runs `.ts` files directly by stripping the types, so only erasable TypeScript is allowed: no constructor parameter properties, no `enum`, no `namespace`, no `import x = require()`. Import sibling files with an explicit `.ts` ending.
- One `tsconfig.json` at the root covers every package. Never add a per-package tsconfig (see `docs/PITFALLS.md` → P-3).
- A hook must answer within its timeout (1500 ms by default). When no daemon answers, the hook runs the same rules in its own process (`packages/cli/src/commands/hook-cmd.ts`). In CI a missing daemon fails closed (`packages/agent-adapters/src/hook-client.ts`). A crash while checking `PreToolUse` blocks the call; only a developer's `ctrlplane pause` lets it through (D-18, `onCrash` in `hook-cmd.ts`).
- Agents must never be able to switch supervision off. Any new command that stops, pauses, weakens or uninstalls supervision, or writes what the next session is told, must be classified in `CLI_COMMAND_SAFETY` in `packages/policy-engine/src/default-rules.ts`; `packages/cli/tests/command-safety.test.ts` fails on a command it does not list. Shell rules match the words as the shell will run them (`packages/policy-engine/src/shell.ts`), never the raw text.
- Context given to an agent is information, never instructions. It comes only from an approved spec, the session's own captures and memory the developer added (`packages/context/src/pack.ts`).
- Nested runs of `claude -p` (AI summaries) set `CTRLPLANE_NESTED=1`, and the hook returns at once for them. Without that, a summary would supervise itself in a loop.
- User state lives under `CTRLPLANE_HOME` (default `~/.ctrlplane`), project state under `<project>/.ctrlplane/`. An in-memory store (`:memory:`) writes nothing inside the project.

## Tests

- Every test that touches the filesystem works in its own `mkdtemp` folder, never in this repo or a shared fixed path.
- Anything that starts a server or daemon stops it in `finally`, or one failed assertion keeps the test process alive.
- Every bug fix gets a regression test named `regression: ...` that fails on the old code.
- Every package has at least one test file in `packages/<name>/tests/`.

## Rules and what enforces them

When the developer corrects a mistake, fix it and add its rule here. A rule whose enforcer is "nothing" is a judgment call; if its mistake happens again, enforce it at the highest level that works (one owner in the code, then a type, then a lint or CI check, then a test) in the same change, and drop the rule once the mistake cannot happen.

| Rule                                                                                                    | Enforced by                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Only erasable TypeScript                                                                                | `erasableSyntaxOnly` in `tsconfig.json` (`make typecheck`)                                     |
| State paths, `CTRLPLANE_HOME`, the default session id and the context events come from one place        | `packages/core/src/paths.ts`; ESLint `no-restricted-syntax` names the function to use          |
| The files AgentDock copies (redactor, keychain, supervisor-config, token-pricing) import only `node:`   | ESLint `no-restricted-imports`; AgentDock's `scripts/cli-copies.ts` checks the copies          |
| Every `ctrlplane` command is classified as safe or an off-switch for agents                             | `CLI_COMMAND_SAFETY`; `packages/cli/tests/command-safety.test.ts`                              |
| A command that fails exits non-zero                                                                     | `COMMANDS` in `cli.ts` only accepts a `CommandResult`; `packages/cli/tests/exit-codes.test.ts` |
| A test stops a daemon or server in `finally`                                                            | ESLint on test files, for `.stop()`; `.close()` and `.kill()` are still a judgment call        |
| No suppression comments, stubs, skipped or deleted tests, removed assertions, weakened `CONSTRAINTS.md` | `scripts/floor-guard.ts` (after each edit and in CI)                                           |
| Every package has a test file; actions and images are pinned; no planning references                    | `scripts/hygiene.ts`                                                                           |
| One root `tsconfig.json`                                                                                | nothing (happened once, P-3)                                                                   |
| Shell rules match the words the shell will run, not the raw text                                        | nothing: judgment (`shell.ts` gives the words)                                                 |
| Every filesystem test works in its own `mkdtemp` folder                                                 | nothing                                                                                        |
| Every bug fix gets a `regression:` test that fails on the old code                                      | nothing: judgment                                                                              |
| Never report a gate green from piped output                                                             | the Stop hook runs the task-end checks itself and reads their exit codes                       |

## Docs and history

- Bugs and findings: `ISSUE.md` (FOUND → IN PROGRESS → FIXED). A pattern that keeps coming back moves to `docs/PITFALLS.md`.
- Design decisions: `docs/DECISIONS.md`. Docs point to code and to each other; they never restate a test run or a finished phase.
- Working rules for Claude (session start, tests, docs, self-correction, adding instructions): `.claude/docs/rules.md`.

## Skills

- Whenever a task needs a skill, pick it from the skill picker in `.claude/skills/README.md` first. Use a global skill only when none there covers the task, and never a skill written for another project.

## Agents, commands and skills

| Name                       | Use it when                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `verify` agent             | You need a per-gate pass/fail report from real exit codes                             |
| `review` agent             | A staged diff, branch, file or PR needs checking against these invariants             |
| `fix` agent                | A bug needs a root cause, a failing `regression:` test, a fix and an `ISSUE.md` entry |
| `brainstorm` agent         | A non-trivial choice needs options and failure modes before any code                  |
| `audit` agent              | A package or the whole repo needs a sweep; findings go to `ISSUE.md` as FOUND         |
| `cleanup` agent            | One open `ISSUE.md` item should be closed                                             |
| `/investigate-bug` command | A bug needs its ground truth (audit.db, hook output, daemon log) before a fix         |
| `/retro` command           | A task is done and had corrections or rework                                          |
| `feature` skill            | You add or change behaviour: plan, approval, tests first, `make ci`                   |
| `pr-review` skill          | A GitHub PR needs review; comments are posted only after a yes                        |
| `dead-weight` skill        | A branch is about to merge and may leave unused code or stale docs                    |
| `merge-readiness` skill    | Someone asks whether a PR can merge; report only                                      |

Never merge, approve, push, tag or post on GitHub without the developer's yes.

## Code comments

- Comment only a reason the code cannot show: a non-obvious rule, a workaround, a security limit.
- One sentence. Prefer a clear name over a comment.
- Never narrate the change ("added", "now", "fixed") in a comment. That belongs in the commit message.
- Keep useful existing comments.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root; decisions go in `docs/DECISIONS.md` (D-N), not `docs/adr/`. See `docs/agents/domain.md`.
