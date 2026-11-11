import { handleInit } from "./commands/init.ts";
import { handleStartDaemon, handleStopDaemon, handleStatus, handleRunDaemon } from "./commands/daemon-cmd.ts";
import { handleSpecCommand } from "./commands/spec-cmd.ts";
import { handleVerifyCommand } from "./commands/verify-cmd.ts";
import { handleExplainCommand } from "./commands/explain-cmd.ts";
import { handleAuditCommand } from "./commands/audit-cmd.ts";
import { handleHookCommand } from "./commands/hook-cmd.ts";
import { handleCoachCommand } from "./commands/coach-cmd.ts";
import { handleBacktraceCommand } from "./commands/backtrace-cmd.ts";
import { handleCommitCommand } from "./commands/commit-cmd.ts";
import { calculateTurnCost } from "../../core/src/token-pricing.ts";

export async function runCli(args: string[]): Promise<number> {
  const command = args[0] || "help";
  const subArgs = args.slice(1);

  switch (command) {
    case "init": {
      const res = handleInit();
      console.log(res.message);
      return 0;
    }

    case "start": {
      const msg = await handleStartDaemon();
      console.log(msg);
      return 0;
    }

    case "stop": {
      const msg = await handleStopDaemon();
      console.log(msg);
      return 0;
    }

    case "status": {
      console.log(await handleStatus());
      return 0;
    }

    case "daemon-run": {
      const projectFlag = subArgs.indexOf("--project");
      return handleRunDaemon(projectFlag !== -1 ? subArgs[projectFlag + 1] : process.cwd());
    }

    case "spec": {
      const msg = handleSpecCommand(subArgs[0], subArgs.slice(1));
      console.log(msg);
      return 0;
    }

    case "verify": {
      const output = handleVerifyCommand();
      console.log(output);
      return 0;
    }

    case "explain": {
      const output = handleExplainCommand();
      console.log(output);
      return 0;
    }

    case "audit": {
      const output = handleAuditCommand(subArgs[0], subArgs.slice(1));
      console.log(output);
      return 0;
    }

    case "coach": {
      const output = handleCoachCommand(subArgs);
      console.log(output);
      return 0;
    }

    case "backtrace": {
      const output = handleBacktraceCommand(subArgs[0]);
      console.log(output);
      return 0;
    }

    case "commit": {
      const output = handleCommitCommand(subArgs);
      console.log(output);
      return 0;
    }

    case "cost": {
      const model = subArgs[0] || "claude-3-5-sonnet";
      const input = parseInt(subArgs[1] || "1000", 10);
      const output = parseInt(subArgs[2] || "500", 10);
      const breakdown = calculateTurnCost({ modelName: model, inputTokens: input, outputTokens: output });
      console.log(`Estimated Cost (${breakdown.model}): ${breakdown.formattedCost} (${breakdown.totalTokens} tokens)`);
      return 0;
    }

    case "hook": {
      const exitCode = await handleHookCommand(subArgs[0] || "PreToolUse", subArgs.slice(1));
      return exitCode;
    }

    case "help":
    default: {
      console.log(`
AI Development Control Plane (@ctrlplane) v0.1.0

USAGE:
  ctrlplane <command> [options]

SUPERVISOR COMMANDS:
  init                     Initialize .ctrlplane templates and inject agent hooks
  start                    Start supervisor daemon in background
  stop                     Stop running supervisor daemon
  status                   Display daemon health and active session status
  spec <new|approve|show>  Manage specification and criteria
  verify                   Run two-tier verification against active spec
  explain                  Analyze diff blast radius, dependencies, and risks
  audit <list|show>        Query persistent event audit trail
  coach "<prompt>"         Analyze prompt quality and get coaching suggestions
  backtrace [transcript]   Reconstruct past agent sessions, turns, and token spend
  commit "<subject>"       Create structured Git commit with agent trailers
  cost <model> <in> <out>  Calculate exact token dollar spend for a model turn
  hook <eventName>         Internal hook shim invoked by agent harnesses
`);
      return 0;
    }
  }
}

