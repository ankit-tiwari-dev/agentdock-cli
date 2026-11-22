import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { handleAuditCommand } from "../src/commands/audit-cmd.ts";
import { handleSpecCommand } from "../src/commands/spec-cmd.ts";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-exit-"));
  mkdirSync(join(dir, ".ctrlplane"));
  return dir;
}

test("regression: a command that did not do what was asked exits non-zero", () => {
  // spec, audit, start, stop, status and explain returned strings and cli.ts printed them with exit 0 (I-39 class).
  const dir = project();
  try {
    assert.equal(handleSpecCommand("bogus", [], dir).exitCode, 1);
    assert.equal(handleAuditCommand("bogus", [], dir).exitCode, 1);
    assert.equal(handleAuditCommand("show", [], dir).exitCode, 1);
    assert.equal(handleAuditCommand("list", [], dir).exitCode, 0, "an empty log is information, not a failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown command fails with the help text; help itself succeeds", async () => {
  assert.equal(await runCli(["no-such-command"]), 1);
  assert.equal(await runCli(["help"]), 0);
  assert.equal(await runCli(["cost", "claude-sonnet-4-5", "lots", "1"]), 1);
});
