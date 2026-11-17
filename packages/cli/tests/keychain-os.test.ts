import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createKeychain } from "../src/keychain.ts";

// Writes to the real OS keychain, so it runs only when asked: AGENTDOCK_REAL_KEYCHAIN=1.
test(
  "with the real OS keychain a key can be saved, read back and removed",
  { skip: process.env.AGENTDOCK_REAL_KEYCHAIN !== "1" },
  async () => {
    const keychain = createKeychain({ service: `agentdock-test-${randomBytes(6).toString("hex")}` });
    const key = `sk-test-${randomBytes(24).toString("hex")}`;
    try {
      assert.equal(await keychain.get("claude"), null);
      await keychain.set("claude", key);
      assert.equal(await keychain.get("claude"), key);
      await keychain.set("claude", `${key}x`);
      assert.equal(await keychain.get("claude"), `${key}x`);
      assert.equal(await keychain.remove("claude"), true);
      assert.equal(await keychain.get("claude"), null);
      assert.equal(await keychain.remove("claude"), false);
    } finally {
      await keychain.remove("claude").catch(() => false);
    }
  },
);
