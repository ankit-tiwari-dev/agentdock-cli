/**
 * Splits a shell command line into the individual commands it runs, so a rule sees
 * `git push --force` inside `npm test && git push --force`, inside `$(...)`, and inside `bash -c '...'`.
 * This is a pragmatic splitter, not a full shell parser: it respects quotes and ignores escapes.
 */
export function splitShellCommands(command: string): string[] {
  const out: string[] = [];
  const queue = [command];
  let guard = 0;

  while (queue.length > 0 && guard++ < 50) {
    const current = queue.shift()!;
    for (const part of splitTopLevel(current)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      out.push(trimmed);
      for (const inner of nestedScripts(trimmed)) queue.push(inner);
    }
  }
  return out;
}

function splitTopLevel(cmd: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">")) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function nestedScripts(cmd: string): string[] {
  const found: string[] = [];
  const subst = /\$\(([^()]*)\)|`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = subst.exec(cmd)) !== null) found.push(m[1] ?? m[2] ?? "");

  const dashC =
    /\b(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-l\s+)?(?:-c|-lc|\/c|-Command)\s+(["'])([\s\S]*?)\1/g;
  while ((m = dashC.exec(cmd)) !== null) found.push(m[2]);
  return found.filter((s) => s.trim().length > 0);
}

/** Whitespace tokens with surrounding quotes removed. */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** Drops leading env assignments and wrappers (`FOO=1 sudo -E git ...` → `git ...`). */
export function stripCommandPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t === "sudo" || t === "doas" || t === "nohup" || t === "time" || t === "command" || t === "exec") {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}
