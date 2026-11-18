import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type NetConnectOpts } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SupervisorDaemon, type IPCEndpoint } from "../src/index.ts";
import type { HookVerdictResponse, ModelUsage } from "../../core/src/index.ts";
import { parseClaudeTranscript, usageByModel } from "../../agent-adapters/src/backtracer.ts";
import type { TranscriptOpener } from "../src/transcript-guard.ts";
import { defaultOpener } from "../src/transcript-guard.ts";
import type { UsageJobOutcome } from "../src/usage-job.ts";
import { removeDir } from "../../cli/tests/remove-dir.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "agent-adapters", "tests", "fixtures", "claude-two-models.jsonl");
const MARKER = "MARKERWORD-zq7";

function send(endpoint: IPCEndpoint, payload: object): Promise<HookVerdictResponse> {
  return new Promise((resolve, reject) => {
    const opts = endpoint.path
      ? { path: endpoint.path }
      : { host: endpoint.host ?? "127.0.0.1", port: endpoint.port ?? 0 };
    const client = createConnection(opts as NetConnectOpts, () => client.write(JSON.stringify(payload) + "\n"));
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
    client.on("error", reject);
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error("daemon did not answer within 5s"));
    });
  });
}

interface Setup {
  daemon: SupervisorDaemon;
  endpoint: IPCEndpoint;
  dbPath: string;
  transcript: string;
  logs: string[];
  outcomes: [string, UsageJobOutcome][];
  waitFor: (sessionId: string, count: number) => Promise<UsageJobOutcome>;
  done: () => Promise<void>;
}

// Most tests use a short settle time; the first one keeps the daemon's real default.
async function setup(t: TestContext, opener?: TranscriptOpener, realSettleTime = false): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), "ctrlplane-usage-daemon-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const dir = join(home, ".claude", "projects", "proj-a");
  mkdirSync(dir, { recursive: true });
  mkdirSync(project);
  const transcript = join(dir, "s-1.jsonl");
  writeFileSync(transcript, readFileSync(FIXTURE));
  const dbPath = join(project, ".ctrlplane", "audit.db");

  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args.map(String).join(" ")));

  const outcomes: [string, UsageJobOutcome][] = [];
  const waiters: (() => void)[] = [];
  const daemon = new SupervisorDaemon({
    projectPath: project,
    dbPath,
    usage: {
      home,
      opener,
      settleMs: realSettleTime ? undefined : 20,
      onDone: (id, outcome) => {
        outcomes.push([id, outcome]);
        for (const w of waiters.splice(0)) w();
      },
    },
  });
  const endpoint = await daemon.start();
  const waitFor = async (sessionId: string, count: number) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const mine = outcomes.filter(([id]) => id === sessionId);
      if (mine.length >= count) return mine[count - 1][1];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no usage job outcome #${count} for ${sessionId} within 5s`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, left);
      });
    }
  };
  return {
    daemon,
    endpoint,
    dbPath,
    transcript,
    logs,
    outcomes,
    waitFor,
    done: async () => {
      await daemon.stop();
      await removeDir(root);
    },
  };
}

const stop = (s: Setup, event = "Stop") =>
  send(s.endpoint, {
    hookEventName: event,
    sessionId: "s-1",
    agent: "claude-code",
    cwd: join(s.dbPath, "..", ".."),
    transcriptPath: s.transcript,
  });

const expected = (path: string): ModelUsage[] => usageByModel(parseClaudeTranscript(readFileSync(path, "utf8")));

test("after Stop the session's usage rows match the parser within 5 seconds", async (t) => {
  const s = await setup(t, undefined, true);
  try {
    assert.equal((await stop(s)).decision, "ALLOW");
    assert.equal(await s.waitFor("s-1", 1), "written");
    assert.deepEqual(s.daemon.getStorage().listSessionUsage("s-1"), expected(s.transcript));
  } finally {
    await s.done();
  }
});

test("a second Stop on the same file leaves the same totals, and a grown file gives the new totals", async (t) => {
  const s = await setup(t);
  try {
    await stop(s);
    await s.waitFor("s-1", 1);
    const first = s.daemon.getStorage().listSessionUsage("s-1");
    await stop(s);
    await s.waitFor("s-1", 2);
    assert.deepEqual(s.daemon.getStorage().listSessionUsage("s-1"), first);

    appendFileSync(
      s.transcript,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "and one more" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_d",
            model: "claude-haiku-5-5",
            content: [],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        }),
      ].join("\n") + "\n",
    );
    await stop(s);
    await s.waitFor("s-1", 3);
    const grown = s.daemon.getStorage().listSessionUsage("s-1");
    assert.deepEqual(grown, expected(s.transcript));
    assert.deepEqual(
      grown.map((r) => r.model),
      ["claude-haiku-5-5", "claude-nova-9", "claude-opus-5-5"],
    );
  } finally {
    await s.done();
  }
});

test("SessionEnd also records usage", async (t) => {
  const s = await setup(t);
  try {
    await stop(s, "SessionEnd");
    assert.equal(await s.waitFor("s-1", 1), "written");
    assert.deepEqual(s.daemon.getStorage().listSessionUsage("s-1"), expected(s.transcript));
    assert.equal(s.daemon.getStorage().getSession("s-1")?.status, "completed");
  } finally {
    await s.done();
  }
});

test("other hook events do not start a usage job", async (t) => {
  const s = await setup(t);
  try {
    await stop(s, "PreToolUse");
    await stop(s, "PostToolUse");
    await stop(s, "UserPromptSubmit");
    await stop(s);
    assert.equal(await s.waitFor("s-1", 1), "written");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(s.outcomes, [["s-1", "written"]]);
  } finally {
    await s.done();
  }
});

test("regression: the Stop hook answers before the usage job finishes", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let opened = false;
  const s = await setup(t, {
    lines: async function* (p, max) {
      opened = true;
      await gate;
      yield* defaultOpener.lines(p, max);
    },
  });
  try {
    const answer = await stop(s);
    assert.equal(answer.decision, "ALLOW");
    assert.deepEqual(s.daemon.getStorage().listSessionUsage("s-1"), []);
    release();
    assert.equal(await s.waitFor("s-1", 1), "written");
    assert.ok(opened);
  } finally {
    release();
    await s.done();
  }
});

test("regression: the planted marker from the transcript is in no byte of audit.db, its WAL file or the daemon log", async (t) => {
  const s = await setup(t);
  try {
    assert.ok(readFileSync(s.transcript, "utf8").includes(MARKER));
    await stop(s);
    await s.waitFor("s-1", 1);
    await stop(s, "SessionEnd");
    await s.waitFor("s-1", 2);
    // A refused transcript writes a warning line; it must not carry the marker either.
    const outside = join(s.dbPath, "..", "outside.jsonl");
    writeFileSync(outside, readFileSync(s.transcript));
    await send(s.endpoint, { hookEventName: "Stop", sessionId: "s-2", agent: "claude-code", transcriptPath: outside });
    assert.equal(await s.waitFor("s-2", 1), "refused:outside-projects");

    for (const file of [s.dbPath, `${s.dbPath}-wal`]) {
      if (!existsSync(file)) continue;
      assert.ok(!readFileSync(file).includes(Buffer.from(MARKER)), `${file} holds the marker`);
    }
    assert.ok(
      s.logs.some((l) => l.includes("usage job refused: reason=outside-projects session=s-2")),
      s.logs.join("\n"),
    );
    assert.ok(!s.logs.join("\n").includes(MARKER));
    assert.ok(!s.logs.join("\n").includes("outside.jsonl"));
  } finally {
    await s.done();
  }
});

test("the created_at index exists after the daemon starts", async (t) => {
  const s = await setup(t);
  try {
    const db = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
        .all()
        .map((r) => (r as { name: string }).name);
      assert.ok(names.includes("idx_events_created_at"), names.join(", "));
    } finally {
      db.close();
    }
  } finally {
    await s.done();
  }
});
