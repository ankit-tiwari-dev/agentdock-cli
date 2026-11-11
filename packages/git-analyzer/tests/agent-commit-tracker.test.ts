import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maskAbsolutePaths,
  buildAgentCommitMessage,
  parseAgentCommitTrailers,
  commitAgentTurn,
  AGENT_COMMIT_HEADER,
  type AgentCommitMetadata,
} from "../src/agent-commit-tracker.ts";

test("Commit Tracker - maskAbsolutePaths hides machine user paths", () => {
  const unixPath = "Processed file /home/alice/projects/app/main.js";
  assert.equal(maskAbsolutePaths(unixPath), "Processed file [PATH]/main.js");

  const winPath = "Saved output to C:\\Users\\Administrator\\AppData\\local\\file.txt";
  assert.equal(maskAbsolutePaths(winPath), "Saved output to [PATH]/file.txt");
});

test("Commit Tracker - maskAbsolutePaths handles Windows forward slashes, UNC and POSIX roots", () => {
  assert.equal(maskAbsolutePaths("Read C:/Users/me/repo/src/index.ts now"), "Read [PATH]/index.ts now");
  assert.equal(maskAbsolutePaths("Copied to \\\\fileserver\\team\\builds\\app.zip"), "Copied to [PATH]/app.zip");
  assert.equal(maskAbsolutePaths("Copied to \\\\fileserver\\team"), "Copied to [PATH]");
  assert.equal(maskAbsolutePaths("Edited /Users/bob/work/api/server.go"), "Edited [PATH]/server.go");
  assert.equal(maskAbsolutePaths("Config at /etc/nginx/nginx.conf"), "Config at [PATH]/nginx.conf");
  assert.equal(maskAbsolutePaths("Logs in /var/log/app.log and /usr/local/bin/tool"), "Logs in [PATH]/app.log and [PATH]/tool");
});

test("Commit Tracker - maskAbsolutePaths never reveals a user name or a bare directory", () => {
  assert.equal(maskAbsolutePaths("cd /home/alice"), "cd [PATH]");
  assert.equal(maskAbsolutePaths("cd C:\\Users\\alice"), "cd [PATH]");
  assert.equal(maskAbsolutePaths("cd /home/alice/projects/"), "cd [PATH]");
  assert.equal(maskAbsolutePaths("cd C:\\"), "cd [PATH]");
});

test("Commit Tracker - maskAbsolutePaths keeps trailing punctuation and wrappers outside the mask", () => {
  assert.equal(maskAbsolutePaths("Updated /home/alice/app/main.js."), "Updated [PATH]/main.js.");
  assert.equal(maskAbsolutePaths("See (C:\\Users\\me\\notes.md), then"), "See ([PATH]/notes.md), then");
  assert.equal(maskAbsolutePaths("Wrote \"/Users/me/a/b.txt\"!"), "Wrote \"[PATH]/b.txt\"!");
  assert.equal(maskAbsolutePaths("out=/home/me/build/out.log;"), "out=[PATH]/out.log;");
});

test("Commit Tracker - maskAbsolutePaths leaves URLs, relative paths and words alone", () => {
  const untouched = [
    "Fetched https://example.com/home/alice/file.js today",
    "file:///home/alice/doc.txt is a URL",
    "Edited src/auth.ts and ./scripts/run.sh and ../lib/util.go",
    "Route /api/users returns 200",
    "and/or the C: drive, plus 3/4 of tests",
    "Plain sentence with no paths at all.",
  ];
  for (const text of untouched) {
    assert.equal(maskAbsolutePaths(text), text);
  }
});

test("Commit Tracker - maskAbsolutePaths preserves whitespace and line breaks", () => {
  assert.equal(
    maskAbsolutePaths("line one /home/a/x/y.ts\n\tline two  C:\\a\\b\\c.txt"),
    "line one [PATH]/y.ts\n\tline two  [PATH]/c.txt",
  );
});

test("Commit Tracker - buildAgentCommitMessage creates valid structured trailers", () => {
  const msg = buildAgentCommitMessage({
    subject: "Implement user authentication endpoint",
    summary: "Added JWT verify handler in auth.ts",
    metadata: {
      agentId: "sess_alpha_123",
      agentType: "claude-code",
      turn: 3,
      modelName: "claude-3-5-sonnet",
      tokensInput: 2400,
      tokensOutput: 510,
      costUsd: 0.01485,
      toolsUsed: ["edit_file", "shell_execute"],
      verifiedCriteria: ["AC-1", "AC-2"],
    },
  });

  assert.ok(msg.startsWith("[AgentDock] Implement user authentication endpoint"));
  assert.ok(msg.includes("# AgentDock Metadata"));
  assert.ok(msg.includes("agent_id: sess_alpha_123"));
  assert.ok(msg.includes("model: claude-3-5-sonnet"));
  assert.ok(msg.includes("cost_usd: $0.0149"));
  assert.ok(msg.includes("tools_used: edit_file, shell_execute"));
});

test("Commit Tracker - buildAgentCommitMessage layout, prefix, length cap and summary masking", () => {
  const msg = buildAgentCommitMessage({
    subject: "  [AgentDock] Already prefixed  ",
    summary: "Touched /home/alice/app/main.js",
    metadata: { agentId: "a1", toolsUsed: [] },
  });
  assert.equal(
    msg,
    `[AgentDock] Already prefixed\n\nTouched [PATH]/main.js\n\n${AGENT_COMMIT_HEADER}\nagent_id: a1\n`,
  );

  const long = buildAgentCommitMessage({ subject: "x".repeat(200), metadata: { agentId: "a2" } });
  const subjectLine = long.split("\n")[0];
  assert.ok(subjectLine.length <= 72);
  assert.ok(subjectLine.startsWith("[AgentDock] x"));
  assert.equal(long, `${subjectLine}\n\n${AGENT_COMMIT_HEADER}\nagent_id: a2\n`);
});

test("Commit Tracker - parseAgentCommitTrailers roundtrips metadata faithfully", () => {
  const rawMsg = `[AgentDock] Fix database connection leak

Resolved pooling issue in db.ts.

# AgentDock Metadata
agent_id: sess_999
turn: 5
model: gemini-1.5-pro
tokens_input: 1200
tokens_output: 300
cost_usd: $0.0030
tools_used: write_file
verified_criteria: CRIT-DB-1
`;

  const parsed = parseAgentCommitTrailers(rawMsg);
  assert.ok(parsed !== null);
  assert.equal(parsed.agentId, "sess_999");
  assert.equal(parsed.turn, 5);
  assert.equal(parsed.modelName, "gemini-1.5-pro");
  assert.equal(parsed.tokensInput, 1200);
  assert.equal(parsed.tokensOutput, 300);
  assert.equal(parsed.costUsd, 0.003);
  assert.deepEqual(parsed.toolsUsed, ["write_file"]);
  assert.deepEqual(parsed.verifiedCriteria, ["CRIT-DB-1"]);
});

test("Commit Tracker - build then parse round-trips every field", () => {
  const metadata: AgentCommitMetadata = {
    agentId: "sess_rt_1",
    agentType: "claude-code",
    turn: 12,
    modelName: "claude-sonnet-4-5",
    tokensInput: 98765,
    tokensOutput: 4321,
    costUsd: 0.1234,
    toolsUsed: ["Edit", "Bash", "Read"],
    verifiedCriteria: ["AC-1", "AC-7"],
  };
  const parsed = parseAgentCommitTrailers(
    buildAgentCommitMessage({ subject: "Round trip", summary: "Body text.", metadata }),
  );
  assert.deepEqual(parsed, metadata);
});

test("Commit Tracker - parseAgentCommitTrailers returns null without the header and ignores noise", () => {
  assert.equal(parseAgentCommitTrailers("Fix bug\n\nagent_id: nope\n"), null);

  const parsed = parseAgentCommitTrailers(
    `Subject\n\n${AGENT_COMMIT_HEADER}\n\n# a comment\nagent_id: x\nmystery_key: 1\nnot a key line\nturn: abc\ntools_used: a, , b ,\nCo-Authored-By: Someone <s@example.com>\n`,
  );
  assert.deepEqual(parsed, { agentId: "x", toolsUsed: ["a", "b"] });
});

test("Commit Tracker - commitAgentTurn stages, commits and returns the new SHA", () => {
  const repo = mkdtempSync(join(tmpdir(), "agentdock-commit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "AgentDock Test");
    git("config", "user.email", "agentdock-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.txt"), "hello\n");

    const metadata: AgentCommitMetadata = { agentId: "sess_git", turn: 1, costUsd: 0.5, toolsUsed: ["Write"] };
    const sha = commitAgentTurn({ cwd: repo, subject: "Add a.txt", metadata });

    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git("rev-parse", "HEAD"), sha);
    assert.equal(git("status", "--porcelain"), "");
    const body = git("log", "-1", "--format=%B");
    assert.ok(body.startsWith("[AgentDock] Add a.txt"));
    assert.deepEqual(parseAgentCommitTrailers(body), metadata);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
