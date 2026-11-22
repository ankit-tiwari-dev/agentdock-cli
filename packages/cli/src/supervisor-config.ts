import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ctrlplaneHome } from "../../core/src/index.ts";

export type ProviderName = "codex" | "claude" | "openai-compatible";
export const PROVIDERS: readonly ProviderName[] = ["codex", "claude", "openai-compatible"];

export interface SupervisorFile {
  version: 1;
  provider: ProviderName;
  model?: string;
  openaiCompatible?: { baseUrl: string };
  [extra: string]: unknown;
}

export type ParseProblem = "json" | "version" | "provider" | "model" | "base-url";
export type ParseResult = { ok: true; value: SupervisorFile } | { ok: false; problem: ParseProblem };

export type BaseUrlProblem = "invalid" | "scheme" | "remote-http" | "credentials" | "query" | "fragment";
export type BaseUrlCheck = { ok: true; url: string } | { ok: false; problem: BaseUrlProblem };

export const DEFAULT_MODEL: Partial<Record<ProviderName, string>> = { claude: "claude-opus-5-5" };

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function checkModel(model: string): boolean {
  // eslint-disable-next-line no-control-regex
  return model.length >= 1 && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model);
}

/** The key travels with every request, so it may only go over plain http to this machine. */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem: "scheme" };
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return { ok: false, problem: "remote-http" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (url.search || raw.includes("?")) return { ok: false, problem: "query" };
  if (url.hash || raw.includes("#")) return { ok: false, problem: "fragment" };
  return { ok: true, url: url.href.replace(/\/+$/, "") };
}

/** Unknown top-level fields are kept, so a newer CLI's additions survive an older one's rewrite. */
export function parseSupervisorFile(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: "json" };
  const file = value as Record<string, unknown>;
  if (file.version !== 1) return { ok: false, problem: "version" };
  if (!isProvider(file.provider)) return { ok: false, problem: "provider" };
  if (file.model !== undefined && (typeof file.model !== "string" || !checkModel(file.model))) {
    return { ok: false, problem: "model" };
  }
  if (file.provider !== "codex" && file.model === undefined) return { ok: false, problem: "model" };
  if (file.openaiCompatible !== undefined || file.provider === "openai-compatible") {
    const base = (file.openaiCompatible as { baseUrl?: unknown } | undefined)?.baseUrl;
    if (typeof base !== "string" || !checkBaseUrl(base).ok) return { ok: false, problem: "base-url" };
  }
  return { ok: true, value: file as SupervisorFile };
}

export function supervisorFilePath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(ctrlplaneHome(env, home), "supervisor.json");
}

/** Written to a temp file and renamed over the target, so a reader never sees half a file. */
export function writeSupervisorFile(path: string, value: SupervisorFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
