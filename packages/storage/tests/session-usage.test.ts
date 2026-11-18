import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StorageEngine } from "../src/index.ts";
import { createAuditEvent, createSession, type ModelUsage } from "../../core/src/index.ts";

function usage(model: string, n: number, extra: Partial<ModelUsage> = {}): ModelUsage {
  return {
    model,
    inputTokens: n,
    outputTokens: n * 2,
    cacheReadTokens: n * 3,
    cacheCreationTokens: n * 4,
    costUsd: n / 1000,
    unknownModel: false,
    turns: 1,
    ...extra,
  };
}

function withStore(run: (store: StorageEngine, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-usage-"));
  const dbPath = join(dir, "audit.db");
  const store = new StorageEngine(dbPath);
  try {
    run(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedSession(store: StorageEngine, id = "s-1"): void {
  store.insertSession(createSession({ id, agentType: "claude-code", projectPath: "/p" }));
}

test("replacing a session's usage twice with the same rows leaves the same rows, not doubled", () => {
  withStore((store) => {
    seedSession(store);
    const rows = [usage("claude-opus-5-5", 10), usage("claude-sonnet-5-5", 5, { unknownModel: true, turns: 3 })];
    store.replaceSessionUsage("s-1", rows, 1000);
    store.replaceSessionUsage("s-1", rows, 2000);
    assert.deepEqual(store.listSessionUsage("s-1"), rows);
  });
});

test("a model missing from the new rows is removed", () => {
  withStore((store) => {
    seedSession(store);
    store.replaceSessionUsage("s-1", [usage("claude-opus-5-5", 10), usage("claude-sonnet-5-5", 5)]);
    store.replaceSessionUsage("s-1", [usage("claude-opus-5-5", 12)]);
    assert.deepEqual(store.listSessionUsage("s-1"), [usage("claude-opus-5-5", 12)]);
  });
});

test("a failed write keeps the previous rows", () => {
  withStore((store) => {
    seedSession(store);
    const before = [usage("claude-opus-5-5", 10)];
    store.replaceSessionUsage("s-1", before);
    // Two rows for one model break the primary key halfway through the transaction.
    assert.throws(() => store.replaceSessionUsage("s-1", [usage("claude-haiku-5-5", 1), usage("claude-haiku-5-5", 2)]));
    assert.deepEqual(store.listSessionUsage("s-1"), before);
    // The connection is usable afterwards: no transaction was left open.
    store.replaceSessionUsage("s-1", [usage("claude-haiku-5-5", 3)]);
    assert.deepEqual(store.listSessionUsage("s-1"), [usage("claude-haiku-5-5", 3)]);
  });
});

test("usage of one session leaves other sessions' rows alone", () => {
  withStore((store) => {
    seedSession(store, "s-1");
    seedSession(store, "s-2");
    store.replaceSessionUsage("s-1", [usage("claude-opus-5-5", 1)]);
    store.replaceSessionUsage("s-2", [usage("claude-opus-5-5", 2)]);
    store.replaceSessionUsage("s-1", []);
    assert.deepEqual(store.listSessionUsage("s-1"), []);
    assert.deepEqual(store.listSessionUsage("s-2"), [usage("claude-opus-5-5", 2)]);
  });
});

test("deleting a session deletes its usage rows", () => {
  withStore((store, dbPath) => {
    seedSession(store);
    store.replaceSessionUsage("s-1", [usage("claude-opus-5-5", 10)]);
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("PRAGMA foreign_keys = ON; DELETE FROM sessions WHERE id = 's-1';");
    } finally {
      raw.close();
    }
    assert.deepEqual(store.listSessionUsage("s-1"), []);
  });
});

test("an existing audit.db without the table gains it on open, keeps every event, and a second open changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-usage-old-"));
  const dbPath = join(dir, "audit.db");
  try {
    const first = new StorageEngine(dbPath);
    seedSession(first);
    for (let i = 1; i <= 3; i++) {
      first.insertEvent(
        createAuditEvent({ sessionId: "s-1", sequenceNum: i, eventType: "post_tool", toolName: "Read" }),
      );
    }
    first.close();
    // What a 0.2.0 CLI leaves behind: no session_usage table.
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE session_usage;");
    raw.close();

    const schema = () => {
      const db = new DatabaseSync(dbPath);
      try {
        return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      } finally {
        db.close();
      }
    };

    const reopened = new StorageEngine(dbPath);
    assert.equal(reopened.listEventsForSession("s-1").length, 3);
    assert.deepEqual(reopened.listSessionUsage("s-1"), []);
    reopened.close();
    const afterFirst = schema();
    assert.ok(afterFirst.some((r) => (r as { name: string }).name === "session_usage"));

    new StorageEngine(dbPath).close();
    assert.deepEqual(schema(), afterFirst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening the database does not build the created_at index; ensureEventsCreatedAtIndex builds it once and a second call is a no-op", () => {
  withStore((store, dbPath) => {
    const indexes = () => {
      const db = new DatabaseSync(dbPath);
      try {
        return db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name")
          .all()
          .map((r) => (r as { name: string }).name);
      } finally {
        db.close();
      }
    };
    assert.ok(!indexes().includes("idx_events_created_at"));
    store.ensureEventsCreatedAtIndex();
    assert.ok(indexes().includes("idx_events_created_at"));
    store.ensureEventsCreatedAtIndex();
    assert.equal(indexes().filter((n) => n === "idx_events_created_at").length, 1);
  });
});
