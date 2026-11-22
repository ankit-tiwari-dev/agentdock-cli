import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONTEXT_EVENTS, auditDbPath, ctrlplaneHome, daemonLockPath, projectPolicyPath } from "../src/index.ts";

test("regression: an empty CTRLPLANE_HOME means the default folder, for every reader", () => {
  // config.ts used `??` and command-checks.ts used `||`, so an empty value pointed one at "policies.json" in the
  // current folder while the self-tamper rule protected ~/.ctrlplane.
  assert.equal(ctrlplaneHome({ CTRLPLANE_HOME: "" }, "/home/dev"), join("/home/dev", ".ctrlplane"));
  assert.equal(ctrlplaneHome({}, "/home/dev"), join("/home/dev", ".ctrlplane"));
  assert.equal(ctrlplaneHome({ CTRLPLANE_HOME: "/state" }, "/home/dev"), "/state");
});

test("project state paths all sit in the project's .ctrlplane folder", () => {
  assert.equal(auditDbPath("/p"), join("/p", ".ctrlplane", "audit.db"));
  assert.equal(daemonLockPath("/p"), join("/p", ".ctrlplane", "daemon.lock"));
  assert.equal(projectPolicyPath("/p", "local"), join("/p", ".ctrlplane", "policies.local.json"));
  assert.ok(CONTEXT_EVENTS.has("SessionStart") && !CONTEXT_EVENTS.has("PreToolUse"));
});
