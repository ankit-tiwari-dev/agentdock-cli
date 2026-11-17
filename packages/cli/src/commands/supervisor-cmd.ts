import { existsSync, readFileSync } from "node:fs";
import type { CommandResult } from "./policies-cmd.ts";
import {
  DEFAULT_MODEL,
  checkBaseUrl,
  checkModel,
  isProvider,
  parseSupervisorFile,
  supervisorFilePath,
  writeSupervisorFile,
  type SupervisorFile,
} from "../supervisor-config.ts";
import {
  KEY_PROVIDERS,
  KeychainError,
  checkKeyText,
  createKeychain,
  type Keychain,
  type KeyProvider,
} from "../keychain.ts";
import { NoTerminalError, PromptCancelledError, readSecret } from "../secret-input.ts";
import { checkProvider, findOnPath } from "../supervisor-check.ts";

export interface SupervisorDeps {
  keychain: Keychain;
  readSecret: (o: { fromStdin: boolean; prompt?: string }) => Promise<string>;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  anthropicBaseUrl: string;
  checkTimeoutMs: number;
  codexFound: () => boolean;
}

const USAGE = [
  "Usage:",
  "  ctrlplane supervisor set-key <claude|openai-compatible> [--stdin]",
  "  ctrlplane supervisor remove-key <claude|openai-compatible>",
  "  ctrlplane supervisor use <codex|claude|openai-compatible> [model] [--base-url <url>]",
  "  ctrlplane supervisor status [--check]",
].join("\n");

const BAD_KEY_TEXT = "The key has characters a key never has (spaces, quotes or line breaks). Nothing was saved.";
const BAD_MODEL = "The model name is empty, too long or has control characters.";
const UNKNOWN_PROVIDER = "Unknown provider. Use codex, claude or openai-compatible.";
const OFF = "Supervisor: off. Turn it on with: ctrlplane supervisor use <codex|claude|openai-compatible> <model>";

const fail = (output: string, exitCode = 2): CommandResult => ({ output, exitCode });

function isKeyProvider(value: string | undefined): value is KeyProvider {
  return value !== undefined && (KEY_PROVIDERS as readonly string[]).includes(value);
}

function withDefaults(deps: Partial<SupervisorDeps>): SupervisorDeps {
  const env = deps.env ?? process.env;
  return {
    keychain: deps.keychain ?? createKeychain(),
    readSecret: deps.readSecret ?? readSecret,
    env,
    fetchImpl: deps.fetchImpl ?? fetch,
    anthropicBaseUrl: deps.anthropicBaseUrl ?? "https://api.anthropic.com",
    checkTimeoutMs: deps.checkTimeoutMs ?? 15_000,
    codexFound: deps.codexFound ?? (() => findOnPath("codex", env)),
  };
}

// The words after the provider are never echoed: a key pasted there would end up on screen and in logs.
async function setKey(args: string[], d: SupervisorDeps): Promise<CommandResult> {
  const [provider, ...rest] = args;
  if (!isKeyProvider(provider)) return fail("Unknown provider. Keys are stored for claude or openai-compatible.");
  if (rest.some((a) => a !== "--stdin")) {
    return fail(
      `Refused: keys are never read from arguments, because arguments are visible in the process list. Run ctrlplane supervisor set-key ${provider} and type the key at the prompt, or pipe it in with --stdin. Nothing was saved.`,
    );
  }
  let secret: string;
  try {
    secret = await d.readSecret({
      fromStdin: rest.includes("--stdin"),
      prompt: `Key for ${provider} (typing is hidden): `,
    });
  } catch (err) {
    if (err instanceof NoTerminalError || err instanceof PromptCancelledError) return fail(err.message);
    throw err;
  }
  if (secret === "") return fail("No key given. Nothing was saved.");
  if (!checkKeyText(secret)) return fail(BAD_KEY_TEXT);
  try {
    await d.keychain.set(provider, secret);
  } catch (err) {
    if (err instanceof KeychainError) return fail(err.message, 1);
    throw err;
  }
  return {
    output: `Key saved for ${provider} in the OS keychain (service agentdock, account ${provider}).`,
    exitCode: 0,
  };
}

async function removeKey(args: string[], d: SupervisorDeps): Promise<CommandResult> {
  const [provider] = args;
  if (!isKeyProvider(provider) || args.length > 1) {
    return fail("Unknown provider. Keys are stored for claude or openai-compatible.");
  }
  try {
    const removed = await d.keychain.remove(provider);
    return { output: removed ? `Key removed for ${provider}.` : `No key was saved for ${provider}.`, exitCode: 0 };
  } catch (err) {
    if (err instanceof KeychainError) return fail(err.message, 1);
    throw err;
  }
}

/** Fields other tools or newer versions added are kept; only provider, model and base URL change. */
function readExisting(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function use(args: string[], d: SupervisorDeps): CommandResult {
  const at = args.indexOf("--base-url");
  const baseUrlArg = at === -1 ? undefined : (args[at + 1] ?? "");
  const positional = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const [provider, model, ...extra] = positional;
  if (!isProvider(provider) || extra.length > 0) return fail(UNKNOWN_PROVIDER);
  if (model !== undefined && !checkModel(model)) return fail(BAD_MODEL);
  if (baseUrlArg !== undefined && provider !== "openai-compatible") {
    return fail("--base-url is only for openai-compatible.");
  }

  const path = supervisorFilePath(d.env);
  const existing = readExisting(path);
  let baseUrl: string | undefined;
  if (baseUrlArg !== undefined) {
    const checked = checkBaseUrl(baseUrlArg);
    if (!checked.ok) {
      return fail(
        checked.problem === "remote-http" || checked.problem === "scheme" || checked.problem === "invalid"
          ? "Refused: a remote base URL must use https. http is allowed only for 127.0.0.1, [::1] and localhost."
          : "Refused: the base URL must not contain a user name, password, query string or fragment.",
      );
    }
    baseUrl = checked.url;
  } else {
    const saved = (existing.openaiCompatible as { baseUrl?: unknown } | undefined)?.baseUrl;
    if (typeof saved === "string" && checkBaseUrl(saved).ok) baseUrl = saved;
  }

  if (provider === "openai-compatible") {
    if (model === undefined) return fail("openai-compatible needs a model name.");
    if (baseUrl === undefined) {
      return fail(
        "Set the base URL first in a terminal: ctrlplane supervisor use openai-compatible <model> --base-url <url>",
      );
    }
  }

  const chosenModel = model ?? DEFAULT_MODEL[provider];
  const kept = Object.fromEntries(
    Object.entries(existing).filter(([k]) => !["version", "provider", "model", "openaiCompatible"].includes(k)),
  );
  const file: SupervisorFile = {
    version: 1,
    provider,
    ...(chosenModel !== undefined ? { model: chosenModel } : {}),
    ...(baseUrl !== undefined ? { openaiCompatible: { baseUrl } } : {}),
    ...kept,
  };
  writeSupervisorFile(path, file);
  const modelText = chosenModel !== undefined ? `model ${chosenModel}` : "Codex's default model";
  return { output: `Supervisor: ${provider}, ${modelText}. Saved in ${path}.`, exitCode: 0 };
}

async function status(args: string[], d: SupervisorDeps): Promise<CommandResult> {
  const path = supervisorFilePath(d.env);
  if (!existsSync(path)) return { output: OFF, exitCode: 0 };
  const parsed = parseSupervisorFile(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    return fail(
      `The supervisor settings file cannot be used (${parsed.problem}). Rewrite it with: ctrlplane supervisor use <provider> <model>`,
      1,
    );
  }
  const file = parsed.value;
  const lines = [
    `Supervisor: ${file.provider}`,
    `Model: ${file.model ?? "Codex default"}`,
    `Base URL: ${file.openaiCompatible?.baseUrl ?? "none"}`,
    `Settings file: ${path}`,
  ];
  let activeKey: string | null = null;
  let keychainProblem: string | undefined;
  for (const p of KEY_PROVIDERS) {
    try {
      const key = await d.keychain.get(p);
      if (p === file.provider) activeKey = key;
      lines.push(`Key saved (${p}): ${key === null ? "no" : "yes"}`);
    } catch (err) {
      if (!(err instanceof KeychainError)) throw err;
      keychainProblem = err.message;
      lines.push(`Key saved (${p}): not readable`);
    }
  }
  if (keychainProblem) lines.push(keychainProblem);
  if (!args.includes("--check")) return { output: lines.join("\n"), exitCode: 0 };

  const result = await checkProvider(file, activeKey, {
    fetchImpl: d.fetchImpl,
    anthropicBaseUrl: d.anthropicBaseUrl,
    timeoutMs: d.checkTimeoutMs,
    codexFound: d.codexFound,
  });
  lines.push(result.message);
  return { output: lines.join("\n"), exitCode: result.ok ? 0 : 1 };
}

export async function handleSupervisorCommand(
  sub: string | undefined,
  args: string[],
  deps: Partial<SupervisorDeps> = {},
): Promise<CommandResult> {
  const d = withDefaults(deps);
  switch (sub) {
    case "set-key":
      return setKey(args, d);
    case "remove-key":
      return removeKey(args, d);
    case "use":
      return use(args, d);
    case "status":
      return status(args, d);
    case undefined:
    case "help":
      return { output: USAGE, exitCode: 0 };
    default:
      return fail(USAGE);
  }
}
