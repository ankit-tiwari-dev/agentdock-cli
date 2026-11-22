import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHook, sendDaemonControl } from "../src/hook-client.ts";
import { normalizeHookPayload } from "../../core/src/index.ts";
import { removeDir } from "../../cli/tests/remove-dir.ts";
import { DAEMON_VERSION, SupervisorDaemon, type IPCEndpoint } from "../../daemon/src/index.ts";

/** Writes one raw line to the daemon, the way any local process could, and returns its reply. */
function sendRaw(endpoint: IPCEndpoint, frame: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(
      endpoint.path ? { path: endpoint.path } : { port: endpoint.port!, host: "127.0.0.1" },
      () => client.write(JSON.stringify(frame) + "\n"),
    );
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      client.destroy();
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
    });
    client.on("error", reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test("regression: an agent's hook payload with control:shutdown cannot stop the daemon; only the lock token can", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-control-"));
  mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  const daemon = new SupervisorDaemon({ projectPath: dir, dbPath: ":memory:" });
  let shutdown = false;
  daemon.waitForShutdownRequest().then(() => {
    shutdown = true;
  });
  const endpoint = await daemon.start();
  try {
    const lock = JSON.parse(readFileSync(join(dir, ".ctrlplane", "daemon.lock"), "utf8"));

    // What `echo '{"control":"shutdown"}' | ctrlplane hook Notification` sends.
    const payload = normalizeHookPayload("Notification", { control: "shutdown", cwd: dir }, dir);
    await dispatchHook(payload, { projectPath: dir, ciMode: false });
    await settle();
    assert.equal(shutdown, false, "a hook payload must not request a shutdown");

    // The old frame shape, written straight to the socket.
    await sendRaw(endpoint, { hookEventName: "Notification", cwd: dir, control: "shutdown" });
    await settle();
    assert.equal(shutdown, false, "a hook-shaped frame with control must not request a shutdown");

    const refused = await sendDaemonControl(lock.ipcTarget, "shutdown", 1500, "0".repeat(64));
    await settle();
    assert.equal(shutdown, false, "a control frame with a wrong token must be refused");
    assert.notEqual(refused?.stdoutMessage, "shutting down");

    await sendRaw(endpoint, { kind: "control", control: "shutdown" });
    await settle();
    assert.equal(shutdown, false, "a control frame without a token must be refused");

    const pong = await sendDaemonControl(lock.ipcTarget, "ping");
    assert.equal(pong?.stdoutMessage, DAEMON_VERSION, "the daemon still answers a ping");

    assert.equal(typeof lock.token, "string");
    assert.ok(lock.token.length >= 32, "the lock carries a per-start token");
    const accepted = await sendDaemonControl(lock.ipcTarget, "shutdown", 1500, lock.token);
    await settle();
    assert.equal(accepted?.stdoutMessage, "shutting down");
    assert.equal(shutdown, true, "the token from the lock still shuts the daemon down");
  } finally {
    // A failed assertion must still close the IPC server, or the test process never exits.
    await daemon.stop();
    // The daemon runs git in the folder after a hook; Windows holds it until that exits.
    await removeDir(dir);
  }
});
