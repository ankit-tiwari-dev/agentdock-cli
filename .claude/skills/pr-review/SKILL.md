---
name: pr-review
description: Use when asked to review a GitHub pull request on agentdock-cli ("review PR 12", a PR URL, "review it again"). Reads the PR state, CI checks and stacked base with `gh`, checks the diff against CLAUDE.md invariants and docs/PITFALLS.md, drafts comments, and posts only after the developer says yes. Never approves or merges.
---

# Reviewing a pull request

The PR number or URL comes in `$ARGUMENTS`. This skill reads and drafts. It posts only after a yes, and it never approves, requests changes, merges or pushes.

## 1. Intake

```bash
gh pr view <n> --json number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,body,files,commits
gh pr checks <n>
```

- Closed or merged: say so and stop.
- **Stacked PR:** the base is not `main`. Review only the diff against its base. Name the PR it sits on (`gh pr list --head <baseRefName>`) and say it must merge first.
- **CI:** for each failing check, read `gh run view <run-id> --log-failed` and name the first real error. A pending check is not green.
- **Earlier rounds:** read `gh pr view <n> --comments` and the inline comments (`gh api repos/{owner}/{repo}/pulls/<n>/comments`). On "review it again", check each earlier comment first: fixed, not fixed, or answered with a reason.

## 2. Read the change

```bash
gh pr diff <n>
git fetch origin pull/<n>/head
git show FETCH_HEAD:<path>
```

Read each changed file in full at the PR head, not only the hunks. Do not check out the branch or create a branch or worktree.

Size the review: docs or config only gets a short pass. Anything on the hook path, the rules, storage or the context pack gets the full check.

## 3. Check

- Every item in the checklist of the `review` agent (`.claude/agents/review.md`, step 4): erasable TypeScript, one tsconfig, the 1500 ms hook budget, fail-closed in CI, `isOffSwitch` for anything that weakens supervision, context is information, `CTRLPLANE_NESTED`, `CTRLPLANE_HOME` isolation, exit codes, file races, test hygiene, pinned workflow actions, comments.
- Grep `docs/PITFALLS.md` for each changed file and function name. A change that walks into a known trap is a finding.
- Grep `docs/DECISIONS.md` for the area. An edited old entry is a finding; a change that goes against a decision needs a new entry.
- **Tests:** each bug fix has a `regression: ...` test. Read it and judge whether it would fail on the base code. When you cannot tell, say so in the finding.
- **Claims:** each claim in the PR description matches the diff. A change the description does not mention is a finding.
- **Numbers:** new `D-`, `P-` or `I-` numbers do not collide with `main` (`git show origin/main:docs/DECISIONS.md | grep "^## D-"`).
- **Release:** a change to the root `package.json` version means a tag will follow (`docs/DECISIONS.md` → D-8).

## 4. Draft the comments

For each finding:

- severity (Critical, High, Medium, Low, as in the `review` agent);
- `file:line` at the PR head;
- the problem, in plain words;
- the expected result, or the smallest fix.

Show the full draft to the developer: findings first, then what you checked and what you did not.

## 5. Post only after a yes

Post exactly the text the developer approved, as one review comment:

```bash
gh pr review <n> --comment --body-file <draft-file>
```

- Never use `--approve` or `--request-changes`. Never run `gh pr merge` or turn on auto-merge.
- To correct a comment you posted, edit it (`gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -f body=...`). Do not post a second one.
- Keep the draft file outside the repo (`mktemp -d`).
