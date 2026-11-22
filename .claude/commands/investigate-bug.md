---
description: Investigate a bug in agentdock-cli - collect the ground truth (audit.db, hook output and exit code, daemon log), find the stage where it goes wrong, then fix it at the root with a regression test.
argument-hint: <what you saw, e.g. "rm -rf ~ was allowed" or "hook calls missing from audit list">
---

Investigate: $ARGUMENTS

Facts first, theories second. Do not change code until step 4.

## 1. Write down the symptom

- The exact command, prompt or tool call, what was expected, and what happened.
- The agent (Claude Code, Codex, OpenCode), the OS, and `node -v`.
- The variables that change the hook's path: `CI`, `CTRLPLANE_MODE`, `CTRLPLANE_NESTED`, `CTRLPLANE_HOME`.

## 2. Collect the ground truth

Read only. Never write into a real project's `.ctrlplane/`. `ctrlplane audit` opens the database for writing (it can add a column), so do not run it on a real project.

**What was recorded.** Copy the database to a temp folder and read the copy, read-only:

```bash
C=$(mktemp -d); cp <project>/.ctrlplane/audit.db* "$C/"
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare('SELECT datetime(created_at/1000,\'unixepoch\') AS at,event_type,tool_name,policy_verdict,rule_id,policy_reason FROM events ORDER BY created_at DESC LIMIT 20').all())" "$C/audit.db"
```

No row, the wrong verdict, the wrong `rule_id`, or an unredacted secret each point to a different stage.

**What the hook answered.** Replay the same payload in a throwaway project (the `agentdock-cli` skill, steps 1 and 3). Keep stdout, stderr and the exit code apart:

```bash
echo '<payload>' | node "$R/packages/cli/src/bin.ts" hook PreToolUse --agent claude-code > out.txt 2> err.txt; echo "rc=$?"
```

Compare with the table of verdicts and exit codes in that skill. `[ctrlplane hook error]` on stderr means the hook threw and blocked the call; `[ctrlplane warning]` means it threw on another event, or while paused, and let it through.

**What the daemon did.** In the affected project, read `.ctrlplane/daemon.lock` (PID and IPC address) and `.ctrlplane/daemon.log`. Check whether that PID is alive. No daemon means the hook ran the rules in its own process.

## 3. Find the failing stage

Check the stages in order. The first stage whose output is wrong holds the bug.

| Stage                    | Code                                                                                  | How to check                                    |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Payload read             | `packages/core/src/hook-payload.ts`, `packages/agent-adapters`                        | Log the normalized payload in a test            |
| Daemon or in-process     | `packages/agent-adapters/src/hook-client.ts`, `packages/cli/src/commands/hook-cmd.ts` | Daemon running? Did it answer in time? CI mode? |
| Rules                    | `packages/policy-engine` (`default-rules.ts`, `command-checks.ts`, `shell.ts`)        | `ctrlplane policies test --command "<cmd>"`     |
| Hook output              | `packages/agent-adapters/src/hook-output.ts`                                          | Exit code and stdout against the skill's table  |
| Storage                  | `packages/daemon/src/audit-record.ts`, `packages/storage/src/db.ts`, redaction        | The row read in step 2                          |
| Context for next session | `packages/context/src/pack.ts`                                                        | `ctrlplane context` in the throwaway project    |

Grep `docs/PITFALLS.md` and `ISSUE.md` for the files in that stage before you go further.

## 4. Fix at the root

- Reproduce in the throwaway project, or in a test with its own `mkdtemp` folder and `CTRLPLANE_HOME` inside it.
- Trace the cause to a line: `file:line → what happens`, until the answer is code.
- Then follow the `fix` agent from its step 1: the `ISSUE.md` entry, a failing `regression: ...` test, the smallest fix, `make ci` with its real exit code.

## 5. Report

- The symptom, the ground truth you collected, and the stage that failed.
- The root cause chain with file:line.
- The regression test, its failure on the old code and its pass now.
- `make ci` rc and the `ISSUE.md` id.

Clean up the throwaway project and the database copy: `rm -rf "$T" "$C"; unset CTRLPLANE_HOME`.
