# AgentDock

AgentDock supervises AI coding agents that other programs run: it judges each tool call before it happens, keeps the record of what happened, and carries context from one session to the next.

## Language

**Agent**:
The AI model working inside an agent harness, whose tool calls AgentDock judges.
_Avoid_: bot, assistant

**Agent harness**:
The program that runs an agent and carries out its tool calls, such as Claude Code, Codex or OpenCode. AgentDock is never one.
_Avoid_: runner, orchestrator, executor

**Tool call**:
One action an agent asks its harness to perform, such as running a command or editing a file.
_Avoid_: action, operation, request

**Session**:
One run of an agent in a harness, from its start to its end, as the harness reports it.
_Avoid_: run, conversation, job

**Supervision**:
AgentDock judging an agent's tool calls and recording them, without running the agent.
_Avoid_: orchestration, execution, control plane

**Audit trail**:
The local record of every tool call AgentDock saw and the verdict it gave, kept per project.
_Avoid_: immutable log, ledger

**Project policy**:
The rule settings committed with a repository, shared by everyone who clones it; they can only make supervision stricter.
_Avoid_: team policy, org policy
