---
name: cleanup
description: Use to close one open ISSUE.md item in agentdock-cli - check it still applies, map what it touches, make the smallest fix, verify with `make ci`, and mark it FIXED. Not for a new bug (use `fix`) or for finding problems (use `audit`).
tools: Bash, Read, Edit, Write, Grep, Glob
---

Close one open `ISSUE.md` item. Do not commit unless asked.

## 1. Pick the item

- An argument (`I-<n>`): that item.
- Nothing: list the items still `FOUND` or `IN PROGRESS` (`grep -nE "^## I-[0-9]+ · (FOUND|IN PROGRESS)" ISSUE.md`). Propose the one with the smallest blast radius and wait for a yes.
- When the entry says the developer must choose an approach first, stop. Lay out the choices and ask. Do not pick one yourself.
- When it waits on something outside the repo (an upstream release, an alert), report that and stop.

## 2. Check that it still applies

- Read every file:line the entry names, at `HEAD`.
- Reproduce the symptom: a test, a command, or a throwaway project (`agentdock-cli` skill).
- Already gone: find the commit with `git log -S "<code>" -- <file>`. Mark the entry `FIXED` with that commit and how you checked. Stop.

## 3. Map the blast radius

- Grep every caller of what you will change: `grep -rn "<name>" packages scripts`.
- Grep the tests that cover it, and the docs that mention it (`docs/`, `README.md`, `CLAUDE.md`, `.claude/skills/`).
- Grep `docs/PITFALLS.md` and `docs/DECISIONS.md` for the names. A fix that goes against a decision needs a new decision entry: stop and ask.
- Write the list down: each file, and why it is affected.

## 4. Plan

Three to six small steps, plain words. Name the test that proves the fix. Wait for a yes when the plan touches more than the files the entry names.

## 5. Fix

- Set the entry to `IN PROGRESS`.
- A behaviour bug: write a `regression: ...` test first and watch it fail on the current code.
- Make the smallest change. Keep the `CLAUDE.md` invariants. No changes beyond the item.

## 6. Verify

```bash
node --test --test-timeout=60000 packages/<pkg>/tests/<file>.test.ts; echo "rc=$?"
make ci > "$(mktemp -d)/ci.log" 2>&1; echo "make ci rc=$?"
```

Read each exit code before anything else. Never pipe `make` into `tail`.

## 7. Close

- Set the entry to `FIXED`. Add **Fix:** (what changed, with paths) and **Verification:** (the test or command, and what it proved).
- Update each doc from step 3 that now contradicts the code.
- A trap others will repeat goes into `docs/PITFALLS.md` as `P-<next>`.

## 8. Report

The item, whether it still applied, the blast-radius list, each changed file, and `make ci` rc with the test counts.
