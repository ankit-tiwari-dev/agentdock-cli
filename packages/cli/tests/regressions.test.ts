import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function scratch(prefix: string): { dir: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `ctrlplane-${prefix}-`));
  const dir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  return { dir, home, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function cli(cwd: string, home: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      CTRLPLANE_HOME: join(home, ".ctrlplane"),
      HOME: home,
      USERPROFILE: home,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A git repo with one committed file and an uncommitted change to it. */
function repoWithChange(dir: string): void {
  git(dir, "init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "auth.ts"), "export const x = 1;\n");
  git(dir, "add", "src/auth.ts");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "src", "auth.ts"), "export const x = 1;\nexport function login() { return 'jwt_token'; }\n");
}

test("regression: verify exits non-zero and prints NOT RUN when no check ran, using the real git diff", () => {
  const s = scratch("verify");
  try {
    repoWithChange(s.dir);
    assert.equal(cli(s.dir, s.home, ["init"]).code, 0);
    cli(s.dir, s.home, ["spec", "approve", "dev"]);
    const r = cli(s.dir, s.home, ["verify"]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Test Suite Execution:\s+NOT RUN/);
    assert.doesNotMatch(r.out, /Status:\s+PASSED/);
    // The working-tree diff reached the verifier: it saw the one changed file.
    assert.match(r.out, /1 file\(s\) in the working-tree diff/);
  } finally {
    s.cleanup();
  }
});

test("regression: verify without a spec exits 1 and creates nothing", () => {
  const s = scratch("nospec");
  try {
    const r = cli(s.dir, s.home, ["verify"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no spec found, run ctrlplane init/i);
    assert.equal(existsSync(join(s.dir, ".ctrlplane")), false);
  } finally {
    s.cleanup();
  }
});

test("regression: verify says clearly when the spec is not approved", () => {
  const s = scratch("draft");
  try {
    assert.equal(cli(s.dir, s.home, ["init"]).code, 0);
    const r = cli(s.dir, s.home, ["verify"]);
    assert.match(r.out, /spec is NOT APPROVED/);
  } finally {
    s.cleanup();
  }
});

test("regression: explain reads the working-tree diff instead of an empty one", () => {
  const s = scratch("explain");
  try {
    repoWithChange(s.dir);
    const r = cli(s.dir, s.home, ["explain"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Modified 1 file\(s\)/);
    assert.match(r.out, /login \(src\/auth\.ts\)/);
  } finally {
    s.cleanup();
  }
});

test("regression: commit exits non-zero when it fails or has no subject", () => {
  const s = scratch("commit");
  try {
    assert.notEqual(cli(s.dir, s.home, ["commit"]).code, 0, "missing subject");
    assert.notEqual(cli(s.dir, s.home, ["commit", "msg"]).code, 0, "not a git repo");
    git(s.dir, "init", "-q");
    assert.notEqual(cli(s.dir, s.home, ["commit", "msg"]).code, 0, "nothing to commit");
  } finally {
    s.cleanup();
  }
});

test("regression: coach with no prompt exits non-zero", () => {
  const s = scratch("coach");
  try {
    const r = cli(s.dir, s.home, ["coach"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Usage: ctrlplane coach/);
  } finally {
    s.cleanup();
  }
});

test("regression: backtrace with a path that does not exist is an error", () => {
  const s = scratch("bt-missing");
  try {
    const r = cli(s.dir, s.home, ["backtrace", "./nope.jsonl"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not found/i);
    assert.doesNotMatch(r.out, /Found \d+ local agent transcript/);
  } finally {
    s.cleanup();
  }
});

function transcript(model: string): string {
  return [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        model,
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ].join("\n");
}

test("regression: backtrace lists transcripts newest first", () => {
  const s = scratch("bt-order");
  try {
    const projects = join(s.home, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    const older = join(projects, "aaa.jsonl");
    const newer = join(projects, "zzz.jsonl");
    writeFileSync(older, transcript("claude-3-5-sonnet"));
    writeFileSync(newer, transcript("claude-3-5-sonnet"));
    utimesSync(older, new Date("2020-01-01"), new Date("2020-01-01"));
    utimesSync(newer, new Date("2026-01-01"), new Date("2026-01-01"));
    const r = cli(s.dir, s.home, ["backtrace"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.indexOf("zzz.jsonl") !== -1 && r.out.indexOf("zzz.jsonl") < r.out.indexOf("aaa.jsonl"), r.out);
  } finally {
    s.cleanup();
  }
});

test("regression: backtrace warns when a transcript uses a model with no known price", () => {
  const s = scratch("bt-unknown");
  try {
    const file = join(s.dir, "t.jsonl");
    writeFileSync(file, transcript("gpt-9-turbo"));
    const r = cli(s.dir, s.home, ["backtrace", file]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unknown model 'gpt-9-turbo'/i);
  } finally {
    s.cleanup();
  }
});

test("regression: cost rejects token counts that are not whole numbers", () => {
  const s = scratch("cost");
  try {
    for (const args of [
      ["claude-3-5-sonnet", "abc", "1000"],
      ["claude-3-5-sonnet", "1000", "1e6"],
      ["claude-3-5-sonnet", "12.5", "10"],
    ]) {
      const r = cli(s.dir, s.home, ["cost", ...args]);
      assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
      assert.match(r.out, /Usage: ctrlplane cost/);
    }
    assert.equal(cli(s.dir, s.home, ["cost", "claude-3-5-sonnet", "1000", "500"]).code, 0);
  } finally {
    s.cleanup();
  }
});

test("regression: cost warns for an unknown model instead of silently using another price", () => {
  const s = scratch("cost-unknown");
  try {
    const r = cli(s.dir, s.home, ["cost", "gpt-9-turbo", "1000", "500"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unknown model 'gpt-9-turbo'/i);
    assert.doesNotMatch(cli(s.dir, s.home, ["cost", "claude-opus-4-5@20251101", "1", "1"]).out, /unknown model/i);
  } finally {
    s.cleanup();
  }
});
