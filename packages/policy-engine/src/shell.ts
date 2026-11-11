/**
 * Shell-command parsing for the safety rules. Rules never match raw command text: they see each
 * simple command (split out of `&&`, `;`, pipes, `( )`, `{ }`, `if/then/fi`, `$(...)`, `bash -c '...'`,
 * `cmd /c ...`, `pwsh -Command ...`, `eval ...`, `find -exec ...`, and literal text piped into a shell),
 * tokenised the way the shell would unquote it. This is still a pragmatic parser, not a full shell:
 * a deny-list built on it narrows the gaps, it cannot close every one.
 */

export interface ShellSegment {
  /** Raw text of one simple command, with leading `if`/`then`/`{`/`!` style keywords removed. */
  text: string;
  /** Raw text of the earlier stages of the pipeline this command reads from (nearest last). */
  pipedFrom: string[];
}

/** Every simple command a command line runs, including nested scripts. */
export function splitShellCommands(command: string): string[] {
  return splitShellSegments(command).map((s) => s.text);
}

export function splitShellSegments(command: string): ShellSegment[] {
  const out: ShellSegment[] = [];
  const seen = new Set<string>();
  const queue = [command];
  let guard = 0;

  while (queue.length > 0 && guard++ < 100) {
    const current = queue.shift()!;
    let pipeline: string[] = [];
    for (const part of splitTopLevel(current)) {
      const text = stripKeywords(part.text);
      if (text) {
        const seg = { text, pipedFrom: [...pipeline] };
        out.push(seg);
        for (const inner of nestedScripts(seg)) {
          if (seen.has(inner)) continue;
          seen.add(inner);
          queue.push(inner);
        }
      }
      if (part.sep === "|") {
        if (text) pipeline.push(text);
      } else {
        pipeline = [];
      }
    }
  }
  return out;
}

interface Part {
  text: string;
  /** Separator that ends this part: `|`, `&&`, `||`, `;`, `&`, newline, `(`, `)`, or "" at the end. */
  sep: string;
}

/** Splits on control operators and grouping, keeping quoted text, escapes and substitutions intact. */
function splitTopLevel(cmd: string): Part[] {
  const parts: Part[] = [];
  let buf = "";
  const push = (sep: string) => {
    parts.push({ text: buf, sep });
    buf = "";
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && i + 1 < cmd.length) {
      buf += c + cmd[i + 1];
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const stop = c === "'" ? skipSingle(cmd, i) : c === '"' ? skipDouble(cmd, i) : skipBacktick(cmd, i);
      buf += cmd.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && cmd[i + 1] === "(") {
      const stop = skipParens(cmd, i + 1);
      buf += cmd.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "{") {
      const end = cmd.indexOf("}", i);
      const stop = end === -1 ? cmd.length : end + 1;
      buf += cmd.slice(i, stop);
      i = stop - 1;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(two);
      i++;
      continue;
    }
    if (two === "|&") {
      push("|");
      i++;
      continue;
    }
    if (c === "|" && cmd[i - 1] === ">") {
      buf += c; // `>|` is a redirect, not a pipe
      continue;
    }
    if (c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
      push(c);
      continue;
    }
    if (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<") {
      push(c);
      continue;
    }
    buf += c;
  }
  push("");
  return parts;
}

const LEADING_KEYWORDS = /^\s*(?:(?:\{|\}|!|if|then|else|elif|fi|do|done|while|until|esac)(?=\s|$)\s*)*/;

function stripKeywords(text: string): string {
  return text.replace(LEADING_KEYWORDS, "").trim();
}

function skipSingle(s: string, i: number): number {
  const end = s.indexOf("'", i + 1);
  return end === -1 ? s.length : end + 1;
}

function skipDouble(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === "$" && s[j + 1] === "(") {
      j = skipParens(s, j + 1);
      continue;
    }
    if (c === "`") {
      j = skipBacktick(s, j);
      continue;
    }
    j++;
  }
  return s.length;
}

function skipBacktick(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === "`") return j + 1;
    j++;
  }
  return s.length;
}

/** `open` points at a `(`; returns the index just past its matching `)`. */
function skipParens(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      j = skipSingle(s, j) - 1;
      continue;
    }
    if (c === '"') {
      j = skipDouble(s, j) - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return s.length;
}

// ---------------------------------------------------------------------------
// Words

export interface Word {
  value: string;
  /** A redirection operator such as `>`, `2>>`, `&>`, `<<<`. */
  op: boolean;
}

/**
 * `posix`: quotes removed, adjacent quoted parts joined, backslash escapes applied, as bash does.
 * `literal`: quotes removed but backslashes kept, as cmd.exe and PowerShell see `C:\Users\x`.
 * Substitutions (`$(...)`, backticks, `${...}`, `<(...)`) stay verbatim inside their word.
 */
export function shellWords(text: string, mode: "posix" | "literal" = "posix"): Word[] {
  const words: Word[] = [];
  let cur = "";
  let started = false;
  let quoted = false;
  const flush = () => {
    if (started) words.push({ value: cur, op: false });
    cur = "";
    started = false;
    quoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      continue;
    }
    if (c === "\\" && mode === "posix") {
      if (i + 1 < text.length && text[i + 1] !== "\n") cur += text[i + 1];
      i++;
      started = true;
      continue;
    }
    if (c === "$" && text[i + 1] === "'" && mode === "posix") {
      const { value, stop } = ansiCQuoted(text, i + 2);
      cur += value;
      i = stop - 1;
      started = true;
      quoted = true;
      continue;
    }
    if (c === "'") {
      const stop = skipSingle(text, i);
      cur += text.slice(i + 1, text[stop - 1] === "'" && stop - 1 > i ? stop - 1 : stop);
      i = stop - 1;
      started = true;
      quoted = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        const d = text[j];
        if (d === "\\" && mode === "posix" && j + 1 < text.length && '$`"\\\n'.includes(text[j + 1])) {
          if (text[j + 1] !== "\n") cur += text[j + 1];
          j += 2;
          continue;
        }
        if (d === "$" && text[j + 1] === "(") {
          const stop = skipParens(text, j + 1);
          cur += text.slice(j, stop);
          j = stop;
          continue;
        }
        cur += d;
        j++;
      }
      i = j;
      started = true;
      quoted = true;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      const stop = skipParens(text, i + 1);
      cur += text.slice(i, stop);
      i = stop - 1;
      started = true;
      continue;
    }
    if (c === "`") {
      const stop = skipBacktick(text, i);
      cur += text.slice(i, stop);
      i = stop - 1;
      started = true;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i);
      const stop = end === -1 ? text.length : end + 1;
      cur += text.slice(i, stop);
      i = stop - 1;
      started = true;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
      let op = "";
      if (started && !quoted && /^\d+$/.test(cur)) {
        op = cur; // `2>file`: the fd number belongs to the operator
        cur = "";
        started = false;
      } else {
        flush();
      }
      let j = i;
      while (j < text.length && (text[j] === "<" || text[j] === ">" || text[j] === "&" || text[j] === "|")) {
        op += text[j];
        j++;
      }
      words.push({ value: op, op: true });
      i = j - 1;
      continue;
    }
    cur += c;
    started = true;
  }
  flush();
  return words;
}

const ANSI_C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', e: "\x1b" };

function ansiCQuoted(text: string, from: number): { value: string; stop: number } {
  let value = "";
  let j = from;
  while (j < text.length && text[j] !== "'") {
    if (text[j] === "\\" && j + 1 < text.length) {
      const n = text[j + 1];
      if (n in ANSI_C_ESCAPES) {
        value += ANSI_C_ESCAPES[n];
        j += 2;
        continue;
      }
      const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(j + 1));
      if (hex) {
        value += String.fromCharCode(parseInt(hex[1], 16));
        j += 1 + hex[0].length;
        continue;
      }
      const oct = /^[0-7]{1,3}/.exec(text.slice(j + 1));
      if (oct) {
        value += String.fromCharCode(parseInt(oct[0], 8));
        j += 1 + oct[0].length;
        continue;
      }
    }
    value += text[j];
    j++;
  }
  return { value, stop: Math.min(j + 1, text.length) };
}

export interface Redirect {
  op: string;
  target: string;
}

export interface ParsedCommand {
  /** Words with redirections removed. */
  args: string[];
  redirects: Redirect[];
}

export function parseSimpleCommand(text: string, mode: "posix" | "literal" = "posix"): ParsedCommand {
  const words = shellWords(text, mode);
  const args: string[] = [];
  const redirects: Redirect[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.op) {
      const next = words[i + 1];
      const target = next && !next.op ? next.value : "";
      if (next && !next.op) i++;
      redirects.push({ op: w.value, target });
      continue;
    }
    args.push(w.value);
  }
  return { args, redirects };
}

/** The bash reading and the cmd/PowerShell reading of a command; one entry when they agree. */
export function commandVariants(text: string): ParsedCommand[] {
  const posix = parseSimpleCommand(text, "posix");
  if (!text.includes("\\")) return [posix];
  return [posix, parseSimpleCommand(text, "literal")];
}

/** Whitespace tokens with quotes removed (bash reading). */
export function tokenize(cmd: string): string[] {
  return parseSimpleCommand(cmd, "posix").args;
}

// ---------------------------------------------------------------------------
// Programs and wrappers

/** `/bin/rm` → `rm`, `C:\Windows\System32\cmd.exe` → `cmd`, `\rm` → `rm`, `CTRLPLANE.cmd` → `ctrlplane`. */
export function normalizeProgram(token: string): string {
  const t = token.replace(/\\/g, "/");
  const base = t.slice(t.lastIndexOf("/") + 1);
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

interface WrapperSpec {
  /** Options that take the next word as their value. */
  argOpts?: string[];
  /** Positional words before the wrapped command (`timeout 10 cmd`). */
  positional?: number;
}

const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    argOpts: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt"],
  },
  doas: { argOpts: ["-u", "-C"] },
  env: { argOpts: ["-u", "-C", "--unset", "--chdir"] },
  nice: { argOpts: ["-n", "--adjustment"] },
  timeout: { argOpts: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  nohup: {},
  time: {},
  command: {},
  builtin: {},
  exec: { argOpts: ["-a"] },
  xargs: {
    argOpts: [
      "-I",
      "-n",
      "-P",
      "-d",
      "-E",
      "-L",
      "-s",
      "-a",
      "--max-args",
      "--max-procs",
      "--delimiter",
      "--arg-file",
      "--max-lines",
      "--max-chars",
      "--eof",
    ],
  },
  busybox: {},
  setsid: {},
  stdbuf: { argOpts: ["-i", "-o", "-e"] },
  ionice: { argOpts: ["-c", "-n", "-p"] },
  unbuffer: {},
};

export interface PeeledCommand {
  /** The command that actually runs, program normalised (`rm`, `git`, ...). */
  args: string[];
  /** Wrappers that were removed, normalised (`sudo`, `xargs`, ...). */
  wrappers: string[];
}

/** Drops env assignments and wrappers: `FOO=1 sudo -E timeout 5 /bin/rm -rf x` → `rm -rf x`. */
export function peelCommand(tokens: string[]): PeeledCommand {
  let t = tokens;
  const wrappers: string[] = [];
  for (let guard = 0; guard < 20 && t.length > 0; guard++) {
    let i = 0;
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[i])) i++;
    if (i > 0) {
      t = t.slice(i);
      continue;
    }
    const name = normalizeProgram(t[0]);
    const spec = WRAPPERS[name];
    if (!spec) break;
    i = 1;
    let positional = spec.positional ?? 0;
    let split: string[] | null = null;
    while (i < t.length) {
      const a = t[i];
      if (a === "--") {
        i++;
        break;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        i++;
        continue;
      }
      if (name === "env" && (a === "-S" || a === "--split-string") && i + 1 < t.length) {
        split = tokenize(t[i + 1]);
        i += 2;
        break;
      }
      if (a.startsWith("-") && a.length > 1) {
        i += spec.argOpts?.includes(a) ? 2 : 1;
        continue;
      }
      if (positional > 0) {
        positional--;
        i++;
        continue;
      }
      break;
    }
    const next = split ? [...split, ...t.slice(i)] : t.slice(i);
    if (next.length === 0) break; // a bare `env` or `time` is the command itself
    wrappers.push(name);
    t = next;
  }
  return { args: t.length > 0 ? [normalizeProgram(t[0]), ...t.slice(1)] : [], wrappers };
}

/** Drops leading env assignments and wrappers (`FOO=1 sudo -E git ...` → `git ...`). */
export function stripCommandPrefix(tokens: string[]): string[] {
  return peelCommand(tokens).args;
}

/** A command name the shell computes at run time (`$c`, `${c}`, `$(...)`, backticks). */
export function isDynamicWord(token: string): boolean {
  return /^(?:\$|`)/.test(token);
}

// ---------------------------------------------------------------------------
// Nested scripts

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);

/** Re-joins words so the result parses back to the same words. */
export function joinWords(words: string[]): string {
  return words.map((w) => (/^[\w@%+=:,./\\~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Bodies of `$(...)`, backticks and `<(...)`/`>(...)` (not inside single quotes, where nothing runs). */
function substitutionBodies(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      i = skipSingle(text, i) - 1;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      const stop = skipParens(text, i + 1);
      found.push(text.slice(i + 2, text[stop - 1] === ")" ? stop - 1 : stop));
      i = stop - 1; // nested substitutions are found when the body is parsed in turn
      continue;
    }
    if (c === "`") {
      const stop = skipBacktick(text, i);
      found.push(text.slice(i + 1, text[stop - 1] === "`" ? stop - 1 : stop));
      i = stop - 1;
    }
  }
  return found;
}

/** Literal text a command reads on stdin: a here-string, or `echo`/`printf` output piped into it. */
function stdinLiteral(seg: ShellSegment, parsed: ParsedCommand): string | null {
  const here = parsed.redirects.find((r) => r.op === "<<<");
  if (here) return here.target;
  const prev = seg.pipedFrom[seg.pipedFrom.length - 1];
  if (!prev) return null;
  const p = peelCommand(parseSimpleCommand(prev).args).args;
  if (p[0] !== "echo" && p[0] !== "printf") return null;
  const words = p.slice(1);
  while (words.length > 0 && /^-[neE]+$/.test(words[0])) words.shift();
  return words.length > 0 ? words.join(" ") : null;
}

/** Text after a flag in the raw command (`cmd /c <rest>`), with one pair of wrapping quotes removed. */
function restAfter(raw: string, flag: RegExp): string | null {
  const m = flag.exec(raw);
  if (!m) return null;
  let rest = raw.slice(m.index + m[0].length).trim();
  const quoted = /^"([\s\S]*)"$/.exec(rest) ?? /^'([\s\S]*)'$/.exec(rest);
  if (quoted) rest = quoted[1];
  return rest || null;
}

const PWSH_COMMAND_FLAG = /(?:^|\s)[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?=\s)/i;
const PWSH_ENCODED_FLAG =
  /(?:^|\s)[-/]e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?\s+(\S+)/i;
const PWSH_ARG_OPTS =
  /^-(?:ex|ep|executionpolicy|w|windowstyle|version|v|inputformat|if|outputformat|of|o|configurationname|wd|workingdirectory)$/i;

function nestedScripts(seg: ShellSegment): string[] {
  const found = substitutionBodies(seg.text);

  for (const parsed of commandVariants(seg.text)) {
    const { args, wrappers } = peelCommand(parsed.args);
    if (args.length === 0) continue;
    const prog = args[0];
    const stdin = stdinLiteral(seg, parsed);

    if (POSIX_SHELLS.has(prog)) {
      let script: string | null = null;
      let hasFile = false;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "-o" || a === "+o" || a === "-O" || a === "+O") {
          i++;
          continue;
        }
        if (/^[-+][a-zA-Z]+$/.test(a)) {
          if (a.startsWith("-") && a.includes("c")) {
            script = args.slice(i + 1).find((x) => !x.startsWith("-")) ?? null;
            break;
          }
          continue;
        }
        if (a.startsWith("--")) continue;
        hasFile = a !== "-";
        break;
      }
      if (script !== null) found.push(script);
      else if (!hasFile && stdin) found.push(stdin);
    } else if (prog === "cmd") {
      const rest = restAfter(seg.text, /(?:^|\s)\/[ck](?=\s|")/i);
      if (rest) found.push(rest);
    } else if (prog === "pwsh" || prog === "powershell") {
      const enc = PWSH_ENCODED_FLAG.exec(seg.text);
      if (enc) found.push(Buffer.from(enc[1], "base64").toString("utf16le"));
      const rest = restAfter(seg.text, PWSH_COMMAND_FLAG);
      if (rest) found.push(rest);
      else if (!enc && prog === "powershell") {
        // Windows PowerShell treats its first positional word as -Command.
        let i = 1;
        while (i < args.length && args[i].startsWith("-")) {
          if (/^-f(?:i(?:l(?:e)?)?)?$/i.test(args[i])) {
            i = args.length;
            break;
          }
          i += PWSH_ARG_OPTS.test(args[i]) ? 2 : 1;
        }
        if (i < args.length) found.push(args.slice(i).join(" "));
      }
    } else if (prog === "eval") {
      if (args.length > 1) found.push(args.slice(1).join(" "));
    } else if (prog === "find") {
      found.push(...findExecCommands(args));
    }

    if (wrappers.includes("xargs") && stdin) found.push(`${joinWords(args)} ${stdin}`);
  }
  return found.filter((s) => s.trim().length > 0);
}

/** `find / -exec rm -rf {} +` → `rm -rf /`. */
function findExecCommands(args: string[]): string[] {
  const roots: string[] = [];
  let i = 1;
  while (i < args.length && /^-[HLP]$/.test(args[i])) i++;
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") roots.push(args[i++]);
  const out: string[] = [];
  for (; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
    const cmd: string[] = [];
    let j = i + 1;
    while (j < args.length && args[j] !== ";" && args[j] !== "+") cmd.push(args[j++]);
    i = j;
    if (cmd.length === 0) continue;
    const targets = roots.length > 0 ? roots : ["."];
    out.push(joinWords(cmd.flatMap((w) => (w === "{}" ? targets : [w]))));
  }
  return out;
}
