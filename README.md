# AgentDock CLI (`ctrlplane`)

> A local supervisor for AI coding agents. It checks every tool call before it runs, keeps an audit trail, and gives each new session the context the last one left behind.

[![CI](https://github.com/ankit-tiwari-dev/agentdock-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ankit-tiwari-dev/agentdock-cli/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue)](https://nodejs.org)

AgentDock hooks into Claude Code, OpenAI Codex and OpenCode. Before the agent runs a tool, the hook asks AgentDock, and AgentDock answers in one of four ways: allow, deny with a reason the agent can read, ask the human, or allow with an instruction. Everything runs on your machine, and nothing is sent anywhere.

## How it works

```mermaid
flowchart TD
    Agent["Coding agent"] -->|before each tool call| Hook["ctrlplane hook"]
    Hook -->|daemon running| Daemon["Per-project daemon (named pipe / Unix socket)"]
    Hook -->|no daemon| Local["Same rules, evaluated in the hook process"]
    Daemon --> Rules["Policy engine"]
    Local --> Rules
    Rules -->|exit 0| Allow["Allow"]
    Rules -->|exit 2 + reason| Deny["Deny"]
    Daemon --> Audit["SQLite audit trail (secrets redacted)"]
    Daemon --> Context["Session context: intents, summaries, handoffs, memory"]
    Context -->|SessionStart| Agent
```

Package layout, state paths and the full request flow: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What it does

- **Guards destructive and risky commands.** It blocks recursive deletes, force pushes, hard resets and reads of credential files (`.env`, `*.pem`, `~/.ssh`), and offers 25 more rules you can switch on, off or to observe-only.
- **Stops agents switching supervision off.** Edits to the agent's own hook settings, and commands that stop, pause, weaken or uninstall AgentDock, are denied.
- **Protects tests.** Changes that delete or weaken existing test assertions are blocked.
- **Breaks loops.** When the same command fails the same way three times in a row, the next call needs human approval.
- **Carries context between sessions.** It records what you asked for, summarises each session, and keeps handoff notes and project memory. A new session then starts with a short context pack.
- **Verifies against a spec.** It runs deterministic checks plus an audit of each acceptance criterion in `.ctrlplane/spec.md`, which needs file-and-line evidence.
- **Explains a diff.** It shows changed symbols, blast radius, dependency changes and a short comprehension quiz.
- **Tracks cost.** It shows token and dollar cost per turn from local Claude Code transcripts, a per-turn commit with metadata trailers, and a prompt-quality coach.

## Quickstart

Requires Node 22.18 or newer (Node 24 recommended). There is no build step, because Node runs the TypeScript sources directly.

```bash
npm ci

# In the project you want supervised:
node packages/cli/src/bin.ts init --agent claude   # claude | codex | opencode | all
node packages/cli/src/bin.ts start                 # optional daemon: faster hooks, fuller audit trail
node packages/cli/src/bin.ts status
```

`init` creates `.ctrlplane/spec.md` and adds the hooks to the agent's settings without touching your other hooks.

### From a release

Each [GitHub Release](https://github.com/ankit-tiwari-dev/agentdock-cli/releases) holds a source archive, its `SHA256SUMS` and a signed build-provenance attestation. Check that the archive was built by this repo's release workflow before unpacking it:

```bash
gh attestation verify agentdock-cli-v<version>.tar.gz -R ankit-tiwari-dev/agentdock-cli
```

Then unpack it and run the `node packages/cli/src/bin.ts` commands above inside the folder. The shipped code has no third-party runtime dependencies, so Node is the whole install (`docs/DECISIONS.md` → D-8).

### Everyday commands

```bash
ctrlplane policies list                        # every rule and its mode
ctrlplane policies test --command "git push --force" --expect deny
ctrlplane pause 30m                            # always-on rules still apply
ctrlplane context                              # what a new session will be told
ctrlplane handoff --note "auth done, refresh tokens next"
ctrlplane memory add "integration tests need docker" --pin
ctrlplane spec approve "<your name>"
ctrlplane verify
ctrlplane explain
ctrlplane audit list
ctrlplane backtrace                            # turns, tokens and cost from local transcripts
ctrlplane cost claude-sonnet-4-5 15000 2500
```

Run `ctrlplane help` for the full list. Until the CLI is installed globally, use `node packages/cli/src/bin.ts` in place of `ctrlplane`.

### Supervisor providers

These commands choose the model the AgentDock dashboard uses to plan features and explain changes: `codex` (the local Codex CLI), `claude` (the Anthropic API) or `openai-compatible` (any server with the OpenAI chat API, such as Ollama or LM Studio). Run them in your own terminal. Agents are denied `use`, `set-key` and `remove-key`, because those decide where code and keys are sent.

```bash
ctrlplane supervisor use claude claude-sonnet-5-5           # model defaults to claude-opus-5-5
ctrlplane supervisor set-key claude                         # type the key at a hidden prompt
ctrlplane supervisor use openai-compatible llama3.2 --base-url http://127.0.0.1:11434/v1
ctrlplane supervisor use codex                              # Codex's own default model
ctrlplane supervisor status --check                         # one free models-list call
ctrlplane supervisor remove-key claude
```

- **Keys** are stored only in the OS keychain (service `agentdock`, account `claude` or `openai-compatible`). They are read at a hidden prompt or from `--stdin` (`op read ... | ctrlplane supervisor set-key claude --stdin`), never from an argument, because arguments are visible in the process list. No file holds a key.
- **The settings file** is `$CTRLPLANE_HOME/supervisor.json` (default `~/.ctrlplane`). It holds no secret:

  ```json
  {
    "version": 1,
    "provider": "openai-compatible",
    "model": "llama3.2",
    "openaiCompatible": { "baseUrl": "http://127.0.0.1:11434/v1" }
  }
  ```

- **Base URL rule:** `https` for any host; plain `http` only for `127.0.0.1`, `[::1]` and `localhost`; no user name, password, query string or fragment.
- **What is sent where:** `status --check` sends the key to the provider's models list and nothing else. Codex keeps its own login and gets no key from AgentDock.
- **Keychain per OS:** Windows Credential Manager (through Windows PowerShell) and the macOS `security` tool need nothing extra. Linux needs `secret-tool` from `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch), and a running Secret Service such as GNOME Keyring or KWallet.

## Development

```bash
make ci          # every gate CI runs
make lint        # ESLint + Prettier check
make hygiene     # repo rules
make typecheck
make test
```

### Develop in a dev container

`.devcontainer/` holds the environment CI uses: Node 24, Go 1.27 (for actionlint, gitleaks and osv-scanner), make and git, with the images pinned by digest. In VS Code, run **Dev Containers: Reopen in Container**; it installs the dependencies with `npm ci`. On Windows and macOS, **Dev Containers: Clone Repository in Container Volume** is much faster than opening a local folder, because `node_modules` then lives inside Docker instead of on a shared folder.

`make devcontainer-check` builds that image and runs `make ci` and actionlint in it, as CI does on every pull request. Run it from a normal clone, not a `git worktree`.

The dev container is for working on the CLI. Use the CLI itself on your machine, where the agent's hooks call it ([`docs/DECISIONS.md`](docs/DECISIONS.md) → D-11).

Rules for changing the code: [`CLAUDE.md`](CLAUDE.md). Known traps: [`docs/PITFALLS.md`](docs/PITFALLS.md). Known bugs: [`ISSUE.md`](ISSUE.md).

## License

MIT. See [`LICENSE`](LICENSE).
