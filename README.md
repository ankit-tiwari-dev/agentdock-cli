# AgentDock CLI (`@ctrlplane`)

> **The local-first supervision, verification, and auditability control plane for AI coding agents.**

[![Tests](https://img.shields.io/badge/tests-41%2F41%20passing-emerald)](https://github.com/ankit-tiwari-dev/agentdock-cli)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-purple)](LICENSE)

**AgentDock CLI** (`ctrlplane`) is an open-source, local-first supervision layer that connects developer intent, coding agent activity (Claude Code, OpenAI Codex, OpenCode, Cursor, Goose, Devin), and independent verification. 

It synthesizes the best ideas from **FailproofAI** (policy enforcement & multi-CLI normalizers), **Builderz Labs Mission Control** (token spend and model cost calculation), and **aGiTrack** (Git-backed commit trailers, transcript backtracing, and prompt coaching).

---

## Architecture Overview

```mermaid
flowchart TD
    Dev["Developer (Intent & Sign-off)"] -->|Defines Criteria| Spec[".ctrlplane/spec.md"]
    Coach["Prompt Coach (agitrack)"] -->|Refines Prompts| Dev
    
    subgraph Execution ["Supervised Execution Loop"]
        Agent["Coding Agent (Claude / Codex / OpenCode / Cursor)"] -->|PreToolUse Hook| Shim["ctrlplane-hook (<15ms IPC)"]
        Shim --> Normalizer["Multi-CLI Normalizer (failproofai)"]
        Normalizer --> Daemon["ctrlplane-daemon (Named Pipe / UNIX Socket)"]
        Daemon --> Policy["Policy Engine, Self-Tamper Guard & Loop Breaker"]
        
        Policy -->|Destructive Command or Test Alteration| Block["Exit Code 2 (BLOCK & Invalidate)"]
        Block --> Agent
        Policy -->|Safe Operation| Allow["Exit Code 0 (ALLOW)"]
        Allow --> Agent
    end
    
    Agent -->|Completed Turn| GitTracker["Agent Commit Tracker (Git Trailers)"]
    Agent -->|Completion Signal| Verifier["Two-Tier Verification Engine"]
    
    subgraph Verification ["Independent Verification & Audit"]
        Verifier --> T1["Tier 1: Compilers, Test Suites & Test-Tamper Integrity"]
        Verifier --> T2["Tier 2: Evidence-Backed Semantic Criteria Audit"]
        T1 & T2 --> Report["Evidence Report (Line-level citations)"]
        GitTracker --> Spend["Token Spend & Cost Calculator (mission-control)"]
    end
    
    Report --> Dev
```

---

## Key Capabilities

* **Anti-Test-Gaming Guard:** Agents frequently "fix" broken code by deleting or weakening existing test assertions. AgentDock intercepts tool calls targeting test files and blocks alterations to existing assertions with `Exit Code 2`.
* **Agent Self-Tamper Guard (from FailproofAI):** Strictly blocks agents from editing their own hooks (`.claude/settings*.json`, `.codex/hooks.json`, `.cursor/hooks.json`) to disable supervision.
* **Multi-CLI Tool Canonicalizer:** Unifies diverse tool naming conventions (`run_command`, `Bash`, `str_replace_editor`, `write_file`) into deterministic policy verbs.
* **Token Spend & Cost Calculator (from Builderz Labs Mission Control):** Real-time dollar cost and token calculation across Claude 3.5 Sonnet, Gemini 1.5 Pro/Flash, GPT-4o, and local Ollama.
* **Git-Backed Commit Tracking & Trailers (from aGiTrack):** Stages and creates Git commits per turn carrying structured `# AgentDock Metadata` trailers and masked local paths (`[PATH]`).
* **Prompt Coach & Socratic Insights:** Analyzes prompt quality before sending to worker agents, flagging ambiguity, lack of test grounding, and loop patterns.
* **Historical Transcript Backtracer:** Reconstructs prior turns, files touched, tokens, and dollar costs from Claude Code `~/.claude/projects/` transcripts.
* **Destructive Command Guard:** Blocks `rm -rf`, `git push --force`, `git reset --hard`, recursive deletions, and private credential reads (`.env`, `.pem`, `~/.ssh`).
* **Loop Breaker (Circuit Breaker):** Automatically detects when an agent fails the same test or command 3 consecutive times, halting the agent to prevent runaway token spend.
* **Two-Tier Verification:** Never trusts an agent's self-reported "Done" signal. Deterministically verifies code with compiler passes and line-level semantic audits.
  * **Tier 1 (Deterministic):** Compilers, typecheckers, test runners, and AST test-tamper analyzers.
  * **Tier 2 (Semantic):** Maps acceptance criteria against code diffs and requires exact file, start line, and end line citations.
* **Sub-15ms Latency Budget:** Lightweight hook shim connects to the daemon over Windows Named Pipes or UNIX domain sockets, acknowledging calls in $< 10\text{ms}$.
* **Zero-Allocation Secret Redaction:** Strips Anthropic keys, OpenAI keys, GitHub tokens, AWS credentials, and `.env` secrets prior to SQLite disk persistence.

---

## Monorepo Packages

| Package | Description |
|---|---|
| [`@ctrlplane/core`](packages/core/) | Shared domain contracts, Zod schemas, and deterministic spec hashing. |
| [`@ctrlplane/storage`](packages/storage/) | SQLite WAL database engine via `node:sqlite` and pre-storage secret redactor. |
| [`@ctrlplane/git-analyzer`](packages/git-analyzer/) | AST unified diff parser, file classifier, and Anti-Test-Gaming guard. |
| [`@ctrlplane/policy-engine`](packages/policy-engine/) | Declarative safety rules, regex guards, and 3-strike Loop Breaker. |
| [`@ctrlplane/daemon`](packages/daemon/) | Windows Named Pipe (`\\.\pipe\ctrlplane-*`) & UNIX socket IPC daemon. |
| [`@ctrlplane/agent-adapters`](packages/agent-adapters/) | Non-destructive hook injectors for Claude Code, Codex, and OpenCode. |
| [`@ctrlplane/intent`](packages/intent/) | Markdown specification parser (`.ctrlplane/spec.md`) and criteria tracker. |
| [`@ctrlplane/verifier`](packages/verifier/) | Two-tier verification runner and 5-state verdict reporter. |
| [`@ctrlplane/explanation`](packages/explanation/) | Blast radius tracer, dependency drift auditor, and Socratic quiz generator. |
| [`@ctrlplane/cli`](packages/cli/) | The developer command-line interface (`ctrlplane`). |

---

## Quickstart

### 1. Initialize a Project
Run inside any Git repository:

```bash
# Initialize .ctrlplane templates and inject hooks into Claude Code / Codex
node packages/cli/src/bin.ts init
```

This creates `.ctrlplane/spec.md`, `.ctrlplane/policies.yaml`, and non-destructively wires hooks into `.claude/settings.json` or `.codex/hooks.json`.

### 2. View and Approve Specification
```bash
# View active criteria
node packages/cli/src/bin.ts spec show

# Approve specification and lock baseline commit
node packages/cli/src/bin.ts spec approve "ankit"
```

### 3. Start the Supervisor Daemon
```bash
# Starts the background supervisor daemon
node packages/cli/src/bin.ts start

# Check status and IPC endpoint
node packages/cli/src/bin.ts status
```

### 4. Run Independent Verification
```bash
node packages/cli/src/bin.ts verify
```

### 5. Prompt Coaching & Socratic Guidance
```bash
# Analyze prompt quality and receive actionable suggestions
node packages/cli/src/bin.ts coach "fix the login error"
```

### 6. Git-Backed Commit Tracking & Spend Calculation
```bash
# Create a structured turn commit with AgentDock metadata trailers
node packages/cli/src/bin.ts commit "Implement authentication middleware"

# Calculate exact dollar spend for model input/output tokens
node packages/cli/src/bin.ts cost claude-3-5-sonnet 15000 2500

# Reconstruct historical sessions from local Claude transcripts
node packages/cli/src/bin.ts backtrace
```

---

## Automated Test Suite

Run the complete test suite across all 10 packages:

```bash
node --test packages/*/tests/**/*.test.ts
```

Output:
```
✔ 41 pass, 0 fail (100% deterministic coverage)
```
```
✔ 29/29 tests passing (Duration: ~3.1s)
```

---

## License

MIT © [Ankit Tiwari](https://github.com/ankit-tiwari-dev)

