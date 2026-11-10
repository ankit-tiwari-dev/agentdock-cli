import { dispatchHook } from "../../../agent-adapters/src/index.ts";
import type { AgentHookPayload } from "../../../core/src/index.ts";

export async function handleHookCommand(eventName: string): Promise<number> {
  const stdinPayload = await readAllStdin();
  let parsedPayload: Record<string, unknown> = {};

  if (stdinPayload.trim()) {
    try {
      parsedPayload = JSON.parse(stdinPayload);
    } catch {
      // Fallback
    }
  }

  const payload: AgentHookPayload = {
    hookEventName: (eventName as AgentHookPayload["hookEventName"]) || "PreToolUse",
    cwd: String(parsedPayload.cwd || process.cwd()),
    sessionId: parsedPayload.sessionId ? String(parsedPayload.sessionId) : undefined,
    toolName: parsedPayload.toolName ? String(parsedPayload.toolName) : undefined,
    toolInput: (parsedPayload.toolInput as Record<string, unknown>) || undefined,
    toolResponse: (parsedPayload.toolResponse as Record<string, unknown>) || undefined,
    prompt: parsedPayload.prompt ? String(parsedPayload.prompt) : undefined,
  };

  const response = await dispatchHook(payload);

  if (response.exitCode === 2 && response.stderrMessage) {
    process.stderr.write(`${response.stderrMessage}\n`);
  } else if (response.stdoutMessage) {
    process.stdout.write(`${response.stdoutMessage}\n`);
  }

  return response.exitCode;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

