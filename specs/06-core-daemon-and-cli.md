# Feature Specification: Core Daemon, CLI & Agent Adapters

**Module ID:** `SPEC-06-CORE`  
**Package:** `@ctrlplane/cli`, `@ctrlplane/daemon`, `@ctrlplane/agent-adapters`  
**Status:** Ready for Review

---

## 1. Objective & Scope

The Core Daemon, CLI & Agent Adapters module provides the foundational execution substrate for the AI Development Control Plane:
1. **Developer CLI (`ctrlplane`):** Fast, ergonomic terminal command-line interface for session control, verification, intent management, and audit inspection.
2. **Local Daemon (`ctrlplane-daemon`):** Lightweight background service hosting the local IPC socket, SQLite storage layer, policy engine, and verifier.
3. **Agent Adapters & Hook Injectors:** Automated, idempotent configuration tools that wire Claude Code, OpenAI Codex CLI, and OpenCode into the control plane without overwriting existing user settings.

---

## 2. Architecture & Runtime Topology

```
                  ┌──────────────────────────────────────────────┐
                  │            DEVELOPER WORKSTATION             │
                  └──────────────────────────────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
      ┌────────────────────┐                          ┌────────────────────┐
      │  Developer Terminal│                          │ Coding Agent Loop  │
      │  (ctrlplane CLI)   │                          │(Claude/Codex/OpenC)│
      └─────────┬──────────┘                          └─────────┬──────────┘
                │                                               │ stdin / stdout
                │ Subcommands (init, status, verify, audit)     ▼ (Exit 0 or 2)
                │                                     ┌────────────────────┐
                │                                     │  ctrlplane-hook    │
                │                                     │  (Fast CLI shim)   │
                │                                     └─────────┬──────────┘
                │                                               │
                │ IPC: UNIX Domain Socket / Windows Named Pipe   │
                └───────────────────────┬───────────────────────┘
                                        ▼
                      ┌───────────────────────────────────┐
                      │         ctrlplane-daemon          │
                      │  • In-Memory Ring Buffer          │
                      │  • Policy Engine Evaluator        │
                      │  • SQLite WAL Database Writer     │
                      │  • Two-Tier Verifier Runner       │
                      └─────────────────┬─────────────────┘
                                        ▼
                      ┌───────────────────────────────────┐
                      │         .ctrlplane/ Storage       │
                      │  • audit.db (SQLite WAL)          │
                      │  • spec.md & policies.yaml        │
                      │  • blobs/ (compressed payloads)   │
                      └───────────────────────────────────┘
```

---

## 3. Functional Requirements

### 3.1 Developer CLI Commands Matrix

| Command | Arguments / Flags | Description |
|---|---|---|
| `ctrlplane init` | `[--agent=claude\|codex\|opencode\|all]` | Initializes repository: creates `.ctrlplane/` templates and idempotently injects hooks into agent config. |
| `ctrlplane start` | `[--foreground]` | Starts the local supervisor daemon in the background (or foreground for debugging). |
| `ctrlplane stop` | None | Gracefully shuts down the running daemon. |
| `ctrlplane status` | `[--json]` | Shows daemon health, active session, Git branch, active spec, and event counts. |
| `ctrlplane spec new` | `[--from-prompt="..."]` | Generates a new `.ctrlplane/spec.md` template or bootstraps criteria. |
| `ctrlplane spec approve` | None | Computes specification hash, records developer approval, and locks baseline commit. |
| `ctrlplane verify` | `[--tier1-only] [--strict]` | Runs deterministic checks and AI semantic verification against the active spec. |
| `ctrlplane explain` | `[--quiz]` | Generates diff risk analysis, blast radius, and optional comprehension questions. |
| `ctrlplane audit list` | `[--limit=10]` | Lists recent agent sessions with duration, status, and tool counts. |
| `ctrlplane audit show` | `<session-id> [--diff]` | Replays full chronological event timeline of a session. |
| `ctrlplane hook` | `<event_name>` | **Internal binary entrypoint** called by agent harnesses via stdin. |

### 3.2 Agent Configuration Ingestion & Injection (`ctrlplane init`)
The initialization command inspects existing user settings and performs non-destructive merges:
* **Claude Code (`.claude/settings.json`):**
  * Reads existing `hooks` object.
  * Injects entries into `PreToolUse`, `PostToolUse`, `Stop`, and `UserPromptSubmit` pointing to `npx ctrlplane hook <event>`.
  * Preserves any existing user-defined hooks by appending rather than replacing.
* **OpenAI Codex CLI (`.codex/hooks.json`):**
  * Registers hook commands with the required JSON response protocol.
* **OpenCode (`opencode.json`):**
  * Registers `@ctrlplane/opencode-plugin` in the plugins array.

### 3.3 Fast Hook Shim (`ctrlplane-hook`) Execution Budget
To prevent perceptible latency during rapid agent loops:
1. `ctrlplane-hook` is compiled to a standalone executable or optimized Node script with zero heavy module imports.
2. It immediately connects to the daemon via local socket:
   * Serializes stdin payload.
   * Transmits over local IPC.
   * Awaits single-frame binary/JSON response.
3. If the daemon responds within $15\text{ms}$ with `DENY`, the hook writes the denial reason to `stderr` and exits with **`code 2`**.
4. If daemon fails to respond within $50\text{ms}$:
   * In `CTRLPLANE_MODE=dev` (default): Prints `[ctrlplane warning] supervisor daemon timeout, failing open` to `stderr` and exits **`0`**.
   * In `CTRLPLANE_MODE=ci`: Exits **`2`** (fail-close).

---

## 4. Data Models & TypeScript Schemas

```typescript
import { z } from "zod";

export const DaemonStatusSchema = z.object({
  pid: z.number().int(),
  uptimeSeconds: z.number(),
  ipcPath: z.string(),
  activeSessionId: z.string().nullable(),
  databaseSizeBytes: z.number().int(),
  connectedAgentsCount: z.number().int(),
});

export const AgentHookPayloadSchema = z.object({
  hookEventName: z.enum([
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SessionStart",
    "SessionEnd",
  ]),
  sessionId: z.string().optional(),
  cwd: z.string(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolResponse: z.record(z.unknown()).optional(),
  prompt: z.string().optional(),
});

export const HookVerdictResponseSchema = z.object({
  exitCode: z.literal(0).or(z.literal(2)),
  stderrMessage: z.string().optional(),
  stdoutMessage: z.string().optional(),
  latencyMs: z.number(),
});

export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
export type AgentHookPayload = z.infer<typeof AgentHookPayloadSchema>;
export type HookVerdictResponse = z.infer<typeof HookVerdictResponseSchema>;
```

---

## 5. Failure Modes & Edge Cases

1. **Daemon Not Running During Agent Invocation:**
   * If an agent runs a tool and `ctrlplane-hook` cannot connect to the UNIX socket / named pipe:
   * It attempts an auto-spawn of the daemon in the background (`ctrlplane start --daemon`).
   * If auto-spawn fails, it defaults to the configured failure mode (`fail-open` in dev, `fail-close` in CI).
2. **Corrupted Agent Settings Files:**
   * Before modifying `.claude/settings.json` or `.codex/hooks.json`, `ctrlplane init` creates a backup copy (`.claude/settings.json.bak.<timestamp>`).
   * If JSON parsing fails due to existing syntax errors, it aborts without modifying and reports the exact syntax error line to the developer.

---

## 6. Acceptance Criteria

- [ ] **AC-CORE-1:** Running `ctrlplane init` creates `.ctrlplane/` with default `spec.md`, `policies.yaml`, and registers hooks in `.claude/settings.json` without deleting existing hooks.
- [ ] **AC-CORE-2:** The daemon starts in the background and writes its PID and socket path to `.ctrlplane/daemon.lock`.
- [ ] **AC-CORE-3:** `ctrlplane status` reports active daemon health, IPC status, and current session ID.
- [ ] **AC-CORE-4:** `ctrlplane-hook` completes IPC roundtrip and returns exit code within $\le 15\text{ms}$ under standard load.
- [ ] **AC-CORE-5:** In dev mode, if the daemon is killed, subsequent agent tool calls fail open with a visible terminal warning rather than blocking execution.

