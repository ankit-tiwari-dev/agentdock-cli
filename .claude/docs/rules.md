# Working rules for Claude Code in agentdock-cli

Root `CLAUDE.md` holds the code invariants and wins over this file. This file holds the longer working rules. Agents, commands and skills point here instead of repeating them.

## Session start

1. Read root `CLAUDE.md`.
2. List the open items: `grep -nE "^## I-[0-9]+ · (FOUND|IN PROGRESS)" ISSUE.md`. Read the ones that touch your task.
3. Read the recent history: `git log --oneline -15` and `git status`. Note the branch and anything uncommitted that is not yours. Never stash, reset or check out over someone else's changes.
4. Grep `docs/PITFALLS.md` for each file and function you expect to touch.
5. Pick a skill from `.claude/skills/README.md` when the task matches one.

## Tests

- **Runner:** `node:test` and `node:assert/strict`. Test files live in `packages/<name>/tests/*.test.ts` (and `scripts/tests/`). `npm test` runs them all, with a 60 s timeout per test.
- **One folder per test:** anything that touches the filesystem makes its own folder with `mkdtempSync(join(tmpdir(), "ctrlplane-<area>-"))` and removes it at the end. Never write into this repo, `process.cwd()` or a fixed shared path (`docs/PITFALLS.md` → P-2).
- **Isolated user state:** a test that spawns the CLI sets `CTRLPLANE_HOME`, `HOME` and `USERPROFILE` to folders inside its temp folder, so it never reads or writes the developer's `~/.ctrlplane`. See `scratch()` and `cli()` in `packages/cli/tests/regressions.test.ts`.
- **Inherited variables:** a test of the local, no-daemon path clears `CI` and `CTRLPLANE_MODE` for its own run and restores them, or it fails only on the CI runner (`ISSUE.md` → I-52).
- **Stop what you start:** start a daemon or server inside `try` and stop it in `finally`. Close databases there too. Give every test client a timeout. Otherwise one failed assertion keeps the process alive, and Windows cannot remove the temp folder (`docs/PITFALLS.md` → P-5).
- **Paths:** build paths with `node:path`, never by joining strings. Compare times as numbers, not formatted text. CI runs Linux, Windows and macOS on Node 22 and 24.
- **Regression tests:** every bug fix gets `test("regression: <what must stay true>", ...)`. Run it on the old code first and see it fail. Write the old code's actual and expected values into the `ISSUE.md` entry.
- **Plain names for guards:** a test that cannot fail on the old code (a race you cannot reproduce, a site that was already correct) gets a plain name, not `regression:`, and the `ISSUE.md` entry says why.
- **Every test catches a real bug.** No test that only repeats the implementation, no padding for coverage, no assertion that cannot fail. Ask what change would turn the test red; if none would, delete or rewrite it.
- **Every package keeps a test.** `make hygiene` fails when a package has no `tests/*.test.ts` that declares a test.
- **Manual tries** run only in a throwaway project with `CTRLPLANE_HOME` inside the temp folder (the `agentdock-cli` skill). Never run the hook, `ctrlplane init` or `ctrlplane start` in this repo or a real project to test something: they write `.ctrlplane/` and agent hook config there.

## Gates and evidence

- Done means `make ci` returned 0. Capture the exit code before reading any output: `make ci > "$(mktemp -d)/ci.log" 2>&1; echo "rc=$?"`. A pipe into `tail` reports `tail`'s code.
- Prove an edit landed: `git diff <file>`. Prove a new function is used: grep its call site. An edit that matched nothing and a helper nothing calls both pass every gate.
- A find-and-replace states how many matches it expected and how many it made.
- Show the command and its output when you say something works.

## Docs convention

Each doc has one job. A doc points at the code and at other docs; it never copies them.

| File                   | Holds                                                                     | Never holds           |
| ---------------------- | ------------------------------------------------------------------------- | --------------------- |
| `CLAUDE.md`            | Code invariants that are easy to break, and the gates                     | Rationale, history    |
| `docs/ARCHITECTURE.md` | How a tool call is supervised, which package owns what, where state lives | Why a choice was made |
| `docs/DECISIONS.md`    | One entry per decision: Decision, Why, Cost (`D-<n>`)                     | Edits to old entries  |
| `docs/PITFALLS.md`     | Traps that already bit the code, with a link to the issue (`P-<n>`)       | One-off bugs          |
| `ISSUE.md`             | Bugs and findings: FOUND → IN PROGRESS → FIXED (`I-<n>`)                  | Plans for features    |
| `README.md`            | What the tool does for a user, and how to install and run it              | Internal design       |
| `docs/README.md`       | The index of `docs/`                                                      | Content of its own    |

- `docs/DECISIONS.md` is append-only. To change a decision, add a new entry that names the one it supersedes.
- A new number is the highest existing number in that file plus one. `ISSUE.md` entries are not in number order.
- An `ISSUE.md` entry has **Symptoms**, **Root cause** (file:line), **Fix** and **Verification**. A pattern that comes back moves to `docs/PITFALLS.md`.
- No test-run results, "phase done" notes or progress stories in any doc. Git history holds them.
- A doc that contradicts the code is a bug. Fix the doc in the same change, or record it in `ISSUE.md`.
- Nothing in the repo refers to private planning documents. `make hygiene` fails on such references.

## Self-correction

- When the developer corrects you, stop. Restate the correction in one line, fix the work, and check whether the same mistake sits elsewhere in what you did.
- When a gate fails after you said it would pass, say so plainly, find why, and fix the cause, not the symptom.
- When you guessed (a file, a flag, a behaviour) and the guess was wrong, say which claims rested on it and check them again.
- Two failed tries at the same fix: stop and go back to the root cause (the `systematic-debugging` skill).
- At the end of a task with corrections or rework, run `/retro`.

## Adding instructions for Claude

| Kind of content                                     | Where it goes                                  | Budget                          |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| A code invariant that is easy to break              | Root `CLAUDE.md`, one line                     | Short; detail moves out         |
| A working rule with detail (tests, docs, process)   | `.claude/docs/rules.md`                        | 150 lines                       |
| A role run in its own context (review, fix, verify) | `.claude/agents/<name>.md`                     | 80 lines                        |
| A prompt the developer starts by name               | `.claude/commands/<name>.md`                   | 80 lines                        |
| A workflow Claude picks up by its description       | `.claude/skills/<name>/SKILL.md`               | 120 lines; detail in references |
| A lesson about how one developer likes to work      | Auto-memory, not the repo                      | One file per lesson             |
| Why the code is built a certain way                 | `docs/DECISIONS.md`, never an instruction file | One entry                       |

- Agent frontmatter: `name`, `description` (when to use it), `tools` (the fewest it needs; read-only agents get `Bash, Read, Grep, Glob`).
- Command frontmatter: `description`, plus `argument-hint` when it takes arguments.
- Skill frontmatter: `name`, and a `description` that starts with "Use when".
- A new skill gets a line in `.claude/skills/README.md`. A copied skill also gets its source, commit and license there, and an entry in `.prettierignore`.
- Write plain, short, imperative sentences. Point at the file that owns a fact; do not copy it.
- A one-line summary keeps every never, must, only and always clause, every order and number, and the names it refers to. Only the reason and history move to the detail file.
- Never delete a rule to fit a budget. Move its detail out word for word.
- A rule becomes a `CLAUDE.md` line after it was broken three times (`/retro`).
