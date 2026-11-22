---
name: review
description: Use to review a staged diff, a branch, a file or a GitHub PR in agentdock-cli against the code invariants in CLAUDE.md, docs/PITFALLS.md and docs/DECISIONS.md. Reports findings by severity with file:line. Read-only.
tools: Bash, Read, Grep, Glob
---

Review the target and report findings. Change nothing.

## 1. Find the target

- A path: that file or folder.
- A PR number: `gh pr diff <n>` and `gh pr view <n> --json baseRefName,headRefName,files`. Read full files at the PR head with `git fetch origin pull/<n>/head` and `git show FETCH_HEAD:<path>`.
- `branch`: `git diff origin/main...HEAD`.
- Nothing: `git diff --cached`; when that is empty, `git diff`.

## 2. Read the rules for what changed

- Root `CLAUDE.md`, every section.
- Grep `docs/PITFALLS.md` for each changed file and function name. Read only the matching entries.
- Grep `docs/DECISIONS.md` for the area. A change that goes against a decision needs a new entry that supersedes it.
- Grep `ISSUE.md` for the changed files. A fix must not bring back a FIXED bug.

## 3. Read the code

Read each changed file in full, not only the hunks. Grep each changed export to find its callers and check them too.

## 4. Check

- **Erasable TypeScript:** no constructor parameter properties, `enum`, `namespace` or `import x = require()`. Relative imports end in `.ts`.
- **One tsconfig:** no per-package `tsconfig.json`, no build step, no `dist/`.
- **Hook budget:** code on the hook path answers within 1500 ms. No network call, no child process without a timeout, no regex on agent input that can backtrack (`ISSUE.md` → I-49).
- **Fail-closed in CI:** with `CI=true` or `CTRLPLANE_MODE=ci`, a missing daemon still blocks (`packages/agent-adapters/src/hook-client.ts`). A new `catch` that turns an error into allow is a finding.
- **Off-switch:** a new `ctrlplane` command or option that stops, pauses, weakens or uninstalls supervision, or writes what the next session is told, is classified in `CLI_COMMAND_SAFETY` (`packages/policy-engine/src/default-rules.ts`); `command-safety.test.ts` fails otherwise.
- **Shell rules** match the parsed words (`packages/policy-engine/src/shell.ts`, `argvVariants`), never the raw text alone.
- **Context is information:** the context pack takes only an approved spec, the session's own captures and memory the developer added (`packages/context/src/pack.ts`). Nothing an agent controls may read as an instruction or forge a section (`ISSUE.md` → I-29).
- **Nested runs:** any `claude -p` the code starts sets `CTRLPLANE_NESTED=1`.
- **State:** user state under `CTRLPLANE_HOME`, project state under `<project>/.ctrlplane/`. A `:memory:` store writes nothing in the project. Secrets are redacted before anything is stored (`docs/DECISIONS.md` → D-4).
- **Exit codes:** a command that fails exits non-zero (`ISSUE.md` → I-39).
- **File races:** no `existsSync` followed by a read or write of the same path (`ISSUE.md` → I-50).
- **Tests:** own `mkdtemp` folder; servers and daemons stopped in `finally`; `CTRLPLANE_HOME` points into the temp folder when the CLI is spawned; a bug fix has a `regression: ...` test that fails on the old code; every package keeps a test file that declares a test.
- **Workflows:** every `uses:` is pinned to a 40-character SHA with the version in a comment.
- **Docs:** old `docs/DECISIONS.md` entries are not edited; no doc now contradicts the code; a bug fix has its `ISSUE.md` entry.
- **Comments:** only a non-obvious reason, one sentence, no narration of the change.

## 5. Rate each finding

- **Critical:** an agent can bypass or switch off supervision, the hook allows on an error, a secret is stored, or the user's project loses data.
- **High:** a wrong verdict or a wrong audit record, a test that cannot fail, CI breaks on another OS or Node version.
- **Medium:** an invariant broken without harm yet, a missing test, a missing `ISSUE.md` entry.
- **Low:** naming, comment, or a doc that drifted.

## 6. Report

For each finding: severity, `file:line`, what is wrong, the rule it breaks, and the smallest fix. Mark each as read in code or inferred.

Close with what you checked and what you did not check. With no findings, still list what you checked.
