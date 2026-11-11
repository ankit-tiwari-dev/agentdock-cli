import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function cli(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf8", timeout: 30000 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function claudePayload(cwd: string, command: string, sessionId = "sess-e2e") {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: join(cwd, "t.jsonl"),
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

test("regression (real processes): start keeps the daemon alive, hooks read Claude's snake_case payload, events persist, stop cleans up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-e2e-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });

  try {
    assert.equal(cli(dir, ["init"]).code, 0);

    const started = cli(dir, ["start"]);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    assert.match(started.stdout, /started \(PID: \d+/);
    const lock = JSON.parse(readFileSync(join(dir, ".ctrlplane", "daemon.lock"), "utf8"));
    assert.doesNotThrow(() => process.kill(lock.pid, 0), "daemon process must still be alive after `start` exits");

    const status = cli(dir, ["status"]);
    assert.match(status.stdout, /RUNNING/);
    assert.match(status.stdout, /Health: responding/);

    const blocked = cli(dir, ["hook", "PreToolUse"], claudePayload(dir, "git push --force origin main"));
    assert.equal(blocked.code, 2, "force push must be blocked");
    assert.match(blocked.stderr, /force push/i);

    const allowed = cli(dir, ["hook", "PreToolUse"], claudePayload(dir, "git push origin feat/x"));
    assert.equal(allowed.code, 0);

    const audit = cli(dir, ["audit", "show", "sess-e2e"]);
    assert.match(audit.stdout, /2 events/, audit.stdout);
    assert.match(audit.stdout, /verdict=DENY/);

    const stopped = cli(dir, ["stop"]);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(join(dir, ".ctrlplane", "daemon.lock")), false);
    assert.match(cli(dir, ["status"]).stdout, /OFFLINE/);

    const offline = cli(dir, ["hook", "PreToolUse"], claudePayload(dir, "rm -rf /"));
    assert.equal(offline.code, 2, "rules still apply in-process when the daemon is down");
  } finally {
    cli(dir, ["stop"]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("regression: status reports a dead daemon as OFFLINE and removes the stale lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-stale-"));
  try {
    cli(dir, ["init"]);
    const stale = JSON.stringify({ pid: 2147483646, ipcTarget: "\\\\.\\pipe\\ctrlplane-gone" });
    writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), stale);
    assert.match(cli(dir, ["status"]).stdout, /OFFLINE/);
    assert.equal(existsSync(join(dir, ".ctrlplane", "daemon.lock")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

