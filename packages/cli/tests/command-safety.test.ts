import test from "node:test";
import assert from "node:assert/strict";
import { CLI_COMMAND_SAFETY, isSupervisorOffSwitch } from "../../policy-engine/src/default-rules.ts";
import { COMMANDS } from "../src/cli.ts";

test("every command cli.ts dispatches is classified in CLI_COMMAND_SAFETY", () => {
  const missing = Object.keys(COMMANDS).filter((c) => !Object.hasOwn(CLI_COMMAND_SAFETY, c));
  assert.deepEqual(
    missing,
    [],
    `classify these in CLI_COMMAND_SAFETY (packages/policy-engine/src/default-rules.ts): an agent must not be able to switch supervision off with a new command`,
  );
});

test("every off-switch is caught as a command, and inside a one-liner unless its entry says matchInText: false", () => {
  for (const [name, safety] of Object.entries(CLI_COMMAND_SAFETY)) {
    if (safety === "safe") continue;
    const command =
      "offSwitch" in safety ? (safety.offSwitch === "all" ? name : `${name} ${safety.offSwitch[0]}`) : `${name} write`;
    assert.equal(isSupervisorOffSwitch(`ctrlplane ${command}`), true, command);
    const inText = isSupervisorOffSwitch(`node -e "require('child_process').execSync('ctrlplane ${command}')"`);
    assert.equal(inText, safety.matchInText !== false, `${command} inside a one-liner`);
  }
});

test("safe commands and safe sub-commands stay allowed, in both checks", () => {
  for (const command of [
    "status",
    "audit",
    "handoff show",
    "spec show",
    "memory list",
    "policies list",
    "supervisor status",
  ]) {
    assert.equal(isSupervisorOffSwitch(`ctrlplane ${command}`), false, command);
    assert.equal(isSupervisorOffSwitch(`node -e "execSync('ctrlplane ${command}')"`), false, command);
  }
});
