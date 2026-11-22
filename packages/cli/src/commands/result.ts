/** What every `ctrlplane` command returns: the text to print and the process exit code. cli.ts requires it. */
export interface CommandResult {
  output: string;
  exitCode: number;
}

export function ok(output: string): CommandResult {
  return { output, exitCode: 0 };
}

/** A command that did not do what was asked: a usage error, a missing argument or a failed action. */
export function failed(output: string): CommandResult {
  return { output, exitCode: 1 };
}
