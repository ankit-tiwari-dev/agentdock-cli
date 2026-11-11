# AgentDock CLI: rules for working in this repo

The code invariants that are easy to break. The how and why live in `docs/` (index: `docs/README.md`).

## Run everything through make

- `make ci` runs every gate CI runs, in the same order. Run it before you call work done.
- `make typecheck`, `make test`: the single gates. Never report a gate green from piped output; read its exit code.

## Code invariants

- Node runs `.ts` files directly by stripping the types, so only erasable TypeScript is allowed: no constructor parameter properties, no `enum`, no `namespace`, no `import x = require()`. Import sibling files with an explicit `.ts` ending.
- One `tsconfig.json` at the root covers every package. Never add a per-package tsconfig (see `docs/PITFALLS.md` → P-3).
- A hook must answer within its timeout (1500 ms by default). When no daemon answers, the hook runs the same rules in its own process (`packages/cli/src/commands/hook-cmd.ts`). In CI a missing daemon fails closed (`packages/agent-adapters/src/hook-client.ts`).
- Agents must never be able to switch supervision off. Any new command that stops, pauses, weakens or uninstalls supervision must be added to the self-tamper patterns in `packages/policy-engine/src/catalog.ts`, with a test.
- Context given to an agent is information, never instructions. It comes only from an approved spec, the session's own captures and memory the developer added (`packages/context/src/pack.ts`).
- Nested runs of `claude -p` (AI summaries) set `CTRLPLANE_NESTED=1`, and the hook returns at once for them. Without that, a summary would supervise itself in a loop.
- User state lives under `CTRLPLANE_HOME` (default `~/.ctrlplane`), project state under `<project>/.ctrlplane/`. An in-memory store (`:memory:`) writes nothing inside the project.

## Tests

- Every test that touches the filesystem works in its own `mkdtemp` folder, never in this repo or a shared fixed path.
- Anything that starts a server or daemon stops it in `finally`, or one failed assertion keeps the test process alive.
- Every bug fix gets a regression test named `regression: ...` that fails on the old code.
- Every package has at least one test file in `packages/<name>/tests/`.

## Docs and history

- Bugs and findings: `ISSUE.md` (FOUND → IN PROGRESS → FIXED). A pattern that keeps coming back moves to `docs/PITFALLS.md`.
- Design decisions: `docs/DECISIONS.md`. Docs point to code and to each other; they never restate a test run or a finished phase.
