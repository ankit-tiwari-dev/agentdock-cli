import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SupervisorFile } from "./supervisor-config.ts";

export type SupervisorCheckCode =
  | "KEY_MISSING"
  | "KEY_REJECTED"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "UNREACHABLE"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "CODEX_FAILED";

export type CheckResult = { ok: true; message: string } | { ok: false; code: SupervisorCheckCode; message: string };

export interface CheckOptions {
  fetchImpl: typeof fetch;
  anthropicBaseUrl: string;
  timeoutMs: number;
  codexFound: () => boolean;
}

export const PROVIDER_LABEL = { codex: "Codex", claude: "Claude", "openai-compatible": "OpenAI-compatible" } as const;
const ANTHROPIC_VERSION = "2023-06-01";

/** Every message is fixed text plus values from the settings file; the provider's body is never shown. */
function failure(code: SupervisorCheckCode, file: SupervisorFile, status?: number): CheckResult {
  const provider = file.provider;
  const messages: Record<SupervisorCheckCode, string> = {
    KEY_MISSING: `No ${PROVIDER_LABEL[provider]} key saved. Run: ctrlplane supervisor set-key ${provider}`,
    KEY_REJECTED: `The ${PROVIDER_LABEL[provider]} key was rejected. Save a new one with: ctrlplane supervisor set-key ${provider}`,
    MODEL_NOT_FOUND: `Model ${file.model} was not found. Pick another with: ctrlplane supervisor use ${provider} <model>`,
    RATE_LIMITED: "The provider is rate limiting requests. Try again later.",
    UNREACHABLE: "The provider is unreachable or timed out after 15 seconds. Check your network or local model server.",
    TIMEOUT: "The provider is unreachable or timed out after 15 seconds. Check your network or local model server.",
    PROVIDER_ERROR: `The provider returned an error (HTTP ${status ?? 0}). Try again later.`,
    CODEX_FAILED: "Codex CLI could not be started. Install it or set AGENTDOCK_CODEX_PATH.",
  };
  return { ok: false, code, message: messages[code] };
}

function classifyStatus(status: number): SupervisorCheckCode {
  if (status === 401 || status === 403) return "KEY_REJECTED";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

export function findOnPath(name: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.AGENTDOCK_CODEX_PATH) return existsSync(env.AGENTDOCK_CODEX_PATH);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate) && statSync(candidate).isFile()) return true;
    }
  }
  return false;
}

/** One free models-list call: proves the key, the address and the model without paying for a run. */
export async function checkProvider(file: SupervisorFile, key: string | null, o: CheckOptions): Promise<CheckResult> {
  if (file.provider === "codex") {
    return o.codexFound()
      ? { ok: true, message: "OK: Codex CLI found (model not checked)." }
      : failure("CODEX_FAILED", file);
  }
  if (file.provider === "claude" && !key) return failure("KEY_MISSING", file);

  const url =
    file.provider === "claude"
      ? `${o.anthropicBaseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`
      : `${file.openaiCompatible?.baseUrl}/models`;
  const headers: Record<string, string> =
    file.provider === "claude"
      ? { "x-api-key": key ?? "", "anthropic-version": ANTHROPIC_VERSION }
      : key
        ? { authorization: `Bearer ${key}` }
        : {};

  let res: Response;
  try {
    res = await o.fetchImpl(url, { headers, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    return failure(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "UNREACHABLE", file);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return failure(classifyStatus(res.status), file, res.status);
  }
  let ids: string[];
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    ids = (body.data ?? []).map((m) => String(m.id));
  } catch {
    return failure("PROVIDER_ERROR", file, res.status);
  }
  if (!file.model || !ids.includes(file.model)) return failure("MODEL_NOT_FOUND", file);
  return { ok: true, message: `OK: the key works and ${file.model} is available.` };
}
