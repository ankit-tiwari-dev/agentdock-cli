import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeToolName,
  canonicalizeToolInput,
} from "../src/tool-canonicalizer.ts";
import { parseClaudeTranscript } from "../src/backtracer.ts";

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

test("Backtracer - parses JSONL transcript and reconstructs turns and costs", () => {
  const jsonl = [
    JSON.stringify({ type: "user", content: "Please build the login module", timestamp: "2026-11-10T10:00:00Z" }),
    JSON.stringify({
      type: "assistant",
      usage: { input_tokens: 1500, output_tokens: 300 },
      content: [
        { type: "tool_use", name: "Write", input: { file_path: "src/login.ts" } },
      ],
    }),
  ].join("\n");

  const session = parseClaudeTranscript(jsonl, "test-sess");
  assert.equal(session.totalTurns, 1);
  assert.equal(session.totalTokens, 1800);
  assert.ok(session.totalCostUsd > 0);
  assert.deepEqual(session.turns[0].toolsUsed, ["Write"]);
  assert.deepEqual(session.turns[0].filesModified, ["src/login.ts"]);
});

