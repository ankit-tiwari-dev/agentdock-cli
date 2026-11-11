import { DAEMON_UNAVAILABLE, dispatchHook } from "../../../agent-adapters/src/hook-client.ts";
import { formatHookOutput, type HookProcessOutput } from "../../../agent-adapters/src/hook-output.ts";
import { normalizeHookPayload, type AgentHookPayload, type HookVerdictResponse } from "../../../core/src/index.ts";
import { findProjectRoot } from "../../../daemon/src/lock.ts";

export interface HookRunOptions {
  agent?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Extra context to inject (SessionStart context pack). Resolved lazily so other events stay fast. */
  contextProvider?: (payload: AgentHookPayload, projectRoot: string) => Promise<string | undefined>;
}

// Tool-call hooks stay on the fast path: only these events load the context store.
const CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);

/** Pure core of the hook shim: stdin text in, process output out. */
export async function runHook(eventName: string | undefined, stdinText: string, options: HookRunOptions = {}): Promise<HookProcessOutput> {
  // The summariser's own `claude -p` child must never be supervised by, or recorded into, the session it summarises.
  if (process.env.CTRLPLANE_NESTED === "1") return { exitCode: 0 };

  let raw: Record<string, unknown> = {};
  if (stdinText.trim()) {
    try {
      const parsed = JSON.parse(stdinText);
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
    } catch {
      // Unparseable input still goes through with what we know (event name, cwd).
    }
  }

  const fallbackCwd = options.cwd ?? process.cwd();
  const payload = normalizeHookPayload(eventName, raw, fallbackCwd, options.agent);
  const projectRoot = findProjectRoot(payload.cwd) ?? findProjectRoot(fallbackCwd) ?? payload.cwd;

  let verdict = await dispatchHook(payload, { projectPath: projectRoot, timeoutMs: options.timeoutMs });

  // No daemon: still enforce the rules in-process rather than letting everything through.
  if (verdict.decision === "ALLOW" && verdict.matchedRuleId === DAEMON_UNAVAILABLE) {
    verdict = await evaluateLocally(payload, projectRoot);
    if (CONTEXT_EVENTS.has(payload.hookEventName)) {
      try {
        const { recordWithoutDaemon } = await import("../../../context/src/hook-context.ts");
        recordWithoutDaemon(payload, projectRoot);
      } catch {
        // Context is a convenience; it must never change the verdict.
      }
    }
  }

  let extraContext: string | undefined;
  if (options.contextProvider && (payload.hookEventName === "SessionStart" || payload.hookEventName === "UserPromptSubmit")) {
    try {
      extraContext = await options.contextProvider(payload, projectRoot);
    } catch {
      extraContext = undefined;
    }
  }

  return formatHookOutput(payload, verdict, extraContext);
}

async function evaluateLocally(payload: AgentHookPayload, projectRoot: string): Promise<HookVerdictResponse> {
  const { buildProjectEngine, PolicyEngine } = await import("../../../policy-engine/src/index.ts");
  let engine: InstanceType<typeof PolicyEngine>;
  let paused = false;
  try {
    const project = await buildProjectEngine(projectRoot);
    engine = project.engine;
    paused = project.isPaused();
  } catch {
    // A broken config must not switch supervision off: fall back to the built-in rules.
    engine = new PolicyEngine();
  }
  const result = engine.evaluate({
    paused,
    event: payload.hookEventName,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
    toolResponse: payload.toolResponse,
    prompt: payload.prompt,
    projectRoot,
    stopHookActive: payload.stopHookActive,
    permissionMode: payload.permissionMode,
  });
  return {
    decision: result.decision,
    exitCode: result.decision === "DENY" ? 2 : 0,
    stderrMessage: result.decision === "ALLOW" ? undefined : result.reason,
    steeringInstruction: result.steeringInstruction,
    matchedRuleId: result.matchedRuleId,
    latencyMs: result.latencyMs,
  };
}

export async function handleHookCommand(eventName: string, args: string[] = []): Promise<number> {
  const agentFlag = args.indexOf("--agent");
  const agent = agentFlag !== -1 ? args[agentFlag + 1] : undefined;
  const stdinPayload = await readAllStdin();

  const out = await runHook(eventName, stdinPayload, {
    agent,
    contextProvider: async (payload, root) => (await import("../../../context/src/hook-context.ts")).contextForHook(payload, root),
  });

  if (out.stdout) process.stdout.write(`${out.stdout}\n`);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  return out.exitCode;
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
