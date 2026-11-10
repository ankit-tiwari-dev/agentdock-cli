import { handleInit } from "./commands/init.ts";
import { handleStartDaemon, handleStopDaemon, handleStatus } from "./commands/daemon-cmd.ts";
import { handleSpecCommand } from "./commands/spec-cmd.ts";
import { handleVerifyCommand } from "./commands/verify-cmd.ts";
import { handleExplainCommand } from "./commands/explain-cmd.ts";
import { handleAuditCommand } from "./commands/audit-cmd.ts";
import { handleHookCommand } from "./commands/hook-cmd.ts";

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
      console.log(handleStatus());
      return 0;
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

    case "hook": {
      const exitCode = await handleHookCommand(subArgs[0] || "PreToolUse");
      return exitCode;
    }

    case "help":
    default: {
      console.log(`
AI Development Control Plane (@ctrlplane) v0.1.0

USAGE:
  ctrlplane <command> [options]

COMMANDS:
  init                     Initialize .ctrlplane templates and inject agent hooks
  start                    Start supervisor daemon in background
  stop                     Stop running supervisor daemon
  status                   Display daemon health and active session status
  spec <new|approve|show>  Manage specification and criteria
  verify                   Run two-tier verification against active spec
  explain                  Analyze diff blast radius, dependencies, and risks
  audit <list|show>        Query persistent event audit trail
  hook <eventName>         Internal hook shim invoked by agent harnesses
`);
      return 0;
    }
  }
}

