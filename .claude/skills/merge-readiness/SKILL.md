---
name: merge-readiness
description: Use when asked whether an agentdock-cli pull request can merge ("ready to merge?", "check before I merge"). Report-only - CI green on the head commit, conflicts with main now and for every PR stacked on it, DECISIONS/PITFALLS/ISSUE number collisions across open PRs, and release-tag impact. Recommends the merge method; never merges.
---

# Can this PR merge?

The PR number comes in `$ARGUMENTS`. This skill reads and reports. It never merges, never turns on auto-merge, never pushes, never retargets a PR and never creates a branch. It may propose fixes, which the developer applies or approves.

## 1. The PR

```bash
git fetch origin
gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision
```

A draft or a closed PR is not ready. Say so and stop.

## 2. CI on the head commit

```bash
gh pr checks <n>
gh api "repos/{owner}/{repo}/commits/<headRefOid>/check-runs" --jq '.check_runs[] | [.name, .status, .conclusion] | @tsv'
```

- Every check must have run on `headRefOid`, the current head. A green run on an older commit does not count.
- A pending, failed or cancelled check is a blocker. For a failure, name the first error (`gh run view <run-id> --log-failed`).

## 3. Conflicts now

`git merge-tree` merges in memory and touches no file or branch:

```bash
git merge-tree --write-tree --name-only origin/<baseRefName> origin/<headRefName>; echo "rc=$?"
```

rc 0 is clean. rc 1 lists the conflicting files. When the base is not `main`, check against `origin/main` too.

## 4. Every PR stacked on this one

```bash
gh pr list --state open --json number,baseRefName,headRefName
```

Find each open PR whose base is this PR's head branch, then the PRs on top of those. When step 3 was clean, simulate this PR merging first, then check each upper PR against the result:

```bash
T=$(git merge-tree --write-tree origin/<baseRefName> origin/<headRefName>)
M=$(git commit-tree "$T" -p origin/<baseRefName> -p origin/<headRefName> -m simulated)
git merge-tree --write-tree --name-only "$M" origin/<upperHeadRefName>; echo "rc=$?"
```

`commit-tree` only writes an unreferenced object; no branch moves. Report each upper PR as clean or with its conflicting files.

## 5. Number collisions

New entries in `docs/DECISIONS.md` (`D-`), `docs/PITFALLS.md` (`P-`) and `ISSUE.md` (`I-`) must not take a number that `main` or another open PR also takes.

```bash
git diff origin/main...origin/<headRefName> -- docs/DECISIONS.md docs/PITFALLS.md ISSUE.md | grep -E '^\+## (D|P|I)-[0-9]+'
```

Run the same for every other open PR. A number used twice is a collision. Propose renumbering it in the PR that merges later, and fixing every link to it.

## 6. Release-tag impact

- The PR changes `version` in the root `package.json`: after merge, a tag `v<version>` runs `.github/workflows/release.yml`, which checks the tag against that version. Check that the tag does not exist yet: `git ls-remote --tags origin "v<version>"`. Tag only after the owner says yes, and never move or re-push a tag.
- The PR changes what users see (a command, an option, a rule's verdict) and leaves the version alone: say so. The owner decides whether it waits for the next release.

## 7. Merge method

- One PR on `main`: the owner's choice.
- **A stack:** recommend "Create a merge commit", lowest PR first. A squash puts the lower PR on `main` as one new commit, so the upper PR still carries the original commits and conflicts with that squashed copy of its own work. A merge commit keeps the original commits on `main`, so the upper PR only adds its own.

## 8. Report

| Check | Result | Evidence | Proposed fix |
| ----- | ------ | -------- | ------------ |

One row each for: CI on head, review state, conflicts with base, conflicts with `main`, each stacked PR, number collisions, release tag. Last line: `READY` or `NOT READY`, with the blockers in the order to fix them.
