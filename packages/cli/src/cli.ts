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
import { handlePauseCommand, handlePoliciesCommand, handleResumeCommand } from "./commands/policies-cmd.ts";
import { failed, ok, type CommandResult } from "./commands/result.ts";
import {
  handleCapabilitiesCommand,
  handleContextCommand,
  handleHandoffCommand,
  handleMemoryCommand,
} from "./commands/context-cmd.ts";
import { handleSupervisorCommand } from "./commands/supervisor-cmd.ts";
import { calculateTurnCost } from "../../core/src/token-pricing.ts";

function print(res: CommandResult): number {
  if (res.output) (res.exitCode === 2 ? console.error : console.log)(res.output);
  return res.exitCode;
}

const HELP = `
AI Development Control Plane (@ctrlplane) v0.3.0

USAGE:
  ctrlplane <command> [options]

SUPERVISOR COMMANDS:
  init [--agent <name>]    Initialize .ctrlplane config and inject hooks (claude|codex|opencode|all)
  start                    Start supervisor daemon in background
  stop                     Stop running supervisor daemon
  status                   Display daemon health and active session status
  pause [30m]              Pause supervision (max 8h per run); always-on rules still apply
  resume                   End a pause early

POLICY COMMANDS:
  policies list                       Every rule with its state (enforce/observe/off)
  policies show <id>                  One rule's description, outcome and params
  policies enable|disable <id>        Switch a rule on or off      [--local|--user]
  policies observe|enforce <id>       Log-only vs blocking mode    [--local|--user]
  policies set <id> <param> <json>    Change a rule parameter      [--local|--user]
  policies test --command "<cmd>" [--expect deny|ask|instruct|allow]
                                      Dry-run a tool call; exits 1 if --expect fails

SUPERVISOR PROVIDER COMMANDS (run these in your own terminal):
  supervisor use <codex|claude|openai-compatible> [model] [--base-url <url>]
                                      Pick the model that plans and explains changes in the dashboard
  supervisor set-key <claude|openai-compatible> [--stdin]
                                      Save an API key in the OS keychain (hidden prompt, never an argument)
  supervisor remove-key <claude|openai-compatible>
                                      Delete a saved key
  supervisor status [--check]         Provider, model and saved keys; --check tests the key with one free call

CONTEXT COMMANDS:
  context [--source compact]          Show the context pack a new session receives
  handoff [--note "<text>"] | show    Save (or show) where the work stands for the next session
  memory add "<note>" [--tags a,b] [--pin] | search "<words>" | list | rm <id>
                                      Project notes injected into every new session
  capabilities                        MCP servers, skills, agents, hooks and where each came from
  spec <new|approve|show>  Manage specification and criteria
  verify                   Run two-tier verification against active spec
  explain                  Analyze diff blast radius, dependencies, and risks
  audit <list|show>        Query persistent event audit trail
  coach "<prompt>"         Analyze prompt quality and get coaching suggestions
  backtrace [transcript]   Reconstruct past agent sessions, turns, and token spend
  commit "<subject>"       Create structured Git commit with agent trailers
  cost <model> <in> <out>  Calculate exact token dollar spend for a model turn
  hook <eventName>         Internal hook shim invoked by agent harnesses
`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function costCommand(args: string[]): CommandResult {
  const model = args[0] || "claude-3-5-sonnet";
  const inputArg = args[1] ?? "1000";
  const outputArg = args[2] ?? "500";
  // Whole token counts only: parseInt would read "1e6" as 1 and "abc" as NaN.
  if (!/^\d+$/.test(inputArg) || !/^\d+$/.test(outputArg)) {
    return failed(
      "Usage: ctrlplane cost <model> <input-tokens> <output-tokens>  (token counts are whole numbers, e.g. 1000000)",
    );
  }
  const breakdown = calculateTurnCost({
    modelName: model,
    inputTokens: Number(inputArg),
    outputTokens: Number(outputArg),
  });
  const lines = [`Estimated Cost (${breakdown.model}): ${breakdown.formattedCost} (${breakdown.totalTokens} tokens)`];
  if (breakdown.unknownModel) {
    lines.push(`WARNING: unknown model '${breakdown.model}': no price in the catalog, estimated at the default rate.`);
  }
  return ok(lines.join("\n"));
}

/**
 * Every `ctrlplane` command. Each returns a CommandResult, so a handler that fails has to say so in its exit code;
 * a string or a bare number does not type-check here. CLI_COMMAND_SAFETY must classify every key (command-safety.test.ts).
 */
export const COMMANDS: Readonly<Record<string, (args: string[]) => CommandResult | Promise<CommandResult>>> = {
  init: (args) => {
    const agent = flagValue(args, "--agent");
    if (agent && !["claude", "codex", "opencode", "all"].includes(agent.toLowerCase())) {
      return { output: `Unknown --agent '${agent}'. Use claude, codex, opencode or all.`, exitCode: 2 };
    }
    return ok(handleInit({ agent }).message);
  },
  policies: (args) => handlePoliciesCommand(args[0], args.slice(1)),
  supervisor: (args) => handleSupervisorCommand(args[0], args.slice(1)),
  pause: (args) => handlePauseCommand(args),
  resume: () => handleResumeCommand(),
  context: (args) => handleContextCommand(args),
  handoff: (args) => handleHandoffCommand(args),
  memory: (args) => handleMemoryCommand(args[0], args.slice(1)),
  capabilities: () => handleCapabilitiesCommand(),
  start: () => handleStartDaemon(),
  stop: () => handleStopDaemon(),
  status: () => handleStatus(),
  "daemon-run": async (args) => ({
    output: "",
    exitCode: await handleRunDaemon(flagValue(args, "--project") ?? process.cwd()),
  }),
  spec: (args) => handleSpecCommand(args[0], args.slice(1)),
  // Exits 0 only when the report is PASSED.
  verify: () => handleVerifyCommand(),
  explain: () => handleExplainCommand(),
  audit: (args) => handleAuditCommand(args[0], args.slice(1)),
  coach: (args) => handleCoachCommand(args),
  backtrace: (args) => handleBacktraceCommand(args[0]),
  commit: (args) => handleCommitCommand(args),
  cost: costCommand,
  hook: async (args) => ({ output: "", exitCode: await handleHookCommand(args[0] || "PreToolUse", args.slice(1)) }),
  help: () => ok(HELP),
};

export async function runCli(args: string[]): Promise<number> {
  const command = args[0] || "help";
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) return print(failed(`Unknown command '${command}'.\n${HELP}`));
  return print(await handler(args.slice(1)));
}
