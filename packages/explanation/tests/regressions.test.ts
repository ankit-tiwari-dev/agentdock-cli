import test from "node:test";
import assert from "node:assert/strict";
import { ExplanationEngine } from "../src/index.ts";

function deletedFileDiff(path: string): string {
  return `diff --git a/${path} b/${path}
deleted file mode 100644
index 1111111..0000000
--- a/${path}
+++ /dev/null
@@ -1,1 +0,0 @@
-export const x = 1;
`;
}

test("regression: deleting an auth file is rated HIGH, not LOW", () => {
  const report = new ExplanationEngine().explain({
    sessionId: "s",
    diffUnified: deletedFileDiff("src/auth/login.ts"),
  });
  assert.equal(report.riskLevel, "HIGH");
});

test("regression: deleting a billing file is rated CRITICAL, not LOW", () => {
  const report = new ExplanationEngine().explain({
    sessionId: "s",
    diffUnified: deletedFileDiff("src/billing/stripe.ts"),
  });
  assert.equal(report.riskLevel, "CRITICAL");
});
