import test from "node:test";
import assert from "node:assert/strict";
import {
  maskAbsolutePaths,
  buildAgentCommitMessage,
  parseAgentCommitTrailers,
} from "../src/agent-commit-tracker.ts";

test("Commit Tracker - maskAbsolutePaths hides machine user paths", () => {
  const unixPath = "Processed file /home/alice/projects/app/main.js";
  assert.equal(maskAbsolutePaths(unixPath), "Processed file [PATH]/main.js");

  const winPath = "Saved output to C:\\Users\\Administrator\\AppData\\local\\file.txt";
  assert.equal(maskAbsolutePaths(winPath), "Saved output to [PATH]/file.txt");
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
