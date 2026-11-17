import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { KeychainError, checkKeyText, createKeychain, type KeychainRunner, type RunResult } from "../src/keychain.ts";

const PLATFORMS = ["win32", "darwin", "linux"] as const;
const plantedKey = () => `sk-ant-${randomBytes(24).toString("hex")}`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

interface Call {
  command: string;
  args: readonly string[];
  stdin: string;
}

function fakeRunner(reply: (call: Call) => RunResult): { runner: KeychainRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: KeychainRunner = async (command, args, stdin) => {
    const call = { command, args: [...args], stdin };
    calls.push(call);
    return reply(call);
  };
  return { runner, calls };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const notFound: Record<string, RunResult> = {
  win32: { code: 2, stdout: "", stderr: "" },
  darwin: { code: 44, stdout: "", stderr: "" },
  linux: { code: 1, stdout: "", stderr: "" },
};

test("on Windows, macOS and Linux the key reaches the OS tool on stdin and never in its arguments", async () => {
  for (const platform of PLATFORMS) {
    const key = plantedKey();
    const { runner, calls } = fakeRunner(() => ok());
    await createKeychain({ platform, runner }).set("claude", key);
    assert.equal(calls.length, 1, platform);
    const [call] = calls;
    assert.equal(call.command, { win32: "powershell.exe", darwin: "security", linux: "secret-tool" }[platform]);
    const argv = call.args.join(" ");
    for (const form of [key, b64(key), key.slice(7, 30)]) {
      assert.equal(argv.includes(form), false, `${platform} put the key in argv: ${argv}`);
    }
    assert.ok(call.stdin.includes(platform === "win32" ? b64(key) : key), platform);
  }
});

test("a saved key is read back exactly from each OS tool's output", async () => {
  for (const platform of PLATFORMS) {
    const key = plantedKey();
    const out = platform === "win32" ? b64(key) : `${key}\n`;
    const { runner } = fakeRunner(() => ok(out));
    assert.equal(await createKeychain({ platform, runner }).get("claude"), key, platform);
  }
});

test("read and delete name only service agentdock and the provider account", async () => {
  for (const platform of PLATFORMS) {
    const { runner, calls } = fakeRunner(() => notFound[platform]);
    const keychain = createKeychain({ platform, runner });
    assert.equal(await keychain.get("openai-compatible"), null, platform);
    assert.equal(await keychain.remove("openai-compatible"), false, platform);
    for (const c of calls) {
      const named = platform === "win32" ? c.stdin : c.args.join(" ");
      assert.ok(named.includes("agentdock"), `${platform}: ${named}`);
      assert.ok(named.includes("openai-compatible"), `${platform}: ${named}`);
      if (platform !== "win32") assert.equal(c.stdin, "", platform);
    }
  }
  const expected: Record<string, string[]> = {
    darwin: ["find-generic-password", "-s", "agentdock", "-a", "claude", "-w"],
    linux: ["lookup", "service", "agentdock", "account", "claude"],
  };
  for (const [platform, args] of Object.entries(expected)) {
    const { runner, calls } = fakeRunner(() => notFound[platform]);
    await createKeychain({ platform: platform as NodeJS.Platform, runner }).get("claude");
    assert.deepEqual(calls[0].args, args);
  }
});

test("removing a saved key deletes it from each OS tool", async () => {
  for (const platform of PLATFORMS) {
    const { runner, calls } = fakeRunner(() => ok(platform === "win32" ? b64("x") : "x"));
    assert.equal(await createKeychain({ platform, runner }).remove("claude"), true, platform);
    const last = calls.at(-1)!;
    const named = platform === "win32" ? last.stdin : last.args.join(" ");
    assert.match(named, { win32: /CredDelete/, darwin: /delete-generic-password/, linux: /^clear / }[platform]!);
  }
});

test("a missing keychain tool gives a clear message and stores nothing", async () => {
  const hints: Record<string, RegExp> = {
    linux: /Install libsecret-tools \(Debian\/Ubuntu\) or libsecret \(Fedora\/Arch\)/,
    darwin: /security tool not found/,
    win32: /Windows PowerShell not found/,
  };
  for (const platform of PLATFORMS) {
    const spawnError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    const { runner, calls } = fakeRunner(() => ({ code: null, stdout: "", stderr: "", spawnError }));
    await assert.rejects(createKeychain({ platform, runner }).set("claude", plantedKey()), (err: unknown) => {
      assert.ok(err instanceof KeychainError);
      assert.equal(err.reason, "unavailable");
      assert.match(err.message, hints[platform]);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("a key with spaces, quotes, backslashes or line breaks is refused before any tool runs", async () => {
  assert.equal(checkKeyText("sk-ant-abc_DEF-123"), true);
  for (const bad of ["", "a b", 'a"b', "a'b", "a\\b", "a\nb", "é", "x".repeat(4097)]) {
    assert.equal(checkKeyText(bad), false, JSON.stringify(bad));
  }
  const { runner, calls } = fakeRunner(() => ok());
  await assert.rejects(createKeychain({ platform: "darwin", runner }).set("claude", 'a" -w "b'));
  assert.equal(calls.length, 0);
});
