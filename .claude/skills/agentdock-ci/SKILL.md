---
name: agentdock-ci
description: Use before pushing to agentdock-cli, before tagging a release, or when one of its GitHub checks fails. Maps every CI job to the local command that reproduces it, says how to read a failing job, and lists the repo rules CI enforces that are easy to miss.
---

# agentdock-cli CI

## Before you push

Run the whole local gate and read its exit code. A pipe (`make ci | tail`) reports the exit code of `tail`, so a red run looks green.

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

`make ci` runs, in CI's order: ESLint, the Prettier check, typecheck, `hygiene`, and every package's tests. Only `rc=0` counts as green.

## Each GitHub check and how to reproduce it

| Check (workflow)                                           | What it runs                               | Locally                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| lint, format, typecheck, hygiene, workflow lint (`ci.yml`) | `npm ci`, the four gates, then actionlint  | `make ci`, then `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color` (needs Go)                                       |
| test (ubuntu/windows/macos, node 22/24) (`ci.yml`)         | `npm ci`, `npm test` on six machines       | `npm test` on yours. See "Six machines" below                                                                                       |
| dev container (build, make ci, actionlint) (`ci.yml`)      | `make devcontainer-check`                  | Same command, needs Docker. Run it from a normal clone: in a git worktree the `.git` file points outside the mounted folder         |
| CodeQL (`security.yml`)                                    | Static analysis of the TypeScript          | No local copy. Read the alert on the PR                                                                                             |
| dependency review (`security.yml`, pull requests only)     | Flags new dependencies with known problems | `git diff origin/main -- package-lock.json` shows what was added                                                                    |
| known vulnerabilities (OSV) (`security.yml`)               | OSV scan of `package-lock.json`            | `go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0 scan source --config osv-scanner.toml --lockfile package-lock.json` |
| secret scan (full history) (`security.yml`)                | gitleaks over every commit                 | `go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --redact --no-banner --config .gitleaks.toml .`                              |

## Releases

Pushing a tag `v*` runs `release.yml`: the CI and security workflows again, then a check that the tag equals `v` + the `version` in the root `package.json`, then a source archive with `SHA256SUMS` and a signed build-provenance attestation, published as a GitHub Release. The attestation step needs the job's `id-token: write` and `attestations: write`; only that job has them. Bump the version in the same pull request, never re-push or move an existing tag, and only tag after the owner says yes.

## Six machines, one laptop

The test job runs on Linux, Windows and macOS. A test that passes on your machine can still fail on another one when it depends on:

- path separators (`\` and `/`): build paths with `node:path`, never by joining strings;
- line endings: `.gitattributes` stores every text file with LF;
- time zone and locale: compare timestamps as numbers, not as formatted text;
- a process left running or a file left open: stop servers and daemons, and close databases, in `finally`, or Windows cannot remove the `mkdtemp` folder and the test process never exits.

## Reading a failed check

```bash
gh pr checks <pr-number>
gh run view <run-id> --log-failed
```

Reproduce the failure locally before changing anything, then follow the `systematic-debugging` skill.

## Rules CI enforces that are easy to miss

- Every `uses:` in `.github/workflows/` names a full 40-character commit SHA, with the version in a trailing comment.
- `hygiene` (`scripts/hygiene.ts`) fails on: names that must never appear in the repo (stored only as hashes in that file), wording or paths from private planning documents, tracked build output or local state, CRLF in the index, unpinned images, a package without a test, and lockfile drift. It checks untracked files too.
- A security-scan exception goes in `osv-scanner.toml` or `.gitleaks.toml` with a reason (`CLAUDE.md`).
- The skill folders copied from other projects (listed in `.claude/skills/README.md`) are kept exactly as published, so Prettier skips them (`.prettierignore`). A new copied folder needs an entry there too.
