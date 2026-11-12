import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, StorageEngine, BlobStore, BLOB_THRESHOLD_BYTES } from "../src/index.ts";
import { createSession, createAuditEvent } from "../../core/src/index.ts";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

test("regression: the policy reason and memory tags are redacted before they are stored", () => {
  const engine = new StorageEngine(":memory:");
  try {
    const session = createSession({ agentType: "claude-code", projectPath: "/repo/demo", gitBranch: "main" });
    engine.insertSession(session);
    const command = "git push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r main";
    engine.insertEvent(
      createAuditEvent({
        sessionId: session.id,
        sequenceNum: 1,
        eventType: "pre_tool",
        toolName: "Bash",
        toolInput: { command },
        policyVerdict: "REQUIRE_MANUAL_APPROVAL",
        policyReason: `Pushing to a protected branch requires approval. (Triggered by command: '${command}')`,
      }),
    );
    const reason = engine.listEventsForSession(session.id)[0].policyReason ?? "";
    assert.ok(!reason.includes("ghp_abcdefghij"), `policy reason leaked: ${reason}`);
    assert.match(reason, /\[REDACTED_SECRET:/);

    engine.addMemory("note", { tags: ["deploy", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"] });
    const tags = engine.listMemory(1)[0].tags;
    assert.ok(!tags.join(" ").includes("sk-ant-api03"), `tags leaked: ${tags.join(" ")}`);
    assert.equal(tags[0], "deploy");
  } finally {
    engine.close();
  }
});

test("regression: a lock that stops WAL setup still leaves the busy timeout set", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-lock-"));
  const dbPath = join(dir, "audit.db");
  new StorageEngine(dbPath).close();
  const setup = new DatabaseSync(dbPath);
  setup.exec("PRAGMA journal_mode = DELETE;");
  setup.close();
  // A reader in the middle of a transaction keeps a shared lock, so switching to WAL fails.
  const reader = new DatabaseSync(dbPath);
  reader.exec("BEGIN; SELECT count(*) FROM memory;");
  let engine: StorageEngine | undefined;
  try {
    engine = new StorageEngine(dbPath);
    const db = (engine as unknown as { db: DatabaseSync }).db;
    assert.deepEqual({ ...db.prepare("PRAGMA busy_timeout").get() }, { timeout: 1000 });
    assert.deepEqual({ ...db.prepare("PRAGMA foreign_keys").get() }, { foreign_keys: 1 });
  } finally {
    engine?.close();
    reader.exec("ROLLBACK;");
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Runs `fn` with the OS temp dir pointed at a fresh private folder, so the test sees only the folders its
 * own store creates (other test processes write to the real temp dir at the same time).
 */
function withPrivateTmp(fn: (tmp: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "ctrlplane-tmproot-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = tmp;
  try {
    assert.equal(tmpdir(), tmp);
    fn(tmp);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Inserts a session and returns a post-tool event for it whose output is large enough to go to a blob. */
function bigOutputEvent(engine: StorageEngine, fill = "B") {
  const session = createSession({ agentType: "claude-code", projectPath: "/repo/demo", gitBranch: "main" });
  engine.insertSession(session);
  return createAuditEvent({
    sessionId: session.id,
    sequenceNum: 1,
    eventType: "post_tool",
    toolName: "Bash",
    toolOutput: { stdout: fill.repeat(BLOB_THRESHOLD_BYTES * 2) },
  });
}

test("regression: an in-memory store does not write blobs into a temp folder named after the process id", () => {
  withPrivateTmp((tmp) => {
    // Any local user can create `<tmp>/ctrlplane-blobs-<pid>` first and then read or plant blobs in it.
    const squatted = `ctrlplane-blobs-${process.pid}`;
    mkdirSync(join(tmp, squatted));
    const engine = new StorageEngine(":memory:");
    try {
      const event = bigOutputEvent(engine);
      engine.insertEvent(event);
      assert.deepEqual(readdirSync(join(tmp, squatted)), [], "nothing is written into the guessable folder");

      const created = readdirSync(tmp).filter((n) => n !== squatted);
      assert.equal(created.length, 1);
      assert.match(created[0], /^ctrlplane-blobs-[A-Za-z0-9]{6}$/);
      assert.notEqual(created[0], squatted);
      assert.equal(readdirSync(join(tmp, created[0])).length, 1);
      assert.deepEqual(engine.listEventsForSession(event.sessionId)[0].toolOutput, event.toolOutput);
    } finally {
      engine.close();
    }
  });
});

test("an in-memory store creates one blob folder, on its first large write", () => {
  withPrivateTmp((tmp) => {
    const engine = new StorageEngine(":memory:");
    try {
      assert.deepEqual(readdirSync(tmp), [], "opening the store creates nothing");
      engine.insertEvent(bigOutputEvent(engine, "A"));
      const second = bigOutputEvent(engine, "B");
      engine.insertEvent(second);
      const created = readdirSync(tmp);
      assert.equal(created.length, 1);
      assert.equal(readdirSync(join(tmp, created[0])).length, 2);
      assert.equal((engine.listEventsForSession(second.sessionId)[0].toolOutput as { stdout: string }).stdout[0], "B");
    } finally {
      engine.close();
    }
  });
});

test("regression: an audit.db made before rule IDs were stored is upgraded on open and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-oldschema-"));
  const dbPath = join(dir, "audit.db");
  try {
    // The events table exactly as earlier versions created it: no rule_id column.
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, project_path TEXT NOT NULL,
        git_branch TEXT NOT NULL, base_commit_sha TEXT NOT NULL, head_commit_sha TEXT, spec_id TEXT,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence_num INTEGER NOT NULL, event_type TEXT NOT NULL, tool_name TEXT, tool_input_json TEXT,
        tool_output_json TEXT, is_blob_stored INTEGER NOT NULL DEFAULT 0, policy_verdict TEXT, policy_reason TEXT,
        execution_duration_ms INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('s', 'claude-code', '/p', 'main', 'abc', NULL, NULL, 'active', 1, NULL, NULL);
      INSERT INTO events VALUES ('old', 's', 1, 'pre_tool', 'Bash', NULL, NULL, 0, 'DENY', 'blocked', 3, 2);`);
    old.close();

    const storage = new StorageEngine(dbPath);
    let events;
    try {
      storage.insertEvent({
        ...createAuditEvent({ sessionId: "s", sequenceNum: 2, eventType: "pre_tool" }),
        policyVerdict: "DENY",
        ruleId: "RULE-X",
      });
      events = storage.listEventsForSession("s");
    } finally {
      storage.close();
    }
    assert.deepEqual(
      events.map((e) => [e.id, e.ruleId]),
      [
        ["old", undefined],
        [events[1].id, "RULE-X"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
