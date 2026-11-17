import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSupervisorCommand } from "../src/commands/supervisor-cmd.ts";
import type { Keychain, KeyProvider } from "../src/keychain.ts";

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

/** A loopback provider that echoes the key it was sent in every error body. */
async function fakeProvider(answer: { status: number; models?: string[] } | "hang") {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (answer === "hang") return;
    const sent = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "");
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(
      answer.status === 200
        ? JSON.stringify({ data: (answer.models ?? []).map((id) => ({ id })) })
        : JSON.stringify({ error: { message: `bad key ${sent}` } }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function keychainWith(keys: Partial<Record<KeyProvider, string>>): Keychain {
  return {
    set: async () => {},
    get: async (p) => keys[p] ?? null,
    remove: async () => false,
  };
}

async function check(
  provider: "claude" | "openai-compatible",
  key: string | null,
  answer: Parameters<typeof fakeProvider>[0],
) {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-check-"));
  const fake = await fakeProvider(answer);
  try {
    const deps = {
      env: { CTRLPLANE_HOME: home },
      keychain: keychainWith(key ? { [provider]: key } : {}),
      anthropicBaseUrl: fake.url,
      checkTimeoutMs: 300,
    };
    const useArgs =
      provider === "claude"
        ? ["claude", "claude-opus-5-5"]
        : ["openai-compatible", "llama3.2", "--base-url", `${fake.url}/v1`];
    assert.equal((await handleSupervisorCommand("use", useArgs, deps)).exitCode, 0);
    const res = await handleSupervisorCommand("status", ["--check"], deps);
    return { res, seen: fake.seen, url: fake.url };
  } finally {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const plantedKey = () => `sk-ant-${randomBytes(24).toString("hex")}`;

test("status --check makes one models-list call and prints OK when the key works and the model is listed", async () => {
  const key = plantedKey();
  const claude = await check("claude", key, { status: 200, models: ["claude-sonnet-5-5", "claude-opus-5-5"] });
  assert.equal(claude.res.exitCode, 0, claude.res.output);
  assert.match(claude.res.output, /\nOK: the key works and claude-opus-5-5 is available\.$/);
  assert.equal(claude.seen.length, 1);
  assert.equal(claude.seen[0].method, "GET");
  assert.match(claude.seen[0].url ?? "", /^\/v1\/models/);
  assert.equal(claude.seen[0].headers["x-api-key"], key);
  assert.ok(claude.seen[0].headers["anthropic-version"]);

  const local = await check("openai-compatible", null, { status: 200, models: ["llama3.2"] });
  assert.equal(local.res.exitCode, 0, local.res.output);
  assert.match(local.res.output, /\nOK: the key works and llama3\.2 is available\.$/);
  assert.equal(local.seen.length, 1);
  assert.equal(local.seen[0].url, "/v1/models");
  assert.equal(local.seen[0].headers.authorization, undefined);

  const withKey = await check("openai-compatible", key, { status: 200, models: ["llama3.2"] });
  assert.equal(withKey.seen[0].headers.authorization, `Bearer ${key}`);
});

test("status --check prints the classified message for a rejected key, an unlisted model, a rate limit and an unreachable server", async () => {
  const key = plantedKey();
  const cases: Array<[Parameters<typeof fakeProvider>[0], string]> = [
    [{ status: 401 }, "The Claude key was rejected. Save a new one with: ctrlplane supervisor set-key claude"],
    [{ status: 403 }, "The Claude key was rejected. Save a new one with: ctrlplane supervisor set-key claude"],
    [
      { status: 200, models: ["claude-haiku-5-5"] },
      "Model claude-opus-5-5 was not found. Pick another with: ctrlplane supervisor use claude <model>",
    ],
    [{ status: 429 }, "The provider is rate limiting requests. Try again later."],
    [{ status: 500 }, "The provider returned an error (HTTP 500). Try again later."],
    ["hang", "The provider is unreachable or timed out after 15 seconds. Check your network or local model server."],
  ];
  for (const [answer, message] of cases) {
    const { res } = await check("claude", key, answer);
    assert.equal(res.exitCode, 1, JSON.stringify(answer));
    assert.equal(res.output.split("\n").at(-1), message);
    assert.equal(res.output.includes(key.slice(7, 20)), false, res.output);
  }

  const missing = await check("claude", null, { status: 200, models: ["claude-opus-5-5"] });
  assert.equal(missing.res.output.split("\n").at(-1), "No Claude key saved. Run: ctrlplane supervisor set-key claude");
  assert.equal(missing.seen.length, 0);

  const home = mkdtempSync(join(tmpdir(), "ctrlplane-check-"));
  try {
    const deps = { env: { CTRLPLANE_HOME: home }, keychain: keychainWith({}), checkTimeoutMs: 300 };
    await handleSupervisorCommand("use", ["openai-compatible", "m", "--base-url", "http://127.0.0.1:9/v1"], deps);
    const res = await handleSupervisorCommand("status", ["--check"], deps);
    assert.equal(res.exitCode, 1);
    assert.match(res.output.split("\n").at(-1)!, /^The provider is unreachable or timed out after 15 seconds\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status --check for codex looks only for the codex program", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-check-"));
  try {
    const deps = { env: { CTRLPLANE_HOME: home }, keychain: keychainWith({}) };
    await handleSupervisorCommand("use", ["codex"], deps);
    const found = await handleSupervisorCommand("status", ["--check"], { ...deps, codexFound: () => true });
    assert.equal(found.exitCode, 0);
    assert.match(found.output, /\nOK: Codex CLI found \(model not checked\)\.$/);
    const missing = await handleSupervisorCommand("status", ["--check"], { ...deps, codexFound: () => false });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.output, /\nCodex CLI could not be started\. Install it or set AGENTDOCK_CODEX_PATH\.$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
