# Constraints

What "good enough to merge" means for this repo, with the command behind each number. An agent reads this before writing code and never weakens it to make a change pass: fix the code, or add a dated exception below and say so in the PR. Tightening a number needs no discussion; loosening one does (`docs/DECISIONS.md` → D-15).

Last reviewed: 2026-11-21 by @ankit-tiwari-dev

## Floor (always enforced, blocks from day one)

Checked by `npm run check:floor` (`scripts/floor-guard.ts`) on the diff against `origin/main`: after every agent edit and in CI.

- No new suppression comments: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `istanbul`/`c8`/`v8 ignore`, `nosemgrep`, `gitleaks:allow`
- No unfinished work: a "not implemented" throw, an empty `catch {}`, a new `TODO` or `FIXME`
- No easier tests: no `.skip`, `.todo` or `.only`, no `{ skip: true }`, no deleted test file, no assertion removed from a test that stays
- No secrets in source: gitleaks over the full history (`.github/workflows/security.yml`)
- This file is not weakened: no threshold loosened, rule removed, exception added or extended, path added to `.constraintsignore`, or violation added to `.dependency-cruiser-known-violations.json`

## Enforced with numbers

| Dimension                 | Rule                                                                            | Checked by                                      | Runs at      | Blocking        |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ | --------------- |
| Types                     | Zero type errors                                                                | `npm run typecheck`                             | task end, CI | yes             |
| Lint                      | Zero ESLint errors                                                              | `npm run lint`                                  | task end, CI | yes             |
| Format                    | Prettier reports no file                                                        | `npm run format:check`                          | task end, CI | yes             |
| Repo rules                | `scripts/hygiene.ts` reports nothing                                            | `npm run hygiene`                               | CI           | yes             |
| Tests                     | Every test passes on Linux, Windows and macOS with Node 22 and 24               | `npm test`                                      | CI           | yes             |
| Security: code            | No CodeQL alert                                                                 | CodeQL (`security.yml`)                         | CI           | yes             |
| Security: dependencies    | No known vulnerability without a dated exception in `osv-scanner.toml`          | osv-scanner, dependency review (`security.yml`) | CI           | yes             |
| Coverage of changed lines | >= 80% of added executable lines covered                                        | `npm run check:coverage`                        | task end, CI | from 2026-12-05 |
| Architecture              | Imports follow `docs/ARCHITECTURE.md`; no import cycle; src never imports tests | `npm run check:arch` (dependency-cruiser)       | task end, CI | from 2026-12-05 |
| Hook latency, no daemon   | p95 at most 1000 ms over 30 runs, and never over the 1500 ms hook timeout       | `npm run check:hook-latency`                    | CI           | from 2026-12-05 |

Why these numbers:

- **80% of changed lines:** high enough that new code comes with a test, low enough to allow a line no test can reach (a platform branch, a defensive `catch`). The gate counts only lines the coverage report marks executable, in files a test loads.
- **1000 ms:** the slowest of two 40-run measurements on the developer's Windows machine was p95 793 ms; 1000 ms is that plus 25% for run-to-run noise, and leaves a third of the 1500 ms hook timeout for a slow disk. Re-measure from the CI `constraints` job before 2026-12-05, since CI runs on Linux.
- **2026-12-05:** two weeks of warnings to tune these three gates before they block. `scripts/warn-window.ts` holds the date; after it a failure fails the run.

## Ratchets

Today's value, held. The value moves up when the code improves and never down.

| Metric                  | Today  | Direction                           | Checked by               |
| ----------------------- | ------ | ----------------------------------- | ------------------------ |
| Project line coverage   | 92.36% | must not fall (0.5 point tolerance) | `npm run check:coverage` |
| Project branch coverage | 87.01% | must not fall                       | measured only            |

Measured 2026-11-21 with `npm run test:coverage` (Node 26.13, Windows). The 0.5 point tolerance absorbs a moved unrelated file. Tests that run the CLI as a child process do not count toward these numbers; only code a test imports does.

## Exceptions

| ID  | Rule                       | Path                                                                            | Reason                                                                                                                                                                                                                              | Owner             | Expires    |
| --- | -------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------- |
| W1  | Architecture: layer-daemon | `packages/daemon/src/supervisor-daemon.ts` → `packages/context/src/recorder.ts` | The daemon records context through `context`, which the architecture table does not list for `daemon`. Either record the dependency in `docs/ARCHITECTURE.md` with a decision, or move recording behind a seam the daemon is given. | @ankit-tiwari-dev | 2027-02-19 |

## Known gaps

- The architecture table lets `daemon` import `agent-adapters` and `agent-adapters` import `daemon`. The check enforces the table, so this package cycle passes until the table changes.
- Coverage does not see code that only runs in a spawned `ctrlplane` process (hook, daemon start-up). Those paths are covered by the tests that spawn it, not by this number.
- No external check runs against a live product here: the hook has no URL. CodeQL, osv-scanner and gitleaks are the outside opinions.

## When each check runs

| Stage                                          | What runs                                                                      | Budget                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| After each agent edit (PostToolUse)            | floor                                                                          | a few seconds          |
| Task end (Stop hook, `npm run check:task`)     | lint, format, typecheck, floor, tests with coverage, architecture, in parallel | about 60 s; under 90 s |
| CI (`make constraints`, the `constraints` job) | all of the above plus hook latency, and every existing gate                    | no limit               |

The hooks live in `.claude/settings.json` and call `scripts/agent-check.ts`. The Stop hook runs only when the working tree has uncommitted code changes.
