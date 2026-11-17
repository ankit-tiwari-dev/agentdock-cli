# Skill picker: skills for Claude Code in this repo

Claude Code loads each folder here that holds a `SKILL.md` and uses it when the task matches its description.

## Written for this repo

- `agentdock-cli`: trying a command, hook or rule change by hand in a throwaway project, and what the hook's exit codes mean.
- `agentdock-ci`: every GitHub check, the local command that reproduces it, releases, and the rules CI enforces.

## Copied from other projects

Kept exactly as published, each with its license file, so they can be compared with or updated from the source. Prettier skips these folders (`.prettierignore`).

| Skill                          | Source                                                                                                                                      | Commit    | License         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------- |
| systematic-debugging           | [obra/superpowers](https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/systematic-debugging)           | `22f0b46` | MIT (`LICENSE`) |
| test-driven-development        | [obra/superpowers](https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/test-driven-development)        | `22f0b46` | MIT (`LICENSE`) |
| verification-before-completion | [obra/superpowers](https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/verification-before-completion) | `22f0b46` | MIT (`LICENSE`) |

To update one, fetch the same files at a newer commit, read every file before replacing the folder, and change the commit in this table.

## How the copied skills apply here

- The repo's `CLAUDE.md` and the developer's own instructions win over any skill.
- The copied skills refer to each other with a `superpowers:` prefix (for example `superpowers:test-driven-development`). Here the names have no prefix.
- `test-driven-development` says to delete code written before its test. Ask the developer before deleting anything they did not ask to delete.
- `systematic-debugging/find-polluter.sh` runs `npm test` one file at a time. Run it only when asked.
