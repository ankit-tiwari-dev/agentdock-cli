import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLI_COMMAND_SAFETY, isSupervisorOffSwitch } from "../../policy-engine/src/default-rules.ts";

const CLI_SOURCE = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

test("every command cli.ts dispatches is classified in CLI_COMMAND_SAFETY", () => {
  const commands = [...CLI_SOURCE.matchAll(/^\s*case "([a-z][\w-]*)":/gm)].map((m) => m[1]);
  assert.ok(commands.length > 10, "found the dispatch switch in cli.ts");
  const missing = commands.filter((c) => !Object.hasOwn(CLI_COMMAND_SAFETY, c));
  assert.deepEqual(
    missing,
    [],
    `classify these in CLI_COMMAND_SAFETY (packages/policy-engine/src/default-rules.ts): an agent must not be able to switch supervision off with a new command`,
  );
});

test("regression: an off-switch inside an interpreter one-liner is caught for every listed command", () => {
  // The raw-text pattern was a second, hand-kept list that lacked init, handoff and spec approve.
  for (const command of [
    "init",
    "spec approve",
    "handoff write note",
    "stop",
    "supervisor use claude",
    "memory add x",
  ]) {
    assert.equal(
      isSupervisorOffSwitch(`node -e "require('child_process').execSync('ctrlplane ${command}')"`),
      true,
      command,
    );
    assert.equal(isSupervisorOffSwitch(`ctrlplane ${command}`), true, command);
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
