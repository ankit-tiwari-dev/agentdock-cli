import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_UNAVAILABLE, getRunningDaemonLock } from "../src/lock.ts";
import { IPCServer, type IPCEndpoint } from "../src/ipc-server.ts";

test("regression: a lock file containing null or a wrong shape is treated as no daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-badlock-"));
  try {
    mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
    for (const content of [
      "null",
      "[]",
      "5",
      '"x"',
      "{}",
      '{"pid":"12"}',
      `{"pid":${process.pid}}`,
      `{"pid":${process.pid},"ipcTarget":""}`,
    ]) {
      writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), content);
      let lock: unknown = "not called";
      assert.doesNotThrow(() => {
        lock = getRunningDaemonLock(dir);
      }, content);
      assert.equal(lock, null, content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ask(endpoint: IPCEndpoint, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(
      endpoint.path ? { path: endpoint.path } : { port: endpoint.port!, host: "127.0.0.1" },
    );
    let data = "";
    client.on("connect", () => client.write(line + "\n"));
    client.on("data", (c) => {
      data += c.toString("utf8");
      if (data.includes("\n")) {
        client.end();
        resolve(JSON.parse(data.trim()));
      }
    });
    client.on("error", reject);
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error("no answer"));
    });
  });
}

test("regression: a handler exception is answered with the daemon-unavailable marker so the hook re-checks locally", async () => {
  const server = new IPCServer(() => {
    throw new Error("boom");
  });
  const endpoint = await server.start();
  try {
    const res = await ask(endpoint, JSON.stringify({ hookEventName: "PreToolUse", cwd: "." }));
    assert.equal(res.matchedRuleId, DAEMON_UNAVAILABLE);
    assert.equal(res.decision, "ALLOW");
    const garbage = await ask(endpoint, "{not json");
    assert.equal(garbage.matchedRuleId, DAEMON_UNAVAILABLE);
  } finally {
    await server.stop();
  }
});
