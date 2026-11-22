import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { handleSupervisorCommand, type SupervisorDeps } from "../src/commands/supervisor-cmd.ts";
import { readSecret } from "../src/secret-input.ts";
import type { Keychain, KeyProvider } from "../src/keychain.ts";
import { runCli } from "../src/cli.ts";

const FIXTURE = new URL("./fixtures/supervisor.v1.json", import.meta.url);
const plantedKey = () => `sk-ant-${randomBytes(24).toString("hex")}`;

function fakeKeychain(initial: Partial<Record<KeyProvider, string>> = {}) {
  const store = new Map<KeyProvider, string>(Object.entries(initial) as Array<[KeyProvider, string]>);
  const calls: string[] = [];
  const keychain: Keychain = {
    async set(p, secret) {
      calls.push(`set ${p}`);
      store.set(p, secret);
    },
    async get(p) {
      calls.push(`get ${p}`);
      return store.get(p) ?? null;
    },
    async remove(p) {
      calls.push(`remove ${p}`);
      return store.delete(p);
    },
  };
  return { keychain, store, calls };
}

function setup(keys: Partial<Record<KeyProvider, string>> = {}) {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-sup-"));
  const kc = fakeKeychain(keys);
  const deps = (more: Partial<SupervisorDeps> = {}): Partial<SupervisorDeps> => ({
    keychain: kc.keychain,
    env: { CTRLPLANE_HOME: home },
    readSecret: async () => {
      throw new Error("no secret expected");
    },
    ...more,
  });
  const file = join(home, "supervisor.json");
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  return { home, file, deps, cleanup, ...kc };
}

/** Every byte under the folder, so a key written anywhere shows up. */
function allFileText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "latin1"))
    .join("\n");
}

function fakeTty() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    rawModes: [] as boolean[],
    setRawMode(on: boolean) {
      this.rawModes.push(on);
      return this;
    },
  });
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d: Buffer) => (shown += d.toString("utf8")));
  return { input, output, shown: () => shown };
}

test("set-key reads the key at a hidden prompt, saves it under agentdock/claude and echoes none of it", async () => {
  const s = setup();
  try {
    const key = plantedKey();
    const tty = fakeTty();
    const pending = handleSupervisorCommand(
      "set-key",
      ["claude"],
      s.deps({ readSecret: (o) => readSecret({ ...o, input: tty.input, output: tty.output }) }),
    );
    setImmediate(() => tty.input.write(`${key}\r`));
    const res = await pending;
    assert.equal(res.exitCode, 0, res.output);
    assert.equal(res.output, "Key saved for claude in the OS keychain (service agentdock, account claude).");
    assert.equal(s.store.get("claude"), key);
    assert.deepEqual(tty.input.rawModes, [true, false]);
    for (const part of [key, key.slice(7, 15), key.slice(-6)]) assert.equal(tty.shown().includes(part), false);
    assert.equal(allFileText(s.home).includes(key), false);
  } finally {
    s.cleanup();
  }
});

test("set-key --stdin saves the piped key and prints only that it was saved", async () => {
  const s = setup();
  try {
    const key = plantedKey();
    const input = new PassThrough();
    input.end(`${key}\r\n`);
    const res = await handleSupervisorCommand(
      "set-key",
      ["openai-compatible", "--stdin"],
      s.deps({ readSecret: (o) => readSecret({ ...o, input }) }),
    );
    assert.equal(res.exitCode, 0, res.output);
    assert.equal(
      res.output,
      "Key saved for openai-compatible in the OS keychain (service agentdock, account openai-compatible).",
    );
    assert.equal(s.store.get("openai-compatible"), key);
    assert.equal(res.output.includes(key), false);
    assert.equal(allFileText(s.home).includes(key), false);
  } finally {
    s.cleanup();
  }
});

test("regression: set-key refuses a key given as an argument, stores nothing and does not repeat it", async () => {
  const s = setup();
  try {
    const key = plantedKey();
    for (const args of [["claude", key], ["claude", "--stdin", key], [key]]) {
      const res = await handleSupervisorCommand("set-key", args, s.deps());
      assert.equal(res.exitCode, 2, args.join(" "));
      assert.equal(res.output.includes(key.slice(7, 20)), false, res.output);
    }
    const res = await handleSupervisorCommand("set-key", ["claude", key], s.deps());
    assert.equal(
      res.output,
      "Refused: keys are never read from arguments, because arguments are visible in the process list. Run ctrlplane supervisor set-key claude and type the key at the prompt, or pipe it in with --stdin. Nothing was saved.",
    );
    assert.deepEqual(s.calls, []);
  } finally {
    s.cleanup();
  }
});

test("set-key refuses an empty key, a key with spaces or quotes, and a prompt with no terminal", async () => {
  const s = setup();
  try {
    const cases: Array<[string, string]> = [
      ["", "No key given. Nothing was saved."],
      ["two words", "The key has characters a key never has (spaces, quotes or line breaks). Nothing was saved."],
      ["a\nb", "The key has characters a key never has (spaces, quotes or line breaks). Nothing was saved."],
    ];
    for (const [typed, message] of cases) {
      const input = new PassThrough();
      input.end(typed);
      const res = await handleSupervisorCommand(
        "set-key",
        ["claude", "--stdin"],
        s.deps({ readSecret: (o) => readSecret({ ...o, input }) }),
      );
      assert.deepEqual(res, { output: message, exitCode: 2 });
    }
    const notTty = new PassThrough();
    const res = await handleSupervisorCommand(
      "set-key",
      ["claude"],
      s.deps({ readSecret: (o) => readSecret({ ...o, input: notTty, output: new PassThrough() }) }),
    );
    assert.deepEqual(res, { output: "No terminal to prompt in. Pipe the key in with --stdin.", exitCode: 2 });
    assert.deepEqual(s.calls, []);
  } finally {
    s.cleanup();
  }
});

test("remove-key deletes the keychain entry and status then says Key saved: no", async () => {
  const s = setup({ "openai-compatible": plantedKey() });
  try {
    let res = await handleSupervisorCommand("remove-key", ["openai-compatible"], s.deps());
    assert.deepEqual(res, { output: "Key removed for openai-compatible.", exitCode: 0 });
    assert.equal(s.store.has("openai-compatible"), false);
    res = await handleSupervisorCommand("remove-key", ["openai-compatible"], s.deps());
    assert.deepEqual(res, { output: "No key was saved for openai-compatible.", exitCode: 0 });
    await handleSupervisorCommand("use", ["codex"], s.deps());
    res = await handleSupervisorCommand("status", [], s.deps());
    assert.match(res.output, /^Key saved \(openai-compatible\): no$/m);
  } finally {
    s.cleanup();
  }
});

test("use writes version, provider and model, and the base URL only when one was given", async () => {
  const s = setup();
  try {
    let res = await handleSupervisorCommand(
      "use",
      ["openai-compatible", "llama3.2", "--base-url", "http://127.0.0.1:11434/v1/"],
      s.deps(),
    );
    assert.equal(res.exitCode, 0, res.output);
    assert.equal(res.output, `Supervisor: openai-compatible, model llama3.2. Saved in ${s.file}.`);
    assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), JSON.parse(readFileSync(FIXTURE, "utf8")));

    res = await handleSupervisorCommand("use", ["claude", "claude-sonnet-5-5"], s.deps());
    assert.equal(res.output, `Supervisor: claude, model claude-sonnet-5-5. Saved in ${s.file}.`);
    assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), {
      version: 1,
      provider: "claude",
      model: "claude-sonnet-5-5",
      openaiCompatible: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    await handleSupervisorCommand("use", ["claude"], s.deps());
    assert.equal(JSON.parse(readFileSync(s.file, "utf8")).model, "claude-opus-5-5");

    await handleSupervisorCommand("use", ["codex"], s.deps());
    const codex = JSON.parse(readFileSync(s.file, "utf8"));
    assert.equal(codex.provider, "codex");
    assert.equal("model" in codex, false);

    // The saved base URL is reused, so switching back needs no --base-url.
    res = await handleSupervisorCommand("use", ["openai-compatible", "qwen3"], s.deps());
    assert.equal(res.exitCode, 0, res.output);
    assert.equal(JSON.parse(readFileSync(s.file, "utf8")).openaiCompatible.baseUrl, "http://127.0.0.1:11434/v1");
    assert.deepEqual(s.calls, []);
  } finally {
    s.cleanup();
  }
});

test("use refuses an unknown provider, an empty model, a model over 200 characters or with control characters, and writes nothing", async () => {
  const s = setup();
  try {
    const cases: Array<[string[], string]> = [
      [["gemini", "x"], "Unknown provider. Use codex, claude or openai-compatible."],
      [[], "Unknown provider. Use codex, claude or openai-compatible."],
      [["claude", ""], "The model name is empty, too long or has control characters."],
      [["claude", "x".repeat(201)], "The model name is empty, too long or has control characters."],
      [["claude", "a\u0001b"], "The model name is empty, too long or has control characters."],
      [
        ["openai-compatible", "llama3.2"],
        "Set the base URL first in a terminal: ctrlplane supervisor use openai-compatible <model> --base-url <url>",
      ],
      [["openai-compatible", "--base-url", "http://127.0.0.1:1/v1"], "openai-compatible needs a model name."],
      [["claude", "x", "--base-url", "https://a.example"], "--base-url is only for openai-compatible."],
    ];
    for (const [args, message] of cases) {
      const res = await handleSupervisorCommand("use", args, s.deps());
      assert.deepEqual(res, { output: message, exitCode: 2 }, JSON.stringify(args));
      assert.equal(existsSync(s.file), false);
    }
    writeFileSync(s.file, '{"version":1,"provider":"codex"}\n');
    await handleSupervisorCommand("use", ["claude", ""], s.deps());
    assert.equal(readFileSync(s.file, "utf8"), '{"version":1,"provider":"codex"}\n');
  } finally {
    s.cleanup();
  }
});

test("use openai-compatible accepts loopback http and any https, and refuses remote http, user:password, a query or a fragment", async () => {
  const remote = "Refused: a remote base URL must use https. http is allowed only for 127.0.0.1, [::1] and localhost.";
  const parts = "Refused: the base URL must not contain a user name, password, query string or fragment.";
  const cases: Array<[string, string | null]> = [
    ["http://127.0.0.1:11434/v1", null],
    ["http://[::1]:11434/v1", null],
    ["http://localhost:11434/v1", null],
    ["https://x.example/v1", null],
    ["http://192.168.1.5:11434/v1", remote],
    ["http://127.0.0.1.evil.example/v1", remote],
    ["https://u:p@h.example/v1", parts],
    ["https://h.example/v1?a=1", parts],
    ["https://h.example/v1#f", parts],
  ];
  for (const [url, refusal] of cases) {
    const s = setup();
    try {
      const res = await handleSupervisorCommand("use", ["openai-compatible", "m", "--base-url", url], s.deps());
      if (refusal === null) {
        assert.equal(res.exitCode, 0, `${url}: ${res.output}`);
        assert.equal(JSON.parse(readFileSync(s.file, "utf8")).openaiCompatible.baseUrl, url);
      } else {
        assert.deepEqual(res, { output: refusal, exitCode: 2 }, url);
        assert.equal(existsSync(s.file), false, url);
      }
    } finally {
      s.cleanup();
    }
  }
});

test("status prints provider, model, base URL and Key saved per API provider, never the key", async () => {
  const s = setup();
  try {
    let res = await handleSupervisorCommand("status", [], s.deps());
    assert.deepEqual(res, {
      output: "Supervisor: off. Turn it on with: ctrlplane supervisor use <codex|claude|openai-compatible> <model>",
      exitCode: 0,
    });
    const key = plantedKey();
    s.store.set("claude", key);
    await handleSupervisorCommand("use", ["claude", "claude-sonnet-5-5"], s.deps());
    res = await handleSupervisorCommand("status", [], s.deps());
    assert.equal(res.exitCode, 0);
    assert.equal(
      res.output,
      [
        "Supervisor: claude",
        "Model: claude-sonnet-5-5",
        "Base URL: none",
        `Settings file: ${s.file}`,
        "Key saved (claude): yes",
        "Key saved (openai-compatible): no",
      ].join("\n"),
    );
    writeFileSync(s.file, '{"version":7,"provider":"claude"}');
    res = await handleSupervisorCommand("status", [], s.deps());
    assert.equal(res.exitCode, 1);
    assert.match(res.output, /^The supervisor settings file cannot be used \(version\)\./);
  } finally {
    s.cleanup();
  }
});

test("runCli routes supervisor status to the command", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctrlplane-sup-cli-"));
  const prev = process.env.CTRLPLANE_HOME;
  process.env.CTRLPLANE_HOME = home;
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.equal(await runCli(["supervisor", "status"]), 0);
    assert.match(lines.join("\n"), /^Supervisor: off\./);
    lines.length = 0;
    await runCli(["help"]);
    assert.match(lines.join("\n"), /SUPERVISOR PROVIDER COMMANDS/);
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.CTRLPLANE_HOME;
    else process.env.CTRLPLANE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("regression: supervisor commands refuse a relative CTRLPLANE_HOME and never read the project's file", async () => {
  const project = mkdtempSync(join(tmpdir(), "ctrlplane-sup-rel-"));
  const hostile = JSON.stringify({
    version: 1,
    provider: "openai-compatible",
    model: "m",
    openaiCompatible: { baseUrl: "https://attacker.example/v1" },
  });
  mkdirSync(join(project, ".ctrlplane"));
  writeFileSync(join(project, ".ctrlplane", "supervisor.json"), hostile);
  const kc = fakeKeychain({ "openai-compatible": plantedKey() });
  const prev = process.cwd();
  process.chdir(project);
  try {
    for (const [sub, args] of [
      ["status", ["--check"]],
      ["use", ["codex"]],
    ] as const) {
      const res = await handleSupervisorCommand(sub, [...args], {
        keychain: kc.keychain,
        env: { CTRLPLANE_HOME: ".ctrlplane" },
        fetchImpl: async () => {
          throw new Error("no request expected");
        },
      });
      assert.equal(res.exitCode, 2, sub);
      assert.match(res.output, /CTRLPLANE_HOME must be an absolute path/, sub);
    }
    assert.deepEqual(kc.calls, []);
    assert.equal(readFileSync(join(project, ".ctrlplane", "supervisor.json"), "utf8"), hostile);
  } finally {
    process.chdir(prev);
    rmSync(project, { recursive: true, force: true });
  }
});
