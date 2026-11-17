import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { handleSupervisorCommand } from "../src/commands/supervisor-cmd.ts";
import { createKeychain, type KeychainRunner } from "../src/keychain.ts";
import { readSecret } from "../src/secret-input.ts";

/** A keychain tool stand-in for the current OS that remembers one key and records every spawn. */
function osToolFake() {
  const argv: string[] = [];
  let saved: string | null = null;
  const runner: KeychainRunner = async (command, args, stdin) => {
    argv.push([command, ...args].join(" "));
    const set = args.includes("store") || args[0] === "-i" || stdin.includes("::Write(");
    const get = args.includes("lookup") || args.includes("find-generic-password") || stdin.includes("::Read(");
    if (set) {
      const b64 = /FromBase64String\('([^']*)'\)/.exec(stdin)?.[1];
      saved = b64 ? Buffer.from(b64, "base64").toString("utf8") : (/-w "([^"]*)"/.exec(stdin)?.[1] ?? stdin);
      return { code: 0, stdout: "", stderr: `stored ${saved}` };
    }
    if (get) {
      if (saved === null)
        return { code: { win32: 2, darwin: 44 }[process.platform as string] ?? 1, stdout: "", stderr: "" };
      const out = process.platform === "win32" ? Buffer.from(saved).toString("base64") : `${saved}\n`;
      return { code: 0, stdout: out, stderr: "" };
    }
    saved = null;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, argv };
}

async function echoingProvider(status: number) {
  const server = createServer((req, res) => {
    const sent = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { data: [{ id: "m1" }] } : { error: `rejected ${sent}` }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function filesText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "latin1"))
    .join("\n");
}

test("regression: a planted key appears in no file, no output and no check result", async () => {
  const cases = [
    { provider: "claude" as const, key: `sk-ant-${randomBytes(24).toString("hex")}`, model: "m1" },
    { provider: "openai-compatible" as const, key: `planted-${randomBytes(24).toString("hex")}`, model: "m1" },
  ];
  for (const { provider, key, model } of cases) {
    const home = mkdtempSync(join(tmpdir(), "ctrlplane-planted-"));
    const tool = osToolFake();
    const outputs: string[] = [];
    const ok = await echoingProvider(200);
    const rejecting = await echoingProvider(401);
    try {
      for (const fakeUrl of [ok.url, rejecting.url]) {
        const deps = {
          env: { CTRLPLANE_HOME: home },
          keychain: createKeychain({ runner: tool.runner }),
          anthropicBaseUrl: fakeUrl,
          checkTimeoutMs: 2000,
          readSecret: (o: { fromStdin: boolean }) => {
            const input = new PassThrough();
            input.end(`${key}\n`);
            return readSecret({ ...o, input });
          },
        };
        const steps: Array<[string, string[]]> = [
          ["set-key", [provider, "--stdin"]],
          [
            "use",
            provider === "claude" ? ["claude", model] : ["openai-compatible", model, "--base-url", `${fakeUrl}/v1`],
          ],
          ["status", []],
          ["status", ["--check"]],
        ];
        for (const [sub, args] of steps) {
          const res = await handleSupervisorCommand(sub, args, deps);
          outputs.push(res.output);
        }
      }
      assert.match(outputs.join("\n"), /OK: the key works and m1 is available\./);
      assert.match(outputs.join("\n"), /key was rejected/);
      const haystacks = { outputs: outputs.join("\n"), files: filesText(home), argv: tool.argv.join("\n") };
      for (const [where, text] of Object.entries(haystacks)) {
        assert.equal(text.includes(key), false, `${provider} key found in ${where}`);
        assert.equal(text.includes(key.slice(-16)), false, `${provider} key tail found in ${where}`);
      }
    } finally {
      await ok.close();
      await rejecting.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
