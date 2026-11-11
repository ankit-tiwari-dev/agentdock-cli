import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, StorageEngine, BlobStore } from "../src/index.ts";
import { createSession, createAuditEvent } from "../../core/src/index.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Redaction engine identifies and scrubs known secret tokens", () => {
  const dirty = `
    ANTHROPIC_KEY=sk-ant-api03-abcdef12345678901234567890abcdef
    OPENAI_API_KEY=sk-proj-999888777666555444333222111000abcdef
    GITHUB_TOKEN=ghp_111122223333444455556666777788889999
    AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
    DB_PASSWORD='super_secret_db_password_123456'
  `;

  const result = redactSecrets(dirty);
  assert.equal(result.secretsDetectedCount >= 4, true);
  assert.ok(!result.sanitized.includes("sk-ant-api03-"));
  assert.ok(!result.sanitized.includes("sk-proj-999888"));
  assert.ok(!result.sanitized.includes("ghp_11112222"));
  assert.ok(!result.sanitized.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(result.sanitized.includes("[REDACTED_SECRET:"));
});

test("BlobStore compresses large payloads and retrieves faithfully", () => {
  const tmpDir = join(mkdtempSync(join(tmpdir(), "ctrlplane-blobs-test-")), "blobs");
  const blobStore = new BlobStore(tmpDir);

  const payload = "A".repeat(128 * 1024); // 128 KB
  const stored = blobStore.store(payload);

  assert.equal(stored.originalSizeBytes, 128 * 1024);
  assert.ok(stored.compressedSizeBytes < stored.originalSizeBytes / 10); // Highly compressible

  const retrieved = blobStore.retrieve(stored.sha256);
  assert.equal(retrieved, payload);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("regression: an in-memory store writes nothing into the current folder", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctrlplane-cwd-"));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const engine = new StorageEngine(":memory:");
    engine.close();
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    process.chdir(previous);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("StorageEngine manages sessions, events with auto-redaction", () => {
  const engine = new StorageEngine(":memory:");

  const session = createSession({
    agentType: "claude-code",
    projectPath: "/repo/demo",
    gitBranch: "main",
  });
  engine.insertSession(session);

  const retrieved = engine.getSession(session.id);
  assert.ok(retrieved !== null);
  assert.equal(retrieved.id, session.id);
  assert.equal(retrieved.status, "active");

  // Ingest an event containing a secret
  const event = createAuditEvent({
    sessionId: session.id,
    sequenceNum: 1,
    eventType: "pre_tool",
    toolName: "Bash",
    toolInput: {
      command: "curl -H 'Authorization: Bearer sk-ant-secret12345678901234567890' https://api.com",
    },
    policyVerdict: "ALLOW",
  });

  engine.insertEvent(event);
  const events = engine.listEventsForSession(session.id);
  assert.equal(events.length, 1);

  const savedInput = events[0].toolInput as { command: string };
  assert.ok(!savedInput.command.includes("sk-ant-secret"));
  assert.ok(savedInput.command.includes("[REDACTED_SECRET:"));

  engine.close();
});
