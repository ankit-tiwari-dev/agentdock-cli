#!/usr/bin/env node
const args = process.argv.slice(2);

// Hooks run on every agent tool call, so they skip loading the rest of the CLI.
if (args[0] === "hook") {
  const { handleHookCommand } = await import("./commands/hook-cmd.ts");
  handleHookCommand(args[1] || "PreToolUse", args.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[ctrlplane hook error] ${String(err)}\n`);
      process.exit(0);
    });
} else {
  const { runCli } = await import("./cli.ts");
  runCli(args)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[ctrlplane fatal]", err);
      process.exit(1);
    });
}
