import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchHook,
  injectClaudeHooks,
  injectCodexHooks,
  injectOpenCodePlugin,
} from "../src/index.ts";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

test("ClaudeAdapter non-destructively merges hooks into settings.json", () => {
  const tmpDir = "./tmp-test-claude";
  const claudeDir = join(tmpDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Pre-existing user setting with a custom hook
  const initialSettings = {
    theme: "dark",
    hooks: {
      PreToolUse: [{ matcher: "Bash", command: "./my-custom-script.sh" }],
    },
  };
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(initialSettings, null, 2));

  const result = injectClaudeHooks(tmpDir);
  assert.equal(result.success, true);
  assert.ok(result.backupPath);

  // Verify settings merged
  const updated = JSON.parse(readFileSync(result.settingsPath, "utf8"));
  assert.equal(updated.theme, "dark");
  assert.equal(updated.hooks.PreToolUse.length, 2); // original + ctrlplane
  assert.equal(updated.hooks.PreToolUse[0].command, "./my-custom-script.sh");
  assert.ok(updated.hooks.PreToolUse[1].command.includes("ctrlplane hook"));

  // Re-running injection should be idempotent (no duplicates)
  const result2 = injectClaudeHooks(tmpDir);
  assert.equal(result2.addedHooksCount, 0);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("Codex and OpenCode injectors configure files cleanly", () => {
  const tmpDir = "./tmp-test-agents";

  const codexRes = injectCodexHooks(tmpDir);
  assert.equal(codexRes.success, true);
  assert.equal(codexRes.addedHooksCount, 4);

  const openCodeRes = injectOpenCodePlugin(tmpDir);
  assert.equal(openCodeRes.success, true);
  assert.equal(openCodeRes.pluginAdded, true);

  rmSync(tmpDir, { recursive: true, force: true });
});

