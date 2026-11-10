# AI Development Control Plane — Specifications Overview

**Status:** Awaiting Developer Manual Review  
**Version:** 0.1.0-draft  
**Target System:** `@ctrlplane` — Local-first supervision, verification, and auditability for AI coding agents

---

## 1. Specification Index

This directory contains the detailed engineering specifications for each module of the AI Development Control Plane. Each document defines the functional requirements, schemas, edge cases, error handling, and testable acceptance criteria for its respective domain.

| Document | Feature Module | Core Responsibility |
|---|---|---|
| [01-intent-management.md](file:///d:/Workspace/specs/01-intent-management.md) | **Intent Management** | Ingest developer requirements, parse structured acceptance criteria, manage spec/plan versions, and preserve approvals. |
| [02-agent-supervision-and-policy.md](file:///d:/Workspace/specs/02-agent-supervision-and-policy.md) | **Agent Supervision & Policy Engine** | Intercept agent lifecycle events (`PreToolUse`, `PostToolUse`), enforce safety/anti-tamper policies, protect existing tests, and steer context. |
| [03-independent-verification-engine.md](file:///d:/Workspace/specs/03-independent-verification-engine.md) | **Independent Verification Engine** | Two-tier verification: Tier 1 deterministic checks (tests, linter, compiler, test-tamper detection) + Tier 2 evidence-backed semantic evaluation. |
| [04-audit-trail-and-event-pipeline.md](file:///d:/Workspace/specs/04-audit-trail-and-event-pipeline.md) | **Audit Trail & Event Pipeline** | Sub-15ms IPC ingestion pipeline, SQLite WAL persistence, automated secret redaction, and session replay/export. |
| [05-code-explanation-and-learning.md](file:///d:/Workspace/specs/05-code-explanation-and-learning.md) | **Code Explanation & Learning** | Delta-focused diff explanations, risk analysis, dependency audits, and interactive Socratic comprehension checks without hallucinating agent intent. |
| [06-core-daemon-and-cli.md](file:///d:/Workspace/specs/06-core-daemon-and-cli.md) | **Core Daemon, CLI & Adapters** | Local background daemon, UNIX socket/named-pipe server, developer CLI, agent configuration injectors (Claude Code, Codex, OpenCode). |

---

## 2. Global Architectural Principles

Across all specifications, the following invariants are strictly enforced:

1. **Local-First & Zero Mandatory Cloud:** All data, audit logs, and deterministic verification run locally on the developer's workstation. No external network requests occur unless configured to call a hosted LLM for Tier 2 verification.
2. **Untrusted Agent Assumption:** The system never treats an agent's self-reported "I have completed all tasks" as ground truth. Only deterministic checks and concrete code evidence validate completion.
3. **Strict Separation of Observable Telemetry vs. Summaries:** Raw, unedited agent inputs and outputs are preserved separately from AI-generated summaries or verifier reports.
4. **Latency Budget:** Hook execution overhead on the developer's agent loop must not exceed **15ms** for synchronous `PreToolUse` evaluation.
5. **Fail-Open for Local Dev, Fail-Close for CI:** If the supervisor daemon crashes or becomes unresponsive during local interactive development, the hook wrapper warns the developer and allows the command to proceed rather than freezing the terminal. In CI environments, any supervisor failure aborts the pipeline.

