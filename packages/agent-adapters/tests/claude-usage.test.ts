import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readClaudeUsage } from "../src/claude-usage.ts";
import { parseClaudeTranscript, usageByModel } from "../src/backtracer.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-two-models.jsonl");
const MARKER = "MARKERWORD-zq7";
const content = readFileSync(FIXTURE, "utf8");

async function* linesOf(text: string): AsyncIterable<string> {
  for (const line of text.split(/\r?\n/)) yield line;
}

test("line-by-line totals per model equal parseClaudeTranscript's turns grouped by model", async () => {
  const expected = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
  >();
  for (const { cost } of parseClaudeTranscript(content).turns) {
    if (cost.totalTokens === 0) continue;
    const e = expected.get(cost.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    e.input += cost.inputTokens;
    e.output += cost.outputTokens;
    e.cacheRead += cost.cacheReadTokens;
    e.cacheWrite += cost.cacheWriteTokens;
    e.cost += cost.costUsd;
    e.turns += 1;
    expected.set(cost.model, e);
  }

  const rows = await readClaudeUsage(linesOf(content));
  assert.deepEqual(
    rows.map((r) => r.model),
    [...expected.keys()].sort(),
  );
  for (const row of rows) {
    const e = expected.get(row.model)!;
    assert.equal(row.inputTokens, e.input);
    assert.equal(row.outputTokens, e.output);
    assert.equal(row.cacheReadTokens, e.cacheRead);
    assert.equal(row.cacheCreationTokens, e.cacheWrite);
    assert.equal(row.costUsd, Math.round(e.cost * 1e6) / 1e6);
    assert.equal(row.turns, e.turns);
  }
  assert.deepEqual(usageByModel(parseClaudeTranscript(content)), rows);
});

test("the fixture's totals: a repeated message id is counted once and a broken line is skipped", async () => {
  const rows = await readClaudeUsage(linesOf(content));
  assert.deepEqual(rows, [
    {
      model: "claude-nova-9",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.00033,
      unknownModel: true,
      turns: 1,
    },
    {
      model: "claude-opus-5-5",
      inputTokens: 107,
      outputTokens: 53,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      costUsd: 0.002688,
      unknownModel: false,
      turns: 2,
    },
  ]);
});

test("a line that does not parse is skipped, wherever it is", async () => {
  const broken = ["{not json", content, "}{", ""].join("\n");
  assert.deepEqual(await readClaudeUsage(linesOf(broken)), await readClaudeUsage(linesOf(content)));
});

test("a transcript with no usage gives no rows", async () => {
  const text = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
  assert.deepEqual(await readClaudeUsage(linesOf(text)), []);
  assert.deepEqual(await readClaudeUsage(linesOf("")), []);
});

test("the result holds only model names and numbers", async () => {
  const rows = await readClaudeUsage(linesOf(content));
  assert.ok(content.includes(MARKER), "the fixture plants the marker");
  assert.ok(!JSON.stringify(rows).includes(MARKER));
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key === "model") assert.equal(typeof value, "string");
      else if (key === "unknownModel") assert.equal(typeof value, "boolean");
      else assert.equal(typeof value, "number", key);
    }
  }
});

test("parseClaudeTranscript gives the same result through the accumulator as before", () => {
  const session = parseClaudeTranscript(content, "two-models");
  assert.equal(session.totalTurns, 3);
  assert.equal(session.turns[0].userPrompt, `Please fix the login form ${MARKER}`);
  assert.deepEqual(session.turns[0].toolsUsed, ["Read"]);
  assert.equal(session.totalCostUsd, Math.round((0.002688 + 0.00033) * 1e4) / 1e4);
});
