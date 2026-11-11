import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchHook,
  injectClaudeHooks,
  injectCodexHooks,
  injectOpenCodePlugin,
  removeClaudeHooks,
} from "../src/index.ts";
import { rmSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HookClient fails open in dev mode when daemon is not running", async () => {
  const res = await dispatchHook(
    {
      hookEventName: "PreToolUse",
      cwd: "/nonexistent/path",
      toolName: "Bash",
      toolInput: { command: "ls" },
    },
    { projectPath: "/nonexistent/path", ciMode: false }
  );

  assert.equal(res.exitCode, 0);
  assert.equal(res.decision, "ALLOW");
  assert.ok(res.stderrMessage?.includes("failing open"));
});

test("HookClient fails close in CI mode when daemon is not running", async () => {
  const res = await dispatchHook(
    {
      hookEventName: "PreToolUse",
      cwd: "/nonexistent/path",
      toolName: "Bash",
      toolInput: { command: "ls" },
    },
    { projectPath: "/nonexistent/path", ciMode: true }
  );

  assert.equal(res.exitCode, 2);
  assert.equal(res.decision, "DENY");
  assert.ok(res.stderrMessage?.includes("fail-close"));
});

test("ClaudeAdapter writes Claude Code's real hook shape into settings.local.json and merges non-destructively", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ctrlplane-claude-"));
  rmSync(tmpDir, { recursive: true, force: true });
  const claudeDir = join(tmpDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "./my-custom-script.sh" }] };
  writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ theme: "dark", hooks: { PreToolUse: [userHook] } }, null, 2));
  // An entry in the old, wrong shape from an earlier ctrlplane init, sitting in the shared file.
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "*", command: "npx ctrlplane hook PreToolUse" }] } }, null, 2),
  );

  const result = injectClaudeHooks(tmpDir, "ctrlplane hook");
  assert.equal(result.success, true);
  assert.ok(result.settingsPath.endsWith("settings.local.json"));
  assert.ok(result.backupPath);

  const updated = JSON.parse(readFileSync(result.settingsPath, "utf8"));
  assert.equal(updated.theme, "dark");
  assert.equal(updated.hooks.PreToolUse.length, 2);
  assert.deepEqual(updated.hooks.PreToolUse[0], userHook);
  const ours = updated.hooks.PreToolUse[1];
  assert.equal(ours.matcher, "*");
  assert.equal(ours.hooks[0].type, "command");
  assert.equal(ours.hooks[0].command, "ctrlplane hook PreToolUse");
  assert.equal(typeof ours.hooks[0].timeout, "number");
  for (const event of ["PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "PreCompact"]) {
    assert.ok(Array.isArray(updated.hooks[event]), event);
  }

  const shared = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  assert.equal(shared.model, "x");
  assert.equal(shared.hooks, undefined, "legacy wrong-shaped entry removed from settings.json");

  const before = readFileSync(result.settingsPath, "utf8");
  const result2 = injectClaudeHooks(tmpDir, "ctrlplane hook");
  assert.equal(result2.addedHooksCount, 0);
  assert.equal(readFileSync(result.settingsPath, "utf8"), before);

  assert.ok(removeClaudeHooks(tmpDir) > 0);
  const afterRemove = JSON.parse(readFileSync(result.settingsPath, "utf8"));
  assert.deepEqual(afterRemove.hooks.PreToolUse, [userHook]);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("Codex hooks use the grouped shape and OpenCode gets a real plugin file", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ctrlplane-agents-"));
  rmSync(tmpDir, { recursive: true, force: true });

  const codexRes = injectCodexHooks(tmpDir, "ctrlplane hook");
  assert.equal(codexRes.success, true);
  assert.equal(codexRes.addedHooksCount, 5);
  const codex = JSON.parse(readFileSync(codexRes.hooksPath, "utf8"));
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, "ctrlplane hook PreToolUse --agent codex");
  assert.equal(injectCodexHooks(tmpDir, "ctrlplane hook").addedHooksCount, 0);

  const openCodeRes = injectOpenCodePlugin(tmpDir, "ctrlplane hook");
  assert.equal(openCodeRes.success, true);
  assert.equal(openCodeRes.pluginAdded, true);
  const oc = JSON.parse(readFileSync(openCodeRes.configPath, "utf8"));
  assert.deepEqual(oc.plugin, ["./plugins/ctrlplane.mjs"]);
  const plugin = readFileSync(openCodeRes.pluginPath, "utf8");
  assert.ok(plugin.includes("tool.execute.before"));
  assert.ok(plugin.includes('"ctrlplane hook"'));

  rmSync(tmpDir, { recursive: true, force: true });
});
