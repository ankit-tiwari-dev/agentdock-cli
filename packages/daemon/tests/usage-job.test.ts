import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelUsage, Session } from "../../core/src/index.ts";
import { USAGE_SETTLE_MS, UsageJobQueue, type UsageJobOutcome } from "../src/usage-job.ts";
import type { TranscriptOpener } from "../src/transcript-guard.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "agent-adapters", "tests", "fixtures", "claude-two-models.jsonl");
const MARKER = "MARKERWORD-zq7";

interface Harness {
  home: string;
  transcript: string;
  sessions: Map<string, Session>;
  writes: { sessionId: string; rows: readonly ModelUsage[] }[];
  warnings: string[];
  outcomes: [string, UsageJobOutcome][];
  reads: string[];
  queue: UsageJobQueue;
  cleanup: () => Promise<void>;
}

function session(id: string, agentType: Session["agentType"], transcriptPath?: string): Session {
  return {
    id,
    agentType,
    projectPath: "/p",
    gitBranch: "main",
    baseCommitSha: "0".repeat(40),
    status: "active",
    startedAt: 1,
    metadata: transcriptPath ? { transcriptPath } : undefined,
  };
}

function harness(
  opts: { opener?: (base: TranscriptOpener) => TranscriptOpener; failWrite?: boolean; settleMs?: number } = {},
): Harness {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-usage-job-"));
  const dir = join(home, ".claude", "projects", "proj-a");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "s-1.jsonl");
  writeFileSync(transcript, readFileSync(FIXTURE));
  const h = {
    home,
    transcript,
    sessions: new Map(),
    writes: [],
    warnings: [],
    outcomes: [],
    reads: [],
  } as unknown as Harness;
  h.sessions.set("s-1", session("s-1", "claude-code", transcript));

  const base: TranscriptOpener = {
    lines: async function* (p: string) {
      h.reads.push(p);
      for (const line of readFileSync(p, "utf8").split("\n")) yield line;
    },
  };
  h.queue = new UsageJobQueue({
    home,
    settleMs: opts.settleMs ?? 0,
    storage: {
      getSession: (id: string) => h.sessions.get(id) ?? null,
      replaceSessionUsage: (sessionId: string, rows: readonly ModelUsage[]) => {
        if (opts.failWrite)
          throw Object.assign(new Error(`SQLITE_BUSY at ${transcript}`), { code: "ERR_SQLITE_ERROR" });
        h.writes.push({ sessionId, rows });
      },
    },
    opener: opts.opener ? opts.opener(base) : base,
    warn: (line) => h.warnings.push(line),
    onDone: (id, outcome) => h.outcomes.push([id, outcome]),
  });
  h.cleanup = async () => {
    await h.queue.close();
    rmSync(home, { recursive: true, force: true });
  };
  return h;
}

test("a Stop for a Claude Code session writes its per-model usage", async () => {
  const h = harness();
  try {
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "written"]]);
    assert.deepEqual(
      h.writes.map((w) => [w.sessionId, w.rows.map((r) => r.model)]),
      [["s-1", ["claude-nova-9", "claude-opus-5-5"]]],
    );
    assert.deepEqual(h.warnings, []);
  } finally {
    await h.cleanup();
  }
});

test("schedule returns before the job reads anything", async () => {
  const h = harness();
  try {
    const returned = h.queue.schedule("s-1");
    assert.equal(returned, undefined);
    assert.deepEqual(h.reads, []);
    await h.queue.idle();
    assert.equal(h.reads.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("a burst of Stops for one session reads the transcript at most twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    opener: (base) => ({
      lines: async function* (p: string, max: number) {
        await gate;
        yield* base.lines(p, max);
      },
    }),
  });
  try {
    for (let i = 0; i < 10; i++) h.queue.schedule("s-1");
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 10; i++) h.queue.schedule("s-1");
    release();
    await h.queue.idle();
    assert.ok(h.reads.length >= 1 && h.reads.length <= 2, `reads: ${h.reads.length}`);
    assert.equal(h.outcomes.at(-1)?.[1], "written");
  } finally {
    await h.cleanup();
  }
});

test("a refused transcript logs one warning with the reason and the session id, writes no row and keeps earlier rows", async () => {
  const h = harness();
  try {
    const outside = join(h.home, "outside.jsonl");
    writeFileSync(outside, readFileSync(FIXTURE));
    h.sessions.set("s-1", session("s-1", "claude-code", outside));
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "refused:outside-projects"]]);
    assert.deepEqual(h.warnings, ["usage job refused: reason=outside-projects session=s-1"]);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.reads, []);
  } finally {
    await h.cleanup();
  }
});

test("a read failure keeps earlier rows and logs only the error code", async () => {
  const h = harness({
    opener: () => ({
      // eslint-disable-next-line require-yield
      lines: async function* (p: string) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
      },
    }),
  });
  try {
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "failed"]]);
    assert.deepEqual(h.warnings, ["usage job failed: code=EACCES session=s-1"]);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.cleanup();
  }
});

test("a failed write is logged by code, never by message", async () => {
  const h = harness({ failWrite: true });
  try {
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "failed"]]);
    assert.deepEqual(h.warnings, ["usage job failed: code=ERR_SQLITE_ERROR session=s-1"]);
  } finally {
    await h.cleanup();
  }
});

test("a Codex session, or a Claude Code session without a transcript path, is skipped without any read", async () => {
  const h = harness();
  try {
    h.sessions.set("c-1", session("c-1", "codex", h.transcript));
    h.sessions.set("s-2", session("s-2", "claude-code"));
    h.queue.schedule("c-1");
    h.queue.schedule("s-2");
    h.queue.schedule("unknown");
    await h.queue.idle();
    assert.deepEqual(h.outcomes.sort(), [
      ["c-1", "skipped"],
      ["s-2", "skipped"],
      ["unknown", "skipped"],
    ]);
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.warnings, []);
  } finally {
    await h.cleanup();
  }
});

test("a transcript with no usage writes nothing", async () => {
  const h = harness();
  try {
    writeFileSync(h.transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "empty"]]);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.cleanup();
  }
});

test("schedule never throws, even when the store does", async () => {
  const h = harness();
  try {
    h.sessions.get = () => {
      throw new Error("database is closed");
    };
    assert.doesNotThrow(() => h.queue.schedule("s-1"));
    await h.queue.idle();
    assert.deepEqual(h.outcomes, [["s-1", "failed"]]);
    assert.deepEqual(h.warnings, ["usage job failed: code=unknown session=s-1"]);
  } finally {
    await h.cleanup();
  }
});

test("no warning line holds the transcript path or any transcript text", async () => {
  const h = harness({
    opener: () => ({
      // eslint-disable-next-line require-yield
      lines: async function* (p: string) {
        throw Object.assign(new Error(`ENOENT ${p} ${MARKER}`), { code: "ENOENT" });
      },
    }),
  });
  try {
    h.queue.schedule("s-1");
    await h.queue.idle();
    const outside = join(h.home, "x", "outside.jsonl");
    h.sessions.set("s-1", session("s-1", "claude-code", outside));
    h.queue.schedule("s-1");
    await h.queue.idle();
    assert.equal(h.warnings.length, 2);
    for (const line of h.warnings) {
      assert.ok(!line.includes(MARKER), line);
      assert.ok(!line.includes(h.home), line);
      assert.ok(!line.includes(".jsonl"), line);
    }
  } finally {
    await h.cleanup();
  }
});

test("close stops taking jobs and waits for the running one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    opener: (base) => ({
      lines: async function* (p: string, max: number) {
        await gate;
        yield* base.lines(p, max);
      },
    }),
  });
  try {
    h.queue.schedule("s-1");
    await new Promise((r) => setImmediate(r));
    let closed = false;
    const closing = h.queue.close().then(() => (closed = true));
    h.queue.schedule("s-1");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(h.writes.length, 1);
    assert.equal(h.reads.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("Stops that keep arriving within the settle time lead to one read, after the last one", async () => {
  const h = harness({ settleMs: 60 });
  try {
    for (let i = 0; i < 5; i++) {
      h.queue.schedule("s-1");
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(h.reads, [], "nothing is read while Stops keep arriving");
    await h.queue.idle();
    assert.equal(h.reads.length, 1);
    assert.deepEqual(h.outcomes, [["s-1", "written"]]);
  } finally {
    await h.cleanup();
  }
});

test("close runs a job that is still waiting instead of dropping it", async () => {
  const h = harness({ settleMs: 60_000 });
  try {
    h.queue.schedule("s-1");
    await h.queue.close();
    assert.equal(h.reads.length, 1);
    assert.deepEqual(h.outcomes, [["s-1", "written"]]);
  } finally {
    await h.cleanup();
  }
});

test("the default settle time is one second", () => {
  assert.equal(USAGE_SETTLE_MS, 1000);
});
