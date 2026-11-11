import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, type NetConnectOpts } from "node:net";
import { SupervisorDaemon, type IPCEndpoint } from "../src/index.ts";
import { createSession, type HookVerdictResponse } from "../../core/src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sendIPCMessage(endpoint: IPCEndpoint, payload: object): Promise<HookVerdictResponse> {
  return new Promise((resolve, reject) => {
    const opts = endpoint.path
      ? { path: endpoint.path }
      : { host: endpoint.host ?? "127.0.0.1", port: endpoint.port ?? 0 };

    const client = createConnection(opts as NetConnectOpts, () => {
      client.write(JSON.stringify(payload) + "\n");
    });

    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) {
        client.end();
        try {
          resolve(JSON.parse(data.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });

    client.on("error", (err) => {
      reject(err);
    });
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error("daemon did not answer within 5s"));
    });
  });
}

test("SupervisorDaemon starts, serves IPC, and enforces policy", async () => {
  const testProjectDir = mkdtempSync(join(tmpdir(), "ctrlplane-daemon-"));
  const daemon = new SupervisorDaemon({
    projectPath: testProjectDir,
    dbPath: ":memory:",
  });

  const endpoint = await daemon.start();
  try {
    assert.ok(endpoint.path || endpoint.port);

    // Seed active session in storage
    const session = createSession({
      agentType: "claude-code",
      projectPath: testProjectDir,
    });
    daemon.getStorage().insertSession(session);

    // 1. Safe tool call -> ALLOW (Exit 0)
    const safeRes = await sendIPCMessage(endpoint, {
      hookEventName: "PreToolUse",
      sessionId: session.id,
      cwd: testProjectDir,
      toolName: "Bash",
      toolInput: { command: "npm test" },
    });

    assert.equal(safeRes.decision, "ALLOW");
    assert.equal(safeRes.exitCode, 0);
    // A loose bound: CI runners are shared and slow; the engine's own speed is covered by the policy-engine perf test.
    assert.ok(safeRes.latencyMs < 250, `latency ${safeRes.latencyMs}ms`);

    // 2. Dangerous tool call -> DENY (Exit 2)
    const dangerRes = await sendIPCMessage(endpoint, {
      hookEventName: "PreToolUse",
      sessionId: session.id,
      cwd: testProjectDir,
      toolName: "Bash",
      toolInput: { command: "rm -rf /critical/data" },
    });

    assert.equal(dangerRes.decision, "DENY");
    assert.equal(dangerRes.exitCode, 2);
    assert.ok(dangerRes.stderrMessage?.includes("Destructive command blocked"));

    // Verify events persisted to storage
    const events = daemon.getStorage().listEventsForSession(session.id);
    assert.equal(events.length, 2);
  } finally {
    // A failed assertion must still close the IPC server, or the test process never exits.
    await daemon.stop();
    rmSync(testProjectDir, { recursive: true, force: true });
  }
});
