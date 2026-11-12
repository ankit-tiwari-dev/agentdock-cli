import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/commands/hook-cmd.ts";
import { handleStartDaemon, handleStopDaemon } from "../src/commands/daemon-cmd.ts";
import { StorageEngine } from "../../storage/src/index.ts";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function project(withCtrlplane = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-offline-"));
  if (withCtrlplane) mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  return dir;
}

const bash = (dir: string, command: string, session = "s") =>
  JSON.stringify({
    session_id: session,
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

/** The local, no-daemon path: CI would fail closed instead, so it is switched off for the call. */
async function localHook(dir: string, stdin: string) {
  const prev = { ci: process.env.CI, mode: process.env.CTRLPLANE_MODE };
  delete process.env.CI;
  delete process.env.CTRLPLANE_MODE;
  try {
    return await runHook("PreToolUse", stdin, { cwd: dir, agent: "claude-code" });
  } finally {
    if (prev.ci !== undefined) process.env.CI = prev.ci;
    if (prev.mode !== undefined) process.env.CTRLPLANE_MODE = prev.mode;
  }
}

function readEvents(dir: string, session = "s") {
  const storage = new StorageEngine(join(dir, ".ctrlplane", "audit.db"));
  try {
    return { events: storage.listEventsForSession(session), session: storage.getSession(session) };
  } finally {
    storage.close();
  }
}

test("regression: without a daemon, a blocked tool call is still written to the audit log", async () => {
  const dir = project();
  try {
    const out = await localHook(dir, bash(dir, "rm -rf ~"));
    assert.equal(out.exitCode, 2);
    const { events, session } = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "pre_tool");
    assert.equal(events[0].policyVerdict, "DENY");
    assert.equal(events[0].ruleId, "RULE-BLOCK-DESTRUCTIVE-SHELL");
    assert.deepEqual(events[0].toolInput, { command: "rm -rf ~" });
    assert.equal(session?.agentType, "claude-code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret in a tool call recorded without a daemon is redacted, as the daemon does", async () => {
  const dir = project();
  try {
    await localHook(dir, bash(dir, "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE"));
    const stored = JSON.stringify(readEvents(dir).events[0].toolInput);
    assert.equal(stored.includes("AKIAIOSFODNN7EXAMPLE"), false, stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder that was never set up with ctrlplane gets no audit database", async () => {
  const dir = project(false);
  try {
    await localHook(dir, bash(dir, "ls"));
    assert.equal(existsSync(join(dir, ".ctrlplane")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook processes running at the same time get different sequence numbers", async () => {
  const dir = project();
  const env: NodeJS.ProcessEnv = { ...process.env, CTRLPLANE_HOME: join(dir, "user-home") };
  delete env.CI;
  delete env.CTRLPLANE_MODE;
  const run = (n: number) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [BIN, "hook", "PreToolUse"], { cwd: dir, env, stdio: "pipe" });
      child.on("close", resolve);
      child.stdin.end(bash(dir, `echo ${n}`));
    });
  try {
    const codes = await Promise.all([1, 2, 3, 4].map(run));
    assert.deepEqual(codes, [0, 0, 0, 0]);
    const sequence = readEvents(dir)
      .events.map((e) => e.sequenceNum)
      .sort();
    assert.deepEqual(sequence, [1, 2, 3, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the daemon running, a tool call is recorded once, by the daemon", async () => {
  const dir = project();
  const prev = { home: process.env.CTRLPLANE_HOME };
  process.env.CTRLPLANE_HOME = join(dir, "user-home");
  try {
    await handleStartDaemon(dir);
    const out = await localHook(dir, bash(dir, "rm -rf ~"));
    assert.equal(out.exitCode, 2);
  } finally {
    await handleStopDaemon(dir);
    if (prev.home === undefined) delete process.env.CTRLPLANE_HOME;
    else process.env.CTRLPLANE_HOME = prev.home;
  }
  try {
    assert.equal(readEvents(dir).events.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
