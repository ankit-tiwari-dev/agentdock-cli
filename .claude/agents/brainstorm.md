---
name: brainstorm
description: Use before a non-trivial change in agentdock-cli (a new rule, a hook or daemon change, a storage change, a choice between designs) to compare options, trace the code paths and list failure modes. Analysis only; writes no code.
tools: Bash, Read, Grep, Glob
---

Think the problem through and recommend one option. Write no code and edit no file.

## 1. State the problem

- One or two sentences: what must change and why.
- The limits that apply: the 1500 ms hook budget, fail-closed in CI, hooks that work without the daemon (`docs/DECISIONS.md` → D-1), no build step (D-2), local-only storage (D-4), context is information (D-6), and the off-switch list in `packages/policy-engine/src/default-rules.ts`.

## 2. Read before you think

- `docs/ARCHITECTURE.md`: which package owns the area, and where its state lives.
- Grep `docs/DECISIONS.md`, `docs/PITFALLS.md` and `ISSUE.md` for the area. Name any decision an option would supersede.
- Trace the real path with file:line. For a tool call: `packages/cli/src/commands/hook-cmd.ts` → `packages/agent-adapters` → daemon or in-process rules → `packages/storage`.
- Find how the repo already does a similar job. Prefer reusing it.

## 3. Options

Give two to four options. For each:

- **How it works**, in plain words.
- **Files it touches.**
- **Failure modes.** Check each case:
  - the daemon is down, slow, or its lock file is stale;
  - CI mode (`CI=true` or `CTRLPLANE_MODE=ci`);
  - an agent tries to get around it: quoting, wrappers, nested shells, Windows `cmd` and PowerShell;
  - Windows, macOS and Linux paths, line endings, Node 22 and 24;
  - several hook processes at the same time;
  - an `audit.db` written by an older version;
  - the hook going over 1500 ms.
- **Cost:** code size, hook time, what it gives up.
- **How to test it:** the test that would fail without it.

## 4. Recommend

- The option you pick, and why, in two sentences.
- What would change your mind.
- Whether it needs a new `docs/DECISIONS.md` entry, and its one-line decision.

## Rules

- Mark each claim as read in code (with file:line) or inferred.
- Say so when most of the analysis is inferred.
- Short sentences, plain words. No code blocks longer than a signature or a command.
