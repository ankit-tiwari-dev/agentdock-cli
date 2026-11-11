import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, statSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DAEMON_UNAVAILABLE,
  buildOpenCodePlugin,
  defaultHookCommand,
  dispatchHook,
  injectClaudeHooks,
  injectCodexHooks,
  injectOpenCodePlugin,
  isCtrlplaneCommand,
} from "../src/index.ts";
function projectWithLock(lock: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-client-"));
  mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), JSON.stringify(lock));
  return dir;
}
const payload = (cwd: string) => ({
  hookEventName: "PreToolUse" as const,
  cwd,
  toolName: "Bash",
  toolInput: { command: "rm -rf /" },
});
test("regression: a garbage ipcTarget in the lock falls back instead of throwing", async () => {
  const dir = projectWithLock({ pid: process.pid, ipcTarget: "nonsense:not-a-port" });
  try {
    const local = await dispatchHook(payload(dir), { projectPath: dir, ciMode: false });
    assert.equal(local.matchedRuleId, DAEMON_UNAVAILABLE);
    assert.equal(local.decision, "ALLOW");
    const ci = await dispatchHook(payload(dir), { projectPath: dir, ciMode: true });
    assert.equal(ci.decision, "DENY");
    assert.equal(ci.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: an unparseable daemon reply falls back to the local rules", async () => {
  const server = createServer((socket) => {
    socket.on("data", () => socket.end("this is not json\n"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const dir = projectWithLock({ pid: process.pid, ipcTarget: `127.0.0.1:${port}` });
  try {
    const res = await dispatchHook(payload(dir), { projectPath: dir, ciMode: false });
    assert.equal(res.matchedRuleId, DAEMON_UNAVAILABLE);
    const ci = await dispatchHook(payload(dir), { projectPath: dir, ciMode: true });
    assert.equal(ci.decision, "DENY");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: the OpenCode plugin blocks a tool call when the hook times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-ocplugin-"));
  try {
    const hook = `"${process.execPath}" -e "setTimeout(() => {}, 3000)"`;
    const source = buildOpenCodePlugin(hook).replace("timeout: 30000", "timeout: 300");
    assert.ok(source.includes("timeout: 300,"), "test relies on the plugin's spawn timeout");
    const file = join(dir, "plugin.mjs");
    writeFileSync(file, source);
    const mod = await import(pathToFileURL(file).href);
    const hooks = await mod.CtrlplanePlugin({ directory: dir });
    await assert.rejects(
      hooks["tool.execute.before"]({ sessionID: "s", tool: "bash" }, { args: { command: "rm -rf /" } }),
      /ctrlplane/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: init keeps a user's own hook whose command merely mentions 'ctrlplane hook'", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-userhook-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const mine = { matcher: "*", hooks: [{ type: "command", command: "~/bin/ctrlplane hook-audit.sh" }] };
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [mine] } }));
    injectClaudeHooks(dir, 'node "C:/x/packages/cli/src/bin.ts" hook');
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(after.hooks.PreToolUse[0], mine);
    assert.equal(after.hooks.PreToolUse.length, 2);
    for (const ours of [
      'node "C:/x/packages/cli/src/bin.ts" hook PreToolUse',
      "node /opt/agentdock/packages/cli/src/bin.ts hook Stop --agent codex",
      "npx ctrlplane hook PreToolUse",
      "npx -y @ctrlplane/cli hook SessionStart",
      "ctrlplane hook PreToolUse",
    ])
      assert.equal(isCtrlplaneCommand(ours), true, ours);
    for (const theirs of [
      "~/bin/ctrlplane hook-audit.sh",
      "/usr/local/bin/ctrlplane hook PreToolUse && ./notify.sh",
      "ctrlplane hooked",
      "./scripts/log.sh ctrlplane hook PreToolUse",
    ])
      assert.equal(isCtrlplaneCommand(theirs), false, theirs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: Codex install keeps the entries of an existing hooks array", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-codexarr-"));
  try {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: [
          { event: "PreToolUse", command: "./audit.sh" },
          { event: "Stop", command: "npx ctrlplane hook Stop" },
        ],
      }),
    );
    injectCodexHooks(dir, "ctrlplane hook");
    const after = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
    const pre = after.hooks.PreToolUse as { hooks: { command: string }[] }[];
    assert.ok(
      pre.some((g) => g.hooks.some((h) => h.command === "./audit.sh")),
      JSON.stringify(after),
    );
    const stopCommands = (after.hooks.Stop as { hooks: { command: string }[] }[]).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.deepEqual(stopCommands, ["ctrlplane hook Stop --agent codex"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: OpenCode install keeps a plugin given as a single string", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-ocstr-"));
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "opencode.json"), JSON.stringify({ plugin: "my-plugin" }));
    injectOpenCodePlugin(dir, "ctrlplane hook");
    const after = JSON.parse(readFileSync(join(dir, ".opencode", "opencode.json"), "utf8"));
    assert.deepEqual(after.plugin, ["my-plugin", "./plugins/ctrlplane.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: a UTF-8 BOM in a settings file does not break install", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-bom-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), '\uFEFF{"theme":"dark"}');
    const res = injectClaudeHooks(dir, "ctrlplane hook");
    const after = JSON.parse(readFileSync(res.settingsPath, "utf8"));
    assert.equal(after.theme, "dark");
    assert.ok(Array.isArray(after.hooks.PreToolUse));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("regression: CTRLPLANE_HOOK_COMMAND is ignored unless the explicit override flag is set", () => {
  const prev = { cmd: process.env.CTRLPLANE_HOOK_COMMAND, allow: process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE };
  try {
    process.env.CTRLPLANE_HOOK_COMMAND = "true";
    delete process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE;
    assert.notEqual(defaultHookCommand(), "true");
    assert.match(defaultHookCommand(), /bin\.ts" hook$/);
    process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE = "1";
    assert.equal(defaultHookCommand(), "true");
  } finally {
    if (prev.cmd === undefined) delete process.env.CTRLPLANE_HOOK_COMMAND;
    else process.env.CTRLPLANE_HOOK_COMMAND = prev.cmd;
    if (prev.allow === undefined) delete process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE;
    else process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE = prev.allow;
  }
});
test("regression: recognising our hook command answers in linear time on `node` followed by many spaces", () => {
  const start = performance.now();
  isCtrlplaneCommand(`node${" ".repeat(100_000)}x`);
  // Runs on every hook entry during install and uninstall; 300 ms leaves room for a slow CI runner.
  assert.ok(performance.now() - start < 300);
  for (const ours of [
    'node "/home/me/agentdock/packages/cli/src/bin.ts" hook PreToolUse',
    "node   C:\\work\\agentdock\\packages\\cli\\src\\bin.ts hook --agent codex",
    "  node /x/cli/src/bin.ts hook  ",
    'node "/odd path/cli/src/bin.ts" hook Stop',
    "node /cli/src/bin.ts hook",
    "node\n/x/cli/src/bin.ts hook",
    "npx -y ctrlplane hook SessionStart",
  ]) {
    assert.equal(isCtrlplaneCommand(ours), true, ours);
  }
  for (const theirs of [
    "node ~/bin/ctrlplane hook-audit.sh",
    'node ""/cli/src/bin.ts hook',
    "node /x/cli/src/bin.ts hook rm -rf",
    "nodex /x/cli/src/bin.ts hook",
  ]) {
    assert.equal(isCtrlplaneCommand(theirs), false, theirs);
  }
});
// Reading the plugin file is now one operation instead of a check followed by a read, which closes a
// check-then-use window. The window cannot be hit reliably in a test, so these only pin the behaviour.
// Each test either inspects the file or writes it, never both, so the tests have no such window themselves.
test("OpenCode install writes a missing plugin and replaces a stale one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-ocplugin-"));
  try {
    const first = injectOpenCodePlugin(dir, "ctrlplane hook");
    const current = readFileSync(first.pluginPath, "utf8");
    assert.equal(current, buildOpenCodePlugin("ctrlplane hook"));
    writeFileSync(first.pluginPath, "stale");
    injectOpenCodePlugin(dir, "ctrlplane hook");
    assert.equal(readFileSync(first.pluginPath, "utf8"), current);
    rmSync(first.pluginPath);
    mkdirSync(first.pluginPath);
    assert.throws(() => injectOpenCodePlugin(dir, "ctrlplane hook"), { code: "EISDIR" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("OpenCode install leaves a current plugin untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-ocplugin-"));
  try {
    const first = injectOpenCodePlugin(dir, "ctrlplane hook");
    const old = new Date(2000, 0, 1);
    utimesSync(first.pluginPath, old, old);
    injectOpenCodePlugin(dir, "ctrlplane hook");
    assert.equal(statSync(first.pluginPath).mtimeMs, old.getTime());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
