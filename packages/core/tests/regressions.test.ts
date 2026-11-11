import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTurnCost,
  getModelPricing,
  normalizeModelName,
  resolveModelId,
  MODEL_PRICING_CATALOG,
  DEFAULT_MODEL_PRICING,
} from "../src/token-pricing.ts";
import { canonicalizeToolInput, canonicalizeToolName } from "../src/tool-canonicalizer.ts";

test("regression: Bedrock and Vertex model ids resolve to the catalog id", () => {
  assert.equal(resolveModelId("us.anthropic.claude-opus-4-5-20251101-v1:0"), "claude-opus-4-5");
  assert.equal(resolveModelId("anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(resolveModelId("claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(normalizeModelName("global.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5-20251001");
  assert.deepEqual(
    getModelPricing("us.anthropic.claude-opus-4-5-20251101-v1:0"),
    MODEL_PRICING_CATALOG["claude-opus-4-5"],
  );
  assert.deepEqual(getModelPricing("claude-opus-4-5@20251101"), MODEL_PRICING_CATALOG["claude-opus-4-5"]);
  const cost = calculateTurnCost({ modelName: "claude-opus-4-5@20251101", inputTokens: 1_000_000 });
  assert.equal(cost.costUsd, 5);
  assert.equal(cost.unknownModel, false);
});

test("regression: an unknown model is flagged instead of silently priced as known", () => {
  assert.equal(resolveModelId("gpt-9-turbo"), undefined);
  const cost = calculateTurnCost({ modelName: "gpt-9-turbo", inputTokens: 1000, outputTokens: 500 });
  assert.equal(cost.unknownModel, true);
  // The estimate still uses the default rate, so existing callers keep a number.
  assert.deepEqual(getModelPricing("gpt-9-turbo"), DEFAULT_MODEL_PRICING);
  assert.equal(calculateTurnCost({ modelName: "claude-3-5-sonnet" }).unknownModel, false);
  assert.equal(calculateTurnCost({}).unknownModel, false);
});

test("regression: Cursor delete_file and Gemini search/list tools are not unknown", () => {
  assert.equal(canonicalizeToolName("delete_file"), "file_edit");
  assert.equal(canonicalizeToolName("search_file_content"), "file_list");
  assert.equal(canonicalizeToolName("list_directory"), "file_list");
  assert.deepEqual(canonicalizeToolInput("delete_file", { target_file: "tests/a.test.ts" }).filePaths, [
    "tests/a.test.ts",
  ]);
});

test("regression: MultiEdit edits[] and NotebookEdit new_source give the edited content", () => {
  const multi = canonicalizeToolInput("MultiEdit", {
    file_path: "src/a.ts",
    edits: [
      { old_string: "a", new_string: "alpha" },
      { old_string: "b", new_string: "beta" },
    ],
  });
  assert.equal(multi.canonicalVerb, "file_edit");
  assert.ok(multi.content?.includes("alpha"));
  assert.ok(multi.content?.includes("beta"));

  const nb = canonicalizeToolInput("NotebookEdit", { notebook_path: "n.ipynb", new_source: "print(1)" });
  assert.equal(nb.content, "print(1)");
  assert.deepEqual(nb.filePaths, ["n.ipynb"]);
});

test("regression: OpenCode patch patchText is content and every patched file is a target", () => {
  const patchText = [
    "*** Update File: src/a.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: tests/b.test.ts",
    "+x",
    "*** Delete File: tests/c.test.ts",
  ].join("\n");
  const inv = canonicalizeToolInput("patch", { patchText });
  assert.equal(inv.canonicalVerb, "file_edit");
  assert.equal(inv.content, patchText);
  assert.deepEqual(inv.filePaths, ["src/a.ts", "tests/b.test.ts", "tests/c.test.ts"]);
});

test("regression: MCP filesystem tools map to write/edit with their path arguments as targets", () => {
  assert.equal(canonicalizeToolName("mcp__filesystem__write_file"), "file_write");
  assert.equal(canonicalizeToolName("mcp__filesystem__create_file"), "file_write");
  assert.equal(canonicalizeToolName("mcp__filesystem__edit_file"), "file_edit");
  assert.equal(canonicalizeToolName("mcp__my-fs__delete_file"), "file_edit");
  assert.equal(canonicalizeToolName("mcp__my-fs__move_file"), "file_edit");
  // Only file-mutation tools are mapped; an MCP tool that happens to be named "run" is not a shell.
  assert.equal(canonicalizeToolName("mcp__github__run"), "unknown");

  assert.deepEqual(canonicalizeToolInput("mcp__filesystem__write_file", { path: ".env", content: "x" }).filePaths, [
    ".env",
  ]);
  assert.deepEqual(
    canonicalizeToolInput("mcp__filesystem__move_file", { source: "tests/a.test.ts", destination: "src/a.ts" })
      .filePaths,
    ["tests/a.test.ts", "src/a.ts"],
  );
});

// Tool and model names come from the agent's hook payload and are read inside the hook's 1500 ms budget.
// 300 ms leaves room for a slow CI runner.
const LINEAR_BUDGET_MS = 300;

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test("regression: an MCP tool name with many `__` separators is canonicalized in linear time", () => {
  assert.ok(elapsedMs(() => canonicalizeToolName(`mcp__a__${"0__0".repeat(50_000)}!`)) < LINEAR_BUDGET_MS);
  assert.equal(canonicalizeToolName("mcp__fs__write_file"), "file_write");
  assert.equal(canonicalizeToolName("MCP__my__server__edit_file"), "file_edit");
  assert.equal(canonicalizeToolName("mcp__a___write_file"), "file_write");
  assert.equal(canonicalizeToolName("mcp____write_file"), "unknown");
  assert.equal(canonicalizeToolName("mcp__a\n__write_file"), "unknown");
  assert.equal(canonicalizeToolName("mcp__fs__run"), "unknown");
  assert.equal(canonicalizeToolName("mcp__fs__write-file"), "unknown");
});

test("regression: a model name with many `@` before a line break is normalized in linear time", () => {
  assert.ok(elapsedMs(() => normalizeModelName(`${"@".repeat(100_000)}\nx`)) < LINEAR_BUDGET_MS);
  assert.equal(normalizeModelName("claude-opus-4-5@20251101"), "claude-opus-4-5");
  assert.equal(normalizeModelName("a@b\nc@d"), "a@b\nc");
  assert.equal(normalizeModelName("a@b\n"), "a");
});
