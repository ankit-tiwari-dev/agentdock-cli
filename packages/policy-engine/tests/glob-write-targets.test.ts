import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine, createBuiltinRules } from "../src/index.ts";

const ROOT = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";

function decide(engine: PolicyEngine, command: string) {
  return engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command }, projectRoot: ROOT });
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.CTRLPLANE_HOME;
  process.env.CTRLPLANE_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CTRLPLANE_HOME;
    else process.env.CTRLPLANE_HOME = prev;
  }
}

test("regression: glob write targets that the shell expands into protected paths are denied", () => {
  const home = join(tmpdir(), "cp-home-glob-guard");
  withHome(home, () => {
    const engine = new PolicyEngine(createBuiltinRules({ protectedFiles: [join(ROOT, "rules", "custom.ts")] }));
    const denied = [
      "cp /tmp/x .ctrl?lane/policies.json",
      "cp /tmp/x .ctrlplan[e]/policies.json",
      "install -m644 a .ctrl?lane/policies.json",
      "cp /tmp/x .ctrl*/policies.json",
      "cp /tmp/x .ctrl{plane,x}/policies.json",
      "cp /tmp/x ./.ctrl?lane/specs/a.md",
      "echo x > .ctrl?lane/policies.json",
      "cp /tmp/x .gi?/hooks/pre-commit",
      "cp /tmp/x .g[i]t/config",
      "cp /tmp/x $CTRLPLANE_HOME/polic?es.json",
      "cp /tmp/x rules/cust?m.ts",
      "cd src && cp /tmp/x ../.ctrl?lane/policies.json",
    ];
    for (const command of denied) {
      const res = decide(engine, command);
      assert.equal(res.decision, "DENY", `${command} -> ${res.decision} (${res.matchedRuleId ?? "-"})`);
      assert.equal(res.matchedRuleId, "RULE-BLOCK-CTRLPLANE-MUTATION", command);
    }
    for (const command of [
      "cp a src/*.ts dist/",
      "touch build/x?.log",
      "cp a.txt src/[ab].ts",
      "rm dist/*.js",
      "cp a ?ctrlplane.txt",
      "cp a docs/{a,b}.md",
    ]) {
      const res = decide(engine, command);
      assert.equal(res.decision, "ALLOW", `${command} -> ${res.decision} (${res.matchedRuleId ?? "-"})`);
    }
  });
});
