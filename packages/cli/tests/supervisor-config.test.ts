import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBaseUrl,
  checkModel,
  parseSupervisorFile,
  supervisorFilePath,
  writeSupervisorFile,
} from "../src/supervisor-config.ts";

const FIXTURE = new URL("./fixtures/supervisor.v1.json", import.meta.url);

test("the settings file parser refuses an unknown version, provider, empty model or a bad base URL", () => {
  const good = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(parseSupervisorFile(JSON.stringify(good)), { ok: true, value: good });
  assert.deepEqual(parseSupervisorFile(JSON.stringify({ version: 1, provider: "codex" })), {
    ok: true,
    value: { version: 1, provider: "codex" },
  });

  const cases: Array<[string, string]> = [
    ["{not json", "json"],
    ["[]", "json"],
    [JSON.stringify({ ...good, version: 2 }), "version"],
    [JSON.stringify({ ...good, provider: "gemini" }), "provider"],
    [JSON.stringify({ ...good, model: "" }), "model"],
    [JSON.stringify({ version: 1, provider: "claude" }), "model"],
    [JSON.stringify({ ...good, model: "a\u0007b" }), "model"],
    [JSON.stringify({ ...good, openaiCompatible: { baseUrl: "http://192.168.1.5:11434/v1" } }), "base-url"],
    [JSON.stringify({ version: 1, provider: "openai-compatible", model: "llama3.2" }), "base-url"],
  ];
  for (const [text, problem] of cases) {
    assert.deepEqual(parseSupervisorFile(text), { ok: false, problem }, text);
  }

  assert.equal(checkModel("x".repeat(200)), true);
  assert.equal(checkModel("x".repeat(201)), false);
  assert.equal(checkModel("a\u007fb"), false);
  assert.deepEqual(checkBaseUrl("https://x.example/v1/"), { ok: true, url: "https://x.example/v1" });
  assert.deepEqual(checkBaseUrl("ftp://x.example"), { ok: false, problem: "scheme" });
  assert.deepEqual(checkBaseUrl("not a url"), { ok: false, problem: "invalid" });
});

test("writing the settings file leaves no temp file and keeps unknown fields", () => {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-supcfg-"));
  try {
    const path = supervisorFilePath({ CTRLPLANE_HOME: home });
    assert.equal(path, join(home, "supervisor.json"));
    writeFileSync(path, JSON.stringify({ version: 1, provider: "codex", note: "mine" }));
    const parsed = parseSupervisorFile(readFileSync(path, "utf8"));
    assert.ok(parsed.ok);
    writeSupervisorFile(path, { ...parsed.value, provider: "claude", model: "claude-opus-5-5" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 1,
      provider: "claude",
      model: "claude-opus-5-5",
      note: "mine",
    });
    assert.deepEqual(readdirSync(home), ["supervisor.json"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("regression: an empty CTRLPLANE_HOME means ~/.ctrlplane and a relative one is refused", () => {
  // An empty or relative value made the settings file resolve inside the current folder, which the agent can write.
  assert.equal(
    supervisorFilePath({ CTRLPLANE_HOME: "" }, "/home/dev"),
    join("/home/dev", ".ctrlplane", "supervisor.json"),
  );
  assert.equal(supervisorFilePath({}, "/home/dev"), join("/home/dev", ".ctrlplane", "supervisor.json"));
  for (const value of [".ctrlplane", "state", "./x"]) {
    assert.throws(
      () => supervisorFilePath({ CTRLPLANE_HOME: value }, "/home/dev"),
      /CTRLPLANE_HOME must be an absolute path/,
    );
  }
});
