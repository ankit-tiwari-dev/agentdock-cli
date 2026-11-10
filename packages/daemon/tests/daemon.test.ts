import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { SupervisorDaemon, type IPCEndpoint } from "../src/index.ts";
import { createSession } from "../../core/src/index.ts";
import { rmSync } from "node:fs";

function sendIPCMessage(endpoint: IPCEndpoint, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts = endpoint.path
      ? { path: endpoint.path }
      : { host: endpoint.host ?? "127.0.0.1", port: endpoint.port ?? 0 };

    const client = createConnection(opts as any, () => {
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
  });
}

test("SupervisorDaemon starts, serves IPC, and enforces policy", async () => {
  const testProjectDir = "./tmp-test-project";
  const daemon = new SupervisorDaemon({
    projectPath: testProjectDir,
    dbPath: ":memory:",
  });

  const endpoint = await daemon.start();
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
  assert.ok(safeRes.latencyMs < 15);

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
  assert.ok(dangerRes.stderrMessage.includes("Destructive command blocked"));

  // Verify events persisted to storage
  const events = daemon.getStorage().listEventsForSession(session.id);
  assert.equal(events.length, 2);

  // Cleanup
  await daemon.stop();
  rmSync(testProjectDir, { recursive: true, force: true });
});
