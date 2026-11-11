import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/index.ts";

test("regression: redaction keeps no character of the secret value", () => {
  const secrets = {
    env: "STRIPE_SECRET_KEY=Zq9xKp2LmN4vB7wR1tY8",
    openai: "sk-Zq9xKp2LmN4vB7wR1tY8uI0oP3aS6dF5gH",
    github: "ghp_Zq9xKp2LmN4vB7wR1tY8uI0oP3aS6dF5gHjk",
  };
  for (const [name, input] of Object.entries(secrets)) {
    const out = redactSecrets(input).sanitized;
    assert.ok(!out.includes("Zq9x"), `${name} leaked a fragment: ${out}`);
  }
});

test("redaction covers JWTs, bearer tokens, connection-string passwords and Slack tokens", () => {
  const input = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    "postgres://app:hunter2secret@db:5432/main",
    "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "xoxb-123456789012-abcdefghijkl",
  ].join("\n");
  const out = redactSecrets(input).sanitized;
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwx"));
  assert.ok(!out.includes("hunter2secret"));
  assert.ok(out.includes("postgres://app:[REDACTED_SECRET:PASSWORD]@db:5432/main"));
  assert.ok(!out.includes("dozjgNryP4J3"));
  assert.ok(!out.includes("xoxb-123456789012"));
});
