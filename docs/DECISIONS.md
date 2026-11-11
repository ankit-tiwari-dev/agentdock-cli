# Decisions

One entry per decision: what we chose, why, and what we gave up. Append new entries and never rewrite old ones. When a decision changes, add a new entry that supersedes the old one.

## D-1 · Small packages, a per-project daemon, and hooks that work without it

- **Decision:** the engine is split into the packages listed in `docs/ARCHITECTURE.md`. One daemon runs per project. Every hook can still evaluate the rules on its own when the daemon is down.
- **Why:** a supervisor that stops supervising when a background process dies gives false safety. The daemon only makes hooks faster and keeps a fuller audit trail.
- **Cost:** the rules must stay cheap enough to load in a short-lived process. The policy-engine perf test guards this.
- **Planned:** a compiled Go hook binary, to cut the Node start-up time from each hook, and a React dashboard in the AgentDock app. Neither exists yet.

## D-2 · Run TypeScript directly, no build step

- **Decision:** Node runs the `.ts` sources by stripping types. This is on by default from Node 22.18. `tsc` only type-checks (`noEmit`).
- **Why:** there is no `dist/` that can drift from the source, and a stack trace points at the real file and line.
- **Cost:** only erasable TypeScript syntax is allowed (`CLAUDE.md` → Code invariants, `docs/PITFALLS.md` → P-1).

## D-3 · One root tsconfig

- **Decision:** a single `tsconfig.json` covers `packages/*/src` and `packages/*/tests`.
- **Why:** the editor and `npm run typecheck` then report the same errors. Per-package configs drifted and caused 743 editor-only errors (`ISSUE.md` → I-4).

## D-4 · Local-first storage in SQLite

- **Decision:** all audit data stays on the developer's machine in `node:sqlite`. Secrets are redacted before anything is written.
- **Why:** tool payloads contain source code and credentials. Nothing leaves the machine unless the developer exports it.

## D-5 · AI summaries are opt-in and use the local `claude` CLI

- **Decision:** session summaries are deterministic by default. With `aiSummaries` turned on, AgentDock calls `claude -p` with no tools, no MCP servers and a fixed system prompt, from a temporary folder, with `CTRLPLANE_NESTED=1`.
- **Why:** no API key to manage and no new network destination. The nested flag stops the summary run from being supervised and summarised itself.

## D-6 · Context is information, never instructions

- **Decision:** the SessionStart context pack only contains an approved spec, the project's own captured intents, summaries and handoffs, and memory the developer added. It is capped at 6000 characters and labelled as background.
- **Why:** anything injected into an agent's context can steer it. Agents are denied `ctrlplane memory add|rm`, so an agent cannot plant instructions for the next session.

## D-7 · Ideas from other tools are re-implemented, never copied

- **Decision:** a feature seen in another project is written from a description of its behaviour, by someone who has not read that project's code.
- **Why:** copied code carries its license with it, including notices that must be kept. Independent code carries none.

## D-8 · Releases are GitHub Releases only

- **Decision:** a `v*` tag runs every gate, then attaches the packed CLI to a GitHub Release. Nothing is published to npm or an extension marketplace.
- **Why:** one release channel to secure and support while the product is pre-1.0.
