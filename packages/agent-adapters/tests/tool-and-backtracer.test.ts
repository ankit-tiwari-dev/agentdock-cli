import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeToolName,
  canonicalizeToolInput,
} from "../src/tool-canonicalizer.ts";
import { findLocalClaudeTranscripts, parseClaudeTranscript } from "../src/backtracer.ts";

const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n");

test("Tool Canonicalizer - unifies multi-CLI tool names to canonical verbs", () => {
  assert.equal(canonicalizeToolName("run_command"), "shell_execute");
  assert.equal(canonicalizeToolName("Bash"), "shell_execute");
  assert.equal(canonicalizeToolName("shell"), "shell_execute");
  assert.equal(canonicalizeToolName("write_file"), "file_write");
  assert.equal(canonicalizeToolName("file_create"), "file_write");
  assert.equal(canonicalizeToolName("str_replace_editor"), "file_edit");
  assert.equal(canonicalizeToolName("read_file"), "file_read");
  assert.equal(canonicalizeToolName("unknown_custom_tool"), "unknown");
});

test("Tool Canonicalizer - canonicalizes inputs across diverse schemas", () => {
  // Antigravity style: { CommandLine: "npm test" }
  const inv1 = canonicalizeToolInput("run_command", { CommandLine: "npm test" });
  assert.equal(inv1.canonicalVerb, "shell_execute");
  assert.equal(inv1.command, "npm test");

  // OpenCode style: { path: "src/auth.ts", content: "..." }
  const inv2 = canonicalizeToolInput("file_create", { path: "src/auth.ts", content: "hello" });
  assert.equal(inv2.canonicalVerb, "file_write");
  assert.equal(inv2.filePath, "src/auth.ts");
  assert.equal(inv2.content, "hello");
});

test("Backtracer - parses a Claude Code JSONL transcript and reconstructs turns and costs", () => {
  const content = jsonl([
    {
      type: "user",
      message: { role: "user", content: "Please build the login module" },
      timestamp: "2026-11-10T10:00:00Z",
      sessionId: "s-1",
    },
    {
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [{ type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "src/login.ts", content: "x" } }],
        usage: { input_tokens: 1500, output_tokens: 300 },
      },
      timestamp: "2026-11-10T10:00:05Z",
    },
  ]);

  const session = parseClaudeTranscript(content, "test-sess");
  assert.equal(session.sessionId, "test-sess");
  assert.equal(session.agentType, "claude-code");
  assert.equal(session.totalTurns, 1);
  assert.equal(session.totalTokens, 1800);
  assert.ok(session.totalCostUsd > 0);
  assert.equal(session.turns[0].timestamp, Date.parse("2026-11-10T10:00:00Z"));
  assert.equal(session.turns[0].userPrompt, "Please build the login module");
  assert.deepEqual(session.turns[0].toolsUsed, ["Write"]);
  assert.deepEqual(session.turns[0].filesModified, ["src/login.ts"]);
});

test("regression: nested Claude Code transcript yields real turns, tokens, tools, files and model pricing", () => {
  const content = [
    JSON.stringify({ type: "summary", summary: "Auth work", leafUuid: "u-0" }),
    JSON.stringify({ type: "file-history-snapshot", messageId: "m-0", snapshot: {} }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Add token expiry checks to src/auth.ts" }] },
      timestamp: "2026-11-10T09:00:00.000Z",
      sessionId: "abc",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_a",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "I'll read the file and add the check." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "tool_use", id: "tu_2", name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 },
      },
      timestamp: "2026-11-10T09:00:03.000Z",
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "File updated" }] },
      timestamp: "2026-11-10T09:00:04.000Z",
    }),
    "{ this line is not valid json",
    JSON.stringify({ type: "system", subtype: "info", content: "hook ran" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_b",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Added the expiry check to src/auth.ts." }],
        usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 6000 },
      },
      timestamp: "2026-11-10T09:00:08.000Z",
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Now write tests for it" },
      timestamp: "2026-11-10T09:05:00.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_c",
        role: "assistant",
        model: "claude-opus-4-5-20251101",
        content: [
          { type: "tool_use", id: "tu_3", name: "Write", input: { file_path: "tests/auth.test.ts", content: "t" } },
          { type: "tool_use", id: "tu_4", name: "Bash", input: { command: "npm test" } },
        ],
        usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 0 },
      },
      timestamp: "2026-11-10T09:05:04.000Z",
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_4", content: "1 passing" }] },
      timestamp: "2026-11-10T09:05:10.000Z",
    }),
  ].join("\n");

  const session = parseClaudeTranscript(content, "real-sess");

  assert.equal(session.totalTurns, 2);
  const [first, second] = session.turns;

  assert.equal(first.tokensInput, 1300);
  assert.equal(first.tokensOutput, 300);
  assert.equal(first.cost.cacheReadTokens, 11000);
  assert.equal(first.cost.cacheWriteTokens, 700);
  assert.equal(first.cost.totalTokens, 13300);
  assert.deepEqual(first.toolsUsed, ["Read", "Edit"]);
  assert.deepEqual(first.filesModified, ["src/auth.ts"]);
  assert.equal(first.userPrompt, "Add token expiry checks to src/auth.ts");
  assert.equal(first.assistantSummary, "Added the expiry check to src/auth.ts.");
  assert.equal(first.timestamp, Date.parse("2026-11-10T09:00:00.000Z"));
  // claude-sonnet-4-5: $3 in, $15 out, $0.30 cache read, $3.75 cache write.
  assert.equal(first.cost.model, "claude-sonnet-4-5-20250929");
  assert.equal(first.cost.costUsd, 0.014325);

  assert.equal(second.tokensInput, 2000);
  assert.equal(second.tokensOutput, 400);
  assert.deepEqual(second.toolsUsed, ["Write", "Bash"]);
  assert.deepEqual(second.filesModified, ["tests/auth.test.ts"]);
  // claude-opus-4-5 at $5 in / $25 out: 0.01 + 0.01.
  assert.equal(second.cost.costUsd, 0.02);

  assert.equal(session.totalTokens, 13300 + 2400);
  assert.equal(session.totalCostUsd, 0.0343);
  assert.match(session.summary, /2 turns/);
});

test("Backtracer - cache-read tokens are priced with the turn's model cache rate", () => {
  const content = jsonl([
    { type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-11-10T10:00:00Z" },
    {
      type: "assistant",
      message: { model: "claude-3-5-sonnet-20241022", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } },
    },
  ]);
  const session = parseClaudeTranscript(content);
  assert.equal(session.sessionId, "claude-session");
  assert.equal(session.turns[0].cost.costUsd, 0.3);
  assert.equal(session.totalTokens, 1_000_000);
});

test("regression: a current model is priced at its own rate, cache writes included", () => {
  // Usage copied from a real Claude Code transcript that the backtracer priced at $0.0155.
  const content = jsonl([
    { type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-11-10T10:00:00Z" },
    {
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 2, output_tokens: 1036, cache_read_input_tokens: 35723, cache_creation_input_tokens: 13700 },
      },
    },
  ]);
  const [turn] = parseClaudeTranscript(content).turns;
  assert.equal(turn.cost.cacheWriteTokens, 13700);
  assert.equal(turn.cost.totalTokens, 2 + 1036 + 35723 + 13700);
  assert.equal(turn.cost.costUsd, 0.096373);
});

test("Backtracer - repeated lines of one response count its usage once", () => {
  const usage = { input_tokens: 100, output_tokens: 50 };
  const content = jsonl([
    { type: "user", message: { role: "user", content: "go" } },
    { type: "assistant", message: { id: "msg_x", model: "claude-sonnet-4", content: [{ type: "text", text: "Reading." }], usage } },
    { type: "assistant", message: { id: "msg_x", model: "claude-sonnet-4", content: [{ type: "tool_use", name: "Read", input: { path: "a.md" } }], usage } },
  ]);
  const session = parseClaudeTranscript(content);
  assert.equal(session.totalTokens, 150);
  assert.deepEqual(session.turns[0].filesModified, ["a.md"]);
});

test("Backtracer - still reads flat lines and defaults the model when none is given", () => {
  const content = jsonl([
    { type: "user", content: "Please build the login module", timestamp: "2026-11-10T10:00:00Z" },
    { type: "assistant", usage: { input_tokens: 1500, output_tokens: 300 }, content: [{ type: "tool_use", name: "Write", input: { filePath: "src/login.ts" } }] },
  ]);
  const session = parseClaudeTranscript(content);
  assert.equal(session.totalTurns, 1);
  assert.equal(session.totalTokens, 1800);
  assert.equal(session.turns[0].cost.model, "claude-3-5-sonnet");
  assert.equal(session.turns[0].cost.costUsd, 0.009);
  assert.deepEqual(session.turns[0].filesModified, ["src/login.ts"]);
});

test("Backtracer - long assistant text is cut to about 200 characters", () => {
  const content = jsonl([
    { type: "user", message: { role: "user", content: "explain" } },
    { type: "assistant", message: { content: [{ type: "text", text: "word ".repeat(100) }] } },
  ]);
  const summary = parseClaudeTranscript(content).turns[0].assistantSummary ?? "";
  assert.ok(summary.length <= 203);
  assert.ok(summary.endsWith("..."));
});

test("Backtracer - an empty or junk transcript yields no turns", () => {
  const session = parseClaudeTranscript("\n\nnot json\n{\"type\":\"summary\"}\n");
  assert.equal(session.totalTurns, 0);
  assert.equal(session.totalTokens, 0);
  assert.equal(session.totalCostUsd, 0);
});

test("Backtracer - findLocalClaudeTranscripts finds nested .jsonl files and tolerates a missing folder", () => {
  const root = mkdtempSync(join(tmpdir(), "agentdock-transcripts-"));
  try {
    mkdirSync(join(root, "project-a", "sub"), { recursive: true });
    writeFileSync(join(root, "project-a", "one.jsonl"), "");
    writeFileSync(join(root, "project-a", "sub", "two.jsonl"), "");
    writeFileSync(join(root, "project-a", "notes.txt"), "");

    const found = findLocalClaudeTranscripts(root);
    assert.deepEqual(found, [join(root, "project-a", "one.jsonl"), join(root, "project-a", "sub", "two.jsonl")].sort());
    assert.deepEqual(findLocalClaudeTranscripts(join(root, "does-not-exist")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
