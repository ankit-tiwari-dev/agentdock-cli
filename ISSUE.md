# Issues

Status flow: FOUND → IN PROGRESS → FIXED. Each entry: symptoms, root cause, fix, verification.

## I-1 · FIXED · The daemon crashed on start with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX

- **Symptoms:** `ctrlplane start` exited at once. Node printed `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` for `packages/context/src/recorder.ts`.
- **Root cause:** the class used a constructor parameter property (`constructor(private storage: ...)`). Node's type stripping can only delete types, and that syntax generates code. `tsc` accepts it, so the typecheck passed.
- **Fix:** plain field declarations assigned in the constructor.
- **Prevention:** `erasableSyntaxOnly` in `tsconfig.json` makes `tsc` reject non-erasable syntax (see `docs/PITFALLS.md` → P-1).

## I-2 · FIXED · Opening an in-memory store created `.ctrlplane/blobs` in the current folder

- **Symptoms:** running the tests left an empty `.ctrlplane/blobs` folder in the repo root.
- **Root cause:** `StorageEngine` built the blob folder from `process.cwd()` when `dbPath` was `:memory:`, and `BlobStore` created it in its constructor.
- **Fix:** an in-memory store keeps blobs in `tmpdir()/ctrlplane-blobs-<pid>`, and `BlobStore` creates its folder on the first write (`packages/storage/src/blob.ts`).
- **Verification:** a `regression:` test in `packages/storage/tests/storage.test.ts` fails on the old code with `actual ['.ctrlplane']`.

## I-3 · FIXED · Tests shared fixed temp folders and could hang

- **Symptoms:** test files interfered with each other, and the run never ended when the daemon test failed an assertion.
- **Root cause:** fixed folder names under the repo or `tmpdir()`, and a daemon that was not stopped when an assertion threw.
- **Fix:** every test uses its own `mkdtemp` folder. The daemon test stops the daemon in `finally`, and its IPC client has a 5 s timeout.

## I-4 · FIXED · 743 editor-only TypeScript errors

- **Symptoms:** VS Code showed TS5097, TS6059 and TS6307 errors that `npm run typecheck` did not report.
- **Root cause:** per-package `tsconfig.json` files with settings that did not match the root config the typecheck used.
- **Fix:** deleted the per-package configs and `tsconfig.base.json`. Every file uses the root `tsconfig.json` (see `docs/PITFALLS.md` → P-3).

## I-5 · FIXED · `ctrlplane backtrace` reports 0 turns and $0 on real Claude Code transcripts

- **Symptoms:** on a real 44-line transcript from `~/.claude/projects/`, the backtracer printed 0 turns, 0 tokens and $0.0000.
- **Root cause:** the parser read `content` and `usage` from the top level of each line. Real transcripts nest them under `message`, together with `message.model`. A user line that only carries `tool_result` blocks is the tool's reply, not a new turn. Claude Code also writes one line per content block of a response, each repeating that response's usage.
- **Fix:** `packages/agent-adapters/src/backtracer.ts` reads the nested format, counts usage once per `message.id`, and prices each turn with its own model, cache reads and cache writes included.
- **Verification:** `regression: nested Claude Code transcript ...` in `packages/agent-adapters/tests/tool-and-backtracer.test.ts`. The same real transcript now gives 4 turns, 50,461 tokens and $0.0964.

## I-8 · FIXED · Prices were missing for current models and for cache writes

- **Symptoms:** a transcript on `claude-opus-5-5` was priced at $0.0155 instead of $0.0964.
- **Root cause:** `packages/core/src/token-pricing.ts` listed no model newer than the 4.5 family, so current models fell back to the $3/$15 default. Most Claude rows had no cache-read rate, and cache-write tokens were not priced at all.
- **Fix:** every current Claude model has its input, output, cache-read and 5-minute cache-write rate. `calculateTurnCost` takes `cacheWriteTokens`, and the backtracer passes `cache_creation_input_tokens` to it.
- **Verification:** `regression: a current model is priced at its own rate, cache writes included` fails without the fix (`actual: 0, expected: 13700`).
- **Known limit:** Claude Haiku 5.5 costs more above a 100K-token prompt. The catalog holds one rate per model and uses the lower one.

## I-9 · FIXED · Per-turn commits lost their `# AgentDock Metadata` header

- **Symptoms:** the trailers were missing from commits made by `commitAgentTurn`, so `parseAgentCommitTrailers` returned null for them.
- **Root cause:** `git commit` by default deletes message lines that start with `#`, and the header starts with `#`.
- **Fix:** `commitAgentTurn` passes `--cleanup=whitespace`. A test makes a real commit in a temporary repo and reads the header back.

## I-10 · FIXED · The policy-engine speed test failed on a busy machine

- **Symptoms:** `PolicyEngine evaluates in under 5ms` failed during a full parallel run (1.2 ms average) and passed when run alone.
- **Root cause:** the test timed the first calls, which compile regexes, and asserted 1 ms although its name says 5 ms.
- **Fix:** 20 warm-up calls, then the average of 200, against 5 ms.

## I-6 · FOUND · `commitAgentTurn` stages every file with `git add --all`

- **Symptoms:** a per-turn commit can pick up unrelated files, including secrets that are not ignored.
- **Root cause:** `packages/git-analyzer/src/agent-commit-tracker.ts` runs `git add --all`. The product blocks that same command for agents (`RULE-GIT-STAGE-ALL` in `packages/policy-engine/src/catalog.ts`).
- **Fix (proposed):** stage only the files the turn modified, as the backtracer or event log reports them.

## I-7 · FOUND · The README says MIT but there is no LICENSE file

- **Symptoms:** the README license badge links to `LICENSE`, which does not exist. Without a license file the code is not open source in practice.
- **Fix (proposed):** the owner picks a license and adds `LICENSE`.

## I-11 · FOUND · The verification report always says lint passed

- **Symptoms:** `ctrlplane verify` prints `Lint / Static Analysis: PASS` for every project, including one with no linter.
- **Root cause:** `packages/verifier/src/deterministic-runner.ts` never runs a lint command. `lintPassed` is a constant `true`, which `packages/verifier/src/report-generator.ts` prints.
- **Fix (proposed):** run a configured lint command the same way as the test and typecheck commands, and print `NOT RUN` when none is configured.
