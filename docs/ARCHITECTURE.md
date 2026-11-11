# Architecture

AgentDock sits between a coding agent and the developer's machine. The agent asks its hook before every tool call. The hook answers allow, deny, or ask the human, and records what happened.

## How one tool call is supervised

```
agent (Claude Code / Codex / OpenCode)
  │  runs the hook command with the tool call as JSON on stdin
  ▼
ctrlplane hook <Event>              packages/cli/src/commands/hook-cmd.ts
  │  normalizes the agent's payload  packages/agent-adapters
  ├─ daemon running? ── yes ──► daemon over a named pipe / Unix socket
  │                              packages/daemon (IPC server, one per project)
  │                                 │ evaluates the rules        packages/policy-engine
  │                                 │ records the event          packages/storage (SQLite)
  │                                 │ records context            packages/context
  │                                 ▼
  │                              verdict
  └─ no daemon ──► the same rules evaluated in the hook process
  ▼
exit code + stdout/stderr the agent understands (0 allow, 2 deny)
```

The daemon is an optimisation, not a dependency. Without it every hook still applies the rules. It is slower, because each hook loads the rule set itself, and it keeps a thinner audit trail. In CI (`CI=true` or `CTRLPLANE_MODE=ci`) a missing daemon fails closed instead.

## Packages

Dependencies only point downwards. `core` depends on nothing, and `cli` sits on top.

| Package | What it owns | Depends on |
|---|---|---|
| `core` | Shared types: hook payloads, events, sessions, verdicts, IPC messages, tool names, model pricing | nothing |
| `storage` | SQLite database (`node:sqlite`): events, sessions, context entries, project memory with full-text search; secret redaction; gzip blob store for large payloads | core |
| `git-analyzer` | Diff parsing, file classification, test-tamper detection, per-turn commit trailers | core |
| `intent` | The project spec (`.ctrlplane/spec.md`): template, parser, approval | core, storage |
| `policy-engine` | Rule catalog, layered config (user < project < local), pause, loop breaker, evaluator | core, git-analyzer |
| `context` | Prompt intents, session summaries, handoffs, capability inventory, the SessionStart context pack | core, storage, intent, policy-engine |
| `daemon` | Per-project supervisor process, IPC server, lock file | core, storage, policy-engine |
| `agent-adapters` | Per-agent payload normalizers, hook install/uninstall, hook client, transcript backtracer | core, daemon |
| `verifier` | Deterministic checks plus the criteria audit against the spec | core, git-analyzer, intent |
| `explanation` | Diff explanation, blast radius, comprehension quiz, prompt coach | core, git-analyzer |
| `cli` | The `ctrlplane` command and the hook entry point | all of the above |

## Where state lives

| Path | Holds |
|---|---|
| `<project>/.ctrlplane/audit.db` | Events, sessions, context and memory for this project |
| `<project>/.ctrlplane/blobs/` | Large tool payloads, gzip-compressed, named by SHA-256 |
| `<project>/.ctrlplane/spec.md` | The developer's spec and its approval |
| `<project>/.ctrlplane/policies.json`, `policies.local.json` | Project rule settings (shared, and personal) |
| `<project>/.ctrlplane/daemon.lock` | PID and IPC address of the running daemon |
| `$CTRLPLANE_HOME/policies.json` (default `~/.ctrlplane`) | The developer's own rule settings for every project |

Design rationale: `docs/DECISIONS.md`. Known traps: `docs/PITFALLS.md`.
