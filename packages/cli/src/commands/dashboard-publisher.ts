import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { redactObject, redactSecrets } from "../../../storage/src/index.ts";
import type { AgentHookPayload, HookVerdictResponse } from "../../../core/src/index.ts";

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:45820/api/events/broadcast";
const PUBLISH_TIMEOUT_MS = 200;

/** Best-effort local telemetry delivery. A dashboard outage must never change an agent verdict. */
export function publishDashboardEvent(
  payload: AgentHookPayload,
  verdict: HookVerdictResponse,
  projectRoot: string,
): Promise<void> {
  const eventType = payload.hookEventName;
  const type = eventType === "PreToolUse"
    ? "agent_tool_executing"
    : eventType === "PostToolUse"
      ? "agent_tool_completed"
      : eventType === "SessionStart" || eventType === "SessionEnd"
        ? "agent_session_updated"
        : undefined;
  if (!type || payload.control) return Promise.resolve();

  const configuredUrl = process.env.CTRLPLANE_DASHBOARD_URL;
  if (configuredUrl === "off" || configuredUrl === "") return Promise.resolve();
  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl || DEFAULT_DASHBOARD_URL);
  } catch {
    return Promise.resolve();
  }
  if (endpoint.protocol !== "http:") return Promise.resolve();

  const sanitize = (value: unknown) => {
    const redacted = typeof value === "string"
      ? redactSecrets(value).sanitized
      : value && typeof value === "object"
        ? redactObject(value)
        : value;
    if (redacted === undefined) return undefined;
    const serialized = JSON.stringify(redacted);
    return serialized.length > 30_000
      ? { truncated: true, preview: serialized.slice(0, 20_000), originalCharacters: serialized.length }
      : redacted;
  };
  const timestamp = Date.now();
  const event = {
    type,
    sessionId: payload.sessionId || `${payload.agent || "agent"}:${projectRoot}`,
    timestamp,
    data: {
      eventId: randomUUID(),
      hookEventName: eventType,
      agent: payload.agent || "custom",
      projectPath: projectRoot,
      toolName: payload.toolName,
      toolInput: sanitize(payload.toolInput),
      toolOutput: sanitize(payload.toolResponse),
      decision: verdict.decision,
      reason: verdict.stderrMessage ? redactSecrets(verdict.stderrMessage).sanitized : undefined,
      ruleId: verdict.matchedRuleId,
      observedOnly: verdict.observedOnly ?? false,
      latencyMs: verdict.latencyMs,
      source: "ctrlplane",
    },
  };
  const body = JSON.stringify(event);

  return new Promise((resolve) => {
    const req = request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.setTimeout(PUBLISH_TIMEOUT_MS, () => req.destroy());
    req.on("error", resolve);
    req.end(body);
  });
}
