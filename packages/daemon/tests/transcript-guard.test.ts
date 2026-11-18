import test from "node:test";
import assert from "node:assert/strict";
import {
  promises as fsp,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTranscriptPath, defaultOpener, MAX_TRANSCRIPT_BYTES, type GuardFs } from "../src/transcript-guard.ts";

function makeHome(): { home: string; projects: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-guard-"));
  const projects = join(home, ".claude", "projects");
  mkdirSync(join(projects, "proj-a"), { recursive: true });
  return { home, projects, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function recordingFs(): GuardFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    realpath: async (p) => {
      calls.push(`realpath ${p}`);
      return fsp.realpath(p);
    },
    stat: async (p) => {
      calls.push(`stat ${p}`);
      return fsp.stat(p);
    },
  };
}

test("a transcript inside ~/.claude/projects is accepted with its real path and size", async () => {
  const h = makeHome();
  try {
    const file = join(h.projects, "proj-a", "s-1.jsonl");
    writeFileSync(file, "{}\n");
    const result = await checkTranscriptPath(file, { home: h.home });
    assert.deepEqual(result, { ok: true, realPath: await fsp.realpath(file), size: 3 });

    // A name that merely starts with two dots is still inside.
    const dotted = join(h.projects, "..dotted.jsonl");
    writeFileSync(dotted, "{}\n");
    assert.equal((await checkTranscriptPath(dotted, { home: h.home })).ok, true);
  } finally {
    h.cleanup();
  }
});

test("a transcript outside ~/.claude/projects is refused and never opened", async () => {
  const h = makeHome();
  try {
    const outside = join(h.home, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    const fs = recordingFs();
    assert.deepEqual(await checkTranscriptPath(outside, { home: h.home, fs }), {
      ok: false,
      reason: "outside-projects",
    });
    assert.ok(!fs.calls.some((c) => c.startsWith("stat")), fs.calls.join(", "));

    // A sibling folder whose name starts with "projects" is still outside.
    mkdirSync(join(h.home, ".claude", "projects-evil"));
    const sibling = join(h.home, ".claude", "projects-evil", "s.jsonl");
    writeFileSync(sibling, "{}\n");
    assert.deepEqual(await checkTranscriptPath(sibling, { home: h.home }), { ok: false, reason: "outside-projects" });

    // A relative path climbing out is outside too.
    const climbing = join(h.projects, "proj-a", "..", "..", "..", "elsewhere.jsonl");
    assert.deepEqual(await checkTranscriptPath(climbing, { home: h.home }), { ok: false, reason: "outside-projects" });
  } finally {
    h.cleanup();
  }
});

test("a file inside it that does not end in .jsonl is refused before any file system call", async () => {
  const h = makeHome();
  try {
    const file = join(h.projects, "proj-a", "notes.txt");
    writeFileSync(file, "{}\n");
    const fs = recordingFs();
    assert.deepEqual(await checkTranscriptPath(file, { home: h.home, fs }), { ok: false, reason: "not-jsonl" });
    assert.deepEqual(fs.calls, []);
  } finally {
    h.cleanup();
  }
});

test("a link inside it that points outside is refused", async () => {
  const h = makeHome();
  try {
    const target = join(h.home, "outside-dir");
    mkdirSync(target);
    writeFileSync(join(target, "s.jsonl"), "{}\n");
    // A junction on Windows needs no admin rights; elsewhere it is an ordinary directory symlink.
    symlinkSync(target, join(h.projects, "linked"), "junction");
    const fs = recordingFs();
    const result = await checkTranscriptPath(join(h.projects, "linked", "s.jsonl"), { home: h.home, fs });
    assert.deepEqual(result, { ok: false, reason: "outside-projects" });
    assert.ok(!fs.calls.some((c) => c.startsWith("stat")), fs.calls.join(", "));
  } finally {
    h.cleanup();
  }
});

test("a file over 50 MB is refused before any read", async () => {
  const h = makeHome();
  try {
    const file = join(h.projects, "proj-a", "big.jsonl");
    writeFileSync(file, "");
    truncateSync(file, MAX_TRANSCRIPT_BYTES + 1);
    assert.deepEqual(await checkTranscriptPath(file, { home: h.home }), { ok: false, reason: "too-large" });
    truncateSync(file, MAX_TRANSCRIPT_BYTES);
    assert.equal((await checkTranscriptPath(file, { home: h.home })).ok, true);
  } finally {
    h.cleanup();
  }
});

test("a missing file is refused as missing, and a folder as not a file", async () => {
  const h = makeHome();
  try {
    assert.deepEqual(await checkTranscriptPath(join(h.projects, "proj-a", "gone.jsonl"), { home: h.home }), {
      ok: false,
      reason: "missing",
    });
    mkdirSync(join(h.projects, "proj-a", "dir.jsonl"));
    assert.deepEqual(await checkTranscriptPath(join(h.projects, "proj-a", "dir.jsonl"), { home: h.home }), {
      ok: false,
      reason: "not-a-file",
    });
  } finally {
    h.cleanup();
  }
});

test("with no ~/.claude/projects folder every path is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-guard-empty-"));
  try {
    const file = join(home, "s.jsonl");
    writeFileSync(file, "{}\n");
    assert.deepEqual(await checkTranscriptPath(file, { home }), { ok: false, reason: "outside-projects" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the reader stops at the byte limit even if the file grew after the check", async () => {
  const h = makeHome();
  try {
    const file = join(h.projects, "proj-a", "grow.jsonl");
    writeFileSync(file, "aaaa\nbbbb\n");
    appendFileSync(file, "cccc\ndddd\n");
    const lines: string[] = [];
    for await (const line of defaultOpener.lines(file, 12)) lines.push(line);
    assert.deepEqual(lines, ["aaaa", "bbbb", "cc"]);
  } finally {
    h.cleanup();
  }
});
