# Pitfalls

Traps that have already bitten this codebase. Grep this file for a function or file name before you change it.

## P-1 · Non-erasable TypeScript passes `tsc` and crashes Node

Node strips types, it does not compile. Parameter properties, `enum`, `namespace` and `import x = require()` all produce runtime code, so Node refuses the file with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. `erasableSyntaxOnly` in `tsconfig.json` turns this into a typecheck error. Never turn it off. (`ISSUE.md` → I-1)

## P-2 · A test that writes to `process.cwd()` writes into the repo

Tests run from the repo root. A test that needs a project folder, a database file or a blob folder makes its own folder with `mkdtempSync(join(tmpdir(), "ctrlplane-<area>-"))`. The `:memory:` store already keeps its blobs outside the project. (`ISSUE.md` → I-2, I-3)

## P-3 · Per-package tsconfig files make the editor disagree with CI

Workspace packages are symlinked under `node_modules/@ctrlplane/*`. A package-level `tsconfig.json` with `extends` is read again through that symlink path, and the editor reports errors the root typecheck never sees. Keep one root config. (`ISSUE.md` → I-4)

## P-4 · Claude Code transcripts nest everything under `message`

A transcript line is `{type, message: {role, model, content, usage}, timestamp, ...}`. A `user` line that only carries `tool_result` blocks is the tool's answer, not a new prompt. Test any transcript reader on the nested format. (`ISSUE.md` → I-5)

## P-5 · A server left running keeps `node --test` alive

If an assertion throws before `daemon.stop()`, the open IPC server keeps the test process alive until the global timeout. Start servers inside `try` and stop them in `finally`. Give every test client a timeout.
