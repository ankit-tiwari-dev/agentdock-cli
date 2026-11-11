import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePauseCommand, handlePoliciesCommand, handleResumeCommand } from "../src/commands/policies-cmd.ts";

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-cli-"));
  mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  process.env.CTRLPLANE_HOME = join(dir, "user-home");
  return dir;
}

test("policies test exits 0 when the expectation holds and 1 when it does not", async () => {
  const dir = tempProject();
  try {
    const pass = await handlePoliciesCommand(
      "test",
      ["--command", "git push --force origin main", "--expect", "deny"],
      dir,
    );
    assert.equal(pass.exitCode, 0);
    assert.match(pass.output, /PASS/);
    const fail = await handlePoliciesCommand("test", ["--command", "npm test", "--expect", "deny"], dir);
    assert.equal(fail.exitCode, 1);
    assert.match(fail.output, /FAIL: expected deny, got allow/);
    const bad = await handlePoliciesCommand("test", ["--command", "ls", "--expect", "maybe"], dir);
    assert.equal(bad.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policies observe/disable write to the chosen scope, always-on rules refuse", async () => {
  const dir = tempProject();
  try {
    assert.equal((await handlePoliciesCommand("observe", ["RULE-ASK-SUDO", "--local"], dir)).exitCode, 0);
    const local = JSON.parse(readFileSync(join(dir, ".ctrlplane", "policies.local.json"), "utf8"));
    assert.equal(local.rules["RULE-ASK-SUDO"].mode, "observe");
    assert.equal(existsSync(join(dir, ".ctrlplane", "policies.json")), false);

    const after = await handlePoliciesCommand("test", ["--command", "sudo ls", "--expect", "allow"], dir);
    assert.equal(after.exitCode, 0);
    assert.match(after.output, /Observed: RULE-ASK-SUDO would ask/);

    const refused = await handlePoliciesCommand("disable", ["RULE-BLOCK-CTRLPLANE-MUTATION"], dir);
    assert.equal(refused.exitCode, 2);
    assert.match(refused.output, /always-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: policies set rejects a param name the rule does not have", async () => {
  const dir = tempProject();
  try {
    const typo = await handlePoliciesCommand("set", ["RULE-LARGE-FILE-WRITE", "maxBytes", "1024"], dir);
    assert.equal(typo.exitCode, 2);
    assert.match(typo.output, /Known: thresholdKb/);
    assert.equal(existsSync(join(dir, ".ctrlplane", "policies.json")), false);

    const ok = await handlePoliciesCommand(
      "set",
      ["RULE-GIT-PROTECTED-BRANCH-PUSH", "protectedBranches", '["main","release"]'],
      dir,
    );
    assert.equal(ok.exitCode, 0);
    const res = await handlePoliciesCommand("test", ["--command", "git push origin release", "--expect", "ask"], dir);
    assert.equal(res.exitCode, 0, res.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause shows in policies list, caps at 8h and resume clears it", async () => {
  const dir = tempProject();
  try {
    const paused = handlePauseCommand(["20h"], dir);
    assert.equal(paused.exitCode, 0);
    assert.match(paused.output, /capped/);
    assert.match((await handlePoliciesCommand("list", [], dir)).output, /PAUSED until/);
    assert.equal(handlePauseCommand(["later"], dir).exitCode, 2);
    assert.equal(handleResumeCommand(dir).output, "Supervision resumed.");
    assert.equal(handleResumeCommand(dir).output, "Supervision was not paused.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
