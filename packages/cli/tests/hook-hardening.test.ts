import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/commands/hook-cmd.ts";
import { handleStartDaemon, handleStatus, handleStopDaemon } from "../src/commands/daemon-cmd.ts";
import { handleInit } from "../src/commands/init.ts";
import { isProcessAlive } from "../../daemon/src/lock.ts";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function project(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  return dir;
}

function hookProcess(dir: string, command: string) {
  const input = JSON.stringify({
    session_id: "s",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const env: NodeJS.ProcessEnv = { ...process.env, CTRLPLANE_HOME: join(dir, "user-home") };
  delete env.CI;
  delete env.CTRLPLANE_MODE;
  const r = spawnSync(process.execPath, [BIN, "hook", "PreToolUse"], {
    cwd: dir,
    input,
    encoding: "utf8",
    timeout: 30000,
    env,
  });
  return { code: r.status, stderr: r.stderr ?? "" };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const goneTarget = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ctrlplane-gone-${process.pid}-${Date.now()}`
    : join(tmpdir(), `ctrlplane-gone-${process.pid}-${Date.now()}.sock`);

test("regression: an unexpected error while evaluating PreToolUse is reported, and fails closed in CI", async () => {
  const dir = project("ctrlplane-hookcrash-");
  try {
    const stdin = JSON.stringify({
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const crash = async () => {
      throw new Error("boom in evaluation");
    };
    const local = await withEnv({ CI: undefined, CTRLPLANE_MODE: undefined }, () =>
      runHook("PreToolUse", stdin, { cwd: dir, dispatch: crash }),
    );
    assert.equal(local.exitCode, 0, "outside CI a crash still lets the call through");
    assert.match(local.stderr ?? "", /boom in evaluation/);

    const ci = await withEnv({ CI: "true" }, () => runHook("PreToolUse", stdin, { cwd: dir, dispatch: crash }));
    assert.equal(ci.exitCode, 2);
    assert.match(ci.stderr ?? "", /boom in evaluation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression (real process): a null or garbage daemon lock still runs the rules in-process", () => {
  const dir = project("ctrlplane-locke2e-");
  try {
    for (const lock of ["null", JSON.stringify({ pid: process.pid, ipcTarget: "nonsense:not-a-port" })]) {
      writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), lock);
      const res = hookProcess(dir, "rm -rf /");
      assert.equal(res.code, 2, `${lock}: ${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression (real process): quoted off-switches and protected-folder deletes are denied without a daemon", () => {
  const dir = project("ctrlplane-hooke2e-");
  try {
    for (const command of [
      `ctrlplane "pause" 8h`,
      "ctrl''plane stop",
      "rm -rf .ctrlplane",
      "(rm -rf /)",
      "ctrlplane init",
    ]) {
      const res = hookProcess(dir, command);
      assert.equal(res.code, 2, `${command}: ${res.stderr}`);
    }
    assert.equal(hookProcess(dir, "npm test").code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: stop does not kill an unrelated process whose PID is in a stale lock", async () => {
  const dir = project("ctrlplane-stalestop-");
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => bystander.once("spawn", r));
    writeFileSync(
      join(dir, ".ctrlplane", "daemon.lock"),
      JSON.stringify({ pid: bystander.pid, ipcTarget: goneTarget() }),
    );
    const msg = await handleStopDaemon(dir);
    assert.equal(isProcessAlive(bystander.pid!), true, `bystander was killed: ${msg}`);
    assert.equal(existsSync(join(dir, ".ctrlplane", "daemon.lock")), false, "stale lock is removed");
    assert.match(msg, /No running supervisor daemon/);
  } finally {
    bystander.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: status and start treat a lock whose daemon does not answer as stale", async () => {
  const dir = project("ctrlplane-stalestatus-");
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => bystander.once("spawn", r));
    const stale = JSON.stringify({ pid: bystander.pid, ipcTarget: goneTarget() });
    writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), stale);
    assert.match(await handleStatus(dir), /OFFLINE/);
    assert.equal(existsSync(join(dir, ".ctrlplane", "daemon.lock")), false);

    writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), stale);
    const started = await withEnv({ CTRLPLANE_HOME: join(dir, "user-home") }, () => handleStartDaemon(dir));
    assert.match(started, /started \(PID: \d+/, started);
    assert.doesNotMatch(started, new RegExp(`PID: ${bystander.pid}\\b`));
  } finally {
    await handleStopDaemon(dir);
    bystander.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("regression: init checks the agent settings before it creates .ctrlplane", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-initcheck-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{ broken");
    assert.throws(() => handleInit({ projectPath: dir, agent: "claude" }), /settings\.local\.json is not valid JSON/);
    assert.equal(existsSync(join(dir, ".ctrlplane")), false, "nothing is created when a settings file cannot be read");

    writeFileSync(join(dir, ".claude", "settings.local.json"), '\uFEFF{"theme":"dark"}');
    assert.equal(handleInit({ projectPath: dir, agent: "claude" }).success, true);
    assert.equal(existsSync(join(dir, ".ctrlplane")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
