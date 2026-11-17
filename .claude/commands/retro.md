---
description: Look back at the task just finished in agentdock-cli - what went wrong or was redone - and save the lessons to auto-memory. Proposes a CLAUDE.md rule when a lesson has come up three times.
---

Run a short retrospective on the work in this session.

## 1. Collect what happened

Go through the session and list:

- each time the developer corrected you ("no", "wrong", "redo", "not that"), or undid an edit;
- each gate that failed, and each step you had to run again;
- each assumption that turned out false, such as a file, a command or a behaviour you guessed at;
- work you did that nobody asked for.

Skip what went to plan. With nothing to list, say so and stop.

## 2. Find the lesson in each

For each item:

- **What happened**, in one line.
- **Why:** the cause in how you worked, not in the code. For example: "edited before reading the callers", "reported green from piped output".
- **The rule** that would have prevented it, as one imperative sentence.

## 3. Check what is already known

- Read the auto-memory index for this repo: `MEMORY.md` in this project's folder under `~/.claude/projects/`.
- Grep root `CLAUDE.md` and `.claude/docs/rules.md` for the same rule.
- Already in `CLAUDE.md` or `rules.md`: the rule exists and was not followed. Note it, and do not add a copy.
- Already in memory: count this as one more time it happened.

## 4. Save new lessons to memory

- One file per lesson in the memory folder, named `feedback-<short-slug>.md`. It holds the rule, why it matters, and how to apply it next time.
- Add one line to `MEMORY.md`: a link to the file and a one-line summary.
- Update an existing file instead of making a near-copy. Record the date of each repeat.
- Never write personal details or other projects' names into a file in this repo.

## 5. Promote a rule after three repeats

A lesson that has now come up three times becomes a repo rule:

- Draft it as one line for root `CLAUDE.md`, or for `.claude/docs/rules.md` when it needs detail. Follow `rules.md` → Adding instructions.
- Show the exact line and where it goes. Write it only after the developer says yes.
- Then mark the memory file as promoted.

## 6. Report

| Lesson | Why it happened | Saved to | Count |
| ------ | --------------- | -------- | ----- |

Then any rule proposed for promotion, with its exact text.
