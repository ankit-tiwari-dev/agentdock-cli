---
name: agentdock-cli
description: Use when changing a ctrlplane command, a hook, or a policy rule in agentdock-cli. How to try the change by hand in a throwaway project before and after the tests, and what the hook's exit codes and output mean.
---

# Trying a CLI change by hand

The rules a change must keep are in `CLAUDE.md` at the repo root (hook timeout, fail-closed CI mode, the off-switch list, context is information). This skill is the hands-on check that comes on top of the tests.

## 1. A throwaway project

Never point a manual check at this repo or at a real project: the hook writes `.ctrlplane/audit.db` into the project it finds.

```bash
T=$(mktemp -d); mkdir -p "$T/proj/.ctrlplane" "$T/home"
export CTRLPLANE_HOME="$T/home"   # user-level state goes here, not in ~/.ctrlplane
R="$(pwd)"                        # this repo
cd "$T/proj"
```

The hook finds the project by walking up from the working folder to the first `.ctrlplane` folder (`packages/daemon/src/lock.ts`).

## 2. Ask a rule directly

```bash
node "$R/packages/cli/src/bin.ts" policies test --command "git push --force origin main" --expect deny; echo "rc=$?"
```

It prints the decision, the rule id and the reason. With `--expect`, a different decision exits 1, so it works as a quick check in a script.

## 3. Send a hook payload

The agent pipes one JSON object to `ctrlplane hook <event>`. Claude Code and Codex use snake_case fields (`packages/core/src/hook-payload.ts`).

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | node "$R/packages/cli/src/bin.ts" hook PreToolUse --agent claude-code; echo "rc=$?"
```

What comes back (`packages/agent-adapters/src/hook-output.ts`):

| Verdict                                 | Exit code | Output                                              |
| --------------------------------------- | --------- | --------------------------------------------------- |
| Allow                                   | 0         | nothing, or JSON with `additionalContext`           |
| Blocked (PreToolUse)                    | 2         | the reason on stderr, prefixed `[ctrlplane]`        |
| Blocked (UserPromptSubmit, PostToolUse) | 0         | JSON `{"decision":"block", ...}` on stdout          |
| Needs approval, Claude Code             | 0         | JSON with `permissionDecision: "ask"`               |
| Needs approval, other agents            | 2         | "Developer approval required" on stderr             |
| Guidance (INSTRUCT)                     | 0         | JSON whose `additionalContext` carries the guidance |

## 4. Read what was recorded

```bash
node "$R/packages/cli/src/bin.ts" audit list
```

Then clean up: `cd "$R"; rm -rf "$T"; unset CTRLPLANE_HOME`.

## After the manual check

- A rule change needs a test in `packages/policy-engine/tests/`, and a bug fix a `regression: ...` test that fails on the old code (follow the `test-driven-development` skill).
- Run `make ci` and read its exit code (the `agentdock-ci` skill).
