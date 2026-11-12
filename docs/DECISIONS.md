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

- **Decision:** a `v*` tag runs every CI and security gate, then attaches a source archive of the tagged tree and its `SHA256SUMS` to a GitHub Release (`.github/workflows/release.yml`). Nothing is published to npm or an extension marketplace. The tag must equal `v` + the root `package.json` version.
- **Why a source archive:** the CLI imports the other packages by relative path, so the `cli` package alone would not run. The shipped code has no third-party runtime dependencies, so the archive plus Node is the whole install.
- **Why:** one release channel to secure and support while the product is pre-1.0.

## D-9 · Every CI check blocks, and exceptions expire

- **Decision:** lint, format, typecheck, hygiene, tests on Linux, Windows and macOS with Node 22 and 24, CodeQL, dependency review, OSV and a full-history secret scan all fail the run. A known advisory or a fake test secret is excused by name in `osv-scanner.toml` or `.gitleaks.toml`, never by turning a scan off. An OSV exception has an `ignoreUntil` date.
- **Why:** a check that only warns is ignored within a week. An exception with an end date gets looked at again; a disabled scan does not.
- **Cost:** a new advisory in a dev tool can turn the weekly run red with no code change. That is the point: someone decides.

## D-10 · An approval belongs to the exact spec text

- **Decision:** `ctrlplane spec approve` writes `approved_hash` next to `status: approved`. A spec whose title and body no longer match that hash loads as `draft`, and so does a spec marked approved by hand with no hash. Agents may not run `spec approve`.
- **Why:** the approved spec is injected into every session as the agreed criteria. If an edit kept the approval, an agent could change a criterion and still have it shown as agreed.
- **Cost:** a spec approved before this change, or edited after approval, must be approved again.

## D-11 · Docker is for developing the CLI, not for running it

- **Decision:** `.devcontainer/` gives contributors the toolchain CI uses (Node 24, Go 1.27, make, git), and CI runs `make ci` inside it. There is no image for running the CLI, the daemon or the hooks.
- **Why:** the agent starts `ctrlplane hook` before every tool call, on the machine where the agent runs, with a 1500 ms budget. Starting a container per call would spend most of that budget, and the hook would see only the folders shared with the container. The daemon also has to read the same project folders and git state as the agent. Version drift for users is handled by `engines`, `.nvmrc`, `npm ci` and the CI matrix; the dev container removes it for contributors.
- **Cost:** two base images to keep current (Dependabot updates their digests; a new Node or Go release line is moved by hand, together with `.nvmrc`, `engines` and the workflows).
