# Feature Specification: Audit Trail & Event Pipeline

**Module ID:** `SPEC-04-AUDIT`  
**Package:** `@ctrlplane/storage`, `@ctrlplane/event-pipeline`  
**Status:** Ready for Review

---

## 1. Objective & Scope

The Audit Trail & Event Pipeline captures, sanitizes, and persistently records every observable event during an AI coding agent session. It guarantees:
1. **Low-Latency Ingestion:** Hook events are processed and acknowledged in $< 15\text{ms}$.
2. **Data Immutability & Forensic Integrity:** Complete history of prompts, tool calls, tool outputs, policy verdicts, and Git diffs is stored locally in SQLite with WAL (Write-Ahead Logging).
3. **Secret & Credential Redaction:** Sensitive credentials (`ANTHROPIC_API_KEY`, AWS keys, tokens, `.env` values) are stripped *prior* to disk persistence.
4. **Session Replay & Export:** Complete developer audit log exportable to JSON, Markdown, or SARIF formats.

---

## 2. Event Pipeline Architecture

```mermaid
flowchart LR
    A[Agent Lifecycle Hook] -->|stdin JSON| B[ctrlplane-hook]
    B -->|Local IPC: UNIX Socket / Named Pipe| C[ctrlplane-daemon]
    
    subgraph Ingestion Pipeline [ctrlplane-daemon Ingestion Pipeline (< 15ms)]
        C --> D[Zod Event Validator]
        D --> E[Secret & Token Redactor]
        E --> F[In-Memory Ring Buffer]
    end
    
    F -->|Synchronous ACK| B
    B -->|Exit 0 / 2| A
    
    subgraph Storage Worker [Async Background Batch Writer]
        F --> G[(SQLite Database with WAL)]
        G --> H[Blob Storage: Large Tool Outputs > 64KB]
    end
```

---

## 3. Functional Requirements

### 3.1 IPC Ingestion Protocol
* **Channel:** Local UNIX Domain Socket on macOS/Linux (`/tmp/ctrlplane-<pid>.sock`), Named Pipe on Windows (`\\.\pipe\ctrlplane-<pid>`).
* **Format:** Length-prefixed JSON frames.
* **Latency Guarantee:** Hook calls are pushed to an in-memory ring buffer and acknowledged to the CLI wrapper immediately, decoupling file I/O from agent execution.

### 3.2 Pre-Storage Secret Redaction Engine
Before writing any event to SQLite, strings in `tool_input`, `tool_output`, and `prompts` pass through a zero-allocation regex scanner matching:
* Known API key prefixes (`sk-ant-`, `sk-proj-`, `ghp_`, `gho_`, `xoxb-`, `AKIA[0-9A-Z]{16}`).
* High-entropy patterns in `.env` variable assignments (`[A-Z0-9_]+=[a-zA-Z0-9\-_./+=]{16,}`).
* RSA/SSH private keys (`-----BEGIN [A-Z ]+ PRIVATE KEY-----`).
* **Redacted Replacement:** Replaced with `[REDACTED_SECRET:<hash-prefix>]`.

### 3.3 Database Storage & Retention
* Stored in `.ctrlplane/audit.db` at the repository root.
* SQLite configured with `PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = NORMAL;`, and `PRAGMA busy_timeout = 5000;`.
* Large payloads ($> 64\text{KB}$) are compressed with zlib and stored as content-addressable blobs in `.ctrlplane/blobs/<sha256>`.

### 3.4 Audit Query & Session Replay CLI
* `ctrlplane audit list`: Lists all recent agent sessions with timestamp, duration, agent type, tool count, and status.
* `ctrlplane audit show <session-id>`: Displays an interactive or chronological timeline of prompts, tool calls, and diffs.
* `ctrlplane audit export <session-id> --format=json|markdown`: Generates an exportable forensic report for code review or compliance.

---

## 4. SQLite Schema & TypeScript Definitions

```sql
-- Core Session Registry
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,          -- 'claude-code', 'codex', 'opencode'
    project_path TEXT NOT NULL,
    git_branch TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    head_commit_sha TEXT,
    spec_id TEXT,
    status TEXT NOT NULL,              -- 'active', 'completed', 'aborted'
    started_at INTEGER NOT NULL,
    ended_at INTEGER
);

-- Event Stream
CREATE TABLE events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence_num INTEGER NOT NULL,
    event_type TEXT NOT NULL,          -- 'pre_tool', 'post_tool', 'user_prompt', 'notification'
    tool_name TEXT,
    tool_input_json TEXT,
    tool_output_json TEXT,
    is_blob_stored BOOLEAN DEFAULT 0,
    policy_verdict TEXT,              -- 'ALLOW', 'DENY', 'INSTRUCT', 'MANUAL'
    policy_reason TEXT,
    execution_duration_ms INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_events_session_seq ON events(session_id, sequence_num);

-- Git Diff & File Modification History
CREATE TABLE file_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_id TEXT REFERENCES events(id),
    file_path TEXT NOT NULL,
    is_test_file BOOLEAN NOT NULL DEFAULT 0,
    diff_unified TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

```typescript
import { z } from "zod";

export const AuditEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequenceNum: z.number().int().nonnegative(),
  eventType: z.enum(["pre_tool", "post_tool", "user_prompt", "stop", "notification"]),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolOutput: z.record(z.unknown()).optional(),
  policyVerdict: z.enum(["ALLOW", "DENY", "INSTRUCT", "REQUIRE_MANUAL_APPROVAL"]).optional(),
  policyReason: z.string().optional(),
  executionDurationMs: z.number().int().optional(),
  createdAt: z.number().int(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
```

---

## 5. Failure Modes & Edge Cases

1. **SQLite Database Lock (Concurrency):** When parallel tool calls arrive simultaneously, SQLite WAL mode handles concurrent readers, and the daemon serializes writes through a single worker queue.
2. **Sudden Process Crash:** If the agent process or machine is hard-terminated, SQLite WAL ensures database consistency upon restart without corrupted tables.
3. **Massive Tool Output Flooding:** If an agent accidentally runs `cat massive_file.bin` generating 50MB of terminal logs, the redaction and ingestion worker truncates the logged preview at 1MB and writes the remainder to a blob file with a clear warning flag.

---

## 6. Acceptance Criteria

- [ ] **AC-AUDIT-1:** The IPC server handles and acknowledges a hook event in $\le 15\text{ms}$.
- [ ] **AC-AUDIT-2:** High-entropy API tokens and private keys are redacted to `[REDACTED_SECRET:...]` prior to database insertion.
- [ ] **AC-AUDIT-3:** Session events are sequentially ordered and queryable via `ctrlplane audit show <id>`.
- [ ] **AC-AUDIT-4:** Diffs and file changes generated across all tool calls in a session are reconstructable into a cumulative Git patch.
- [ ] **AC-AUDIT-5:** SQLite operates in WAL mode with busy timeout handling, preventing lock contention under rapid tool calls.

