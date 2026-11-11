import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { commandVariants, isDynamicWord, peelCommand, stripCommandPrefix, tokenize } from "./shell.ts";
import { normalizeFsPath, toProjectPath, trimTrailing } from "./glob.ts";
import { isSensitiveFile } from "../../git-analyzer/src/index.ts";

/** Words of the command that actually runs (wrappers peeled, program normalised), bash reading. */
export function argv(sub: string): string[] {
  return stripCommandPrefix(tokenize(sub));
}

/** The bash reading and, when the text has backslashes, the cmd/PowerShell reading, both peeled. */
export function argvVariants(sub: string): string[][] {
  return commandVariants(sub).map((p) => peelCommand(p.args).args);
}

/** File systems that ignore case (Windows, macOS by default). */
export const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function hasShortFlag(tokens: string[], letter: string): boolean {
  return tokens.some((t) => /^-[a-zA-Z]+$/.test(t) && t.includes(letter));
}

/** PowerShell accepts any unambiguous prefix of a parameter name: `-r`, `-Rec`, `-Recurse`. */
const PWSH_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i;
const WINDOWS_DELETE = new Set(["remove-item", "ri", "rd", "rmdir", "del", "erase"]);

/** `rm -rf` (or a Windows equivalent) aimed at a target whose loss is catastrophic. */
export function isCatastrophicDelete(sub: string, projectRoot: string, cwd = ""): boolean {
  const direct = (x: string) =>
    isCatastrophicTarget(x, projectRoot) || (cwd !== "" && isCatastrophicTarget(withCwd(x, cwd), projectRoot));
  // `rm -rf $(echo /)`: the target is computed, so judge the words that compute it.
  const hit = (x: string) => direct(x) || substitutionWords(x).some((w) => !w.startsWith("-") && direct(w));
  return argvVariants(sub).some((t) => {
    if (t.length === 0) return false;
    const bin = t[0];

    if (bin === "rm") {
      const recursive = hasShortFlag(t, "r") || hasShortFlag(t, "R") || t.includes("--recursive");
      if (!recursive) return false;
      return t.slice(1).some((x) => !x.startsWith("-") && hit(x));
    }

    if (WINDOWS_DELETE.has(bin)) {
      const recursive = t.some((x) => PWSH_RECURSE.test(x) || /^\/s$/i.test(x));
      if (!recursive) return false;
      return t.slice(1).some((x) => !x.startsWith("-") && !/^\/[a-z]$/i.test(x) && hit(x));
    }

    if (bin === "find" && t.includes("-delete")) {
      return t[1] !== undefined && hit(t[1]);
    }
    return false;
  });
}

/** Words inside `$(...)` / backticks of a word (`$(echo /)` → `echo`, `/`). */
function substitutionWords(word: string): string[] {
  const out: string[] = [];
  for (const m of word.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) out.push(...tokenize(m[1] ?? m[2] ?? ""));
  return out;
}

const TEMP_ROOTS = [tmpdir(), "/tmp", "/var/tmp"].map((p) => p.replace(/\\/g, "/").toLowerCase());

/** `x` as seen from inside `cwd` (absolute and home-relative targets are unchanged). */
function withCwd(x: string, cwd: string): string {
  const t = x.replace(/\\/g, "/");
  if (!cwd || /^(?:\/|[a-zA-Z]:|~|\$|%)/.test(t)) return t;
  return posix.join(cwd.replace(/\\/g, "/"), t);
}

/**
 * Catastrophic: filesystem root, home, bare wildcards, the project root itself, its `.git`,
 * a parent directory, or an absolute path outside both the project and the temp directory.
 */
export function isCatastrophicTarget(target: string, projectRoot: string): boolean {
  const x = trimTrailing(posix.normalize(target.replace(/\\/g, "/") || "."), "/") || "/";
  if (["/", "/*", "~", "~/*", "*", ".", "./*", "$HOME", "${HOME}", "%USERPROFILE%"].includes(x)) return true;
  if (x.startsWith("~") || x.startsWith("$HOME") || x.startsWith("${HOME}") || x.startsWith("%USERPROFILE%"))
    return true;
  if (x === ".." || x.startsWith("../") || x.includes("/../")) return true;
  const g = CASE_INSENSITIVE_FS ? x.toLowerCase() : x;
  if (g === ".git" || g.startsWith(".git/") || g.endsWith("/.git")) return true;

  if (x.startsWith("/") || /^[a-zA-Z]:/.test(x)) {
    const abs = toPosixAbsolute(x).toLowerCase();
    const root = toPosixAbsolute(resolve(projectRoot).replace(/\\/g, "/")).toLowerCase();
    if (abs === root) return true;
    if (abs.startsWith(root + "/")) return false;
    if (TEMP_ROOTS.some((tmp) => abs.startsWith(toPosixAbsolute(tmp) + "/"))) return false;
    return true;
  }
  return false;
}

/** `C:/x` and git-bash `/c/x` compare equal. */
function toPosixAbsolute(p: string): string {
  const m = p.match(/^([a-zA-Z]):(\/.*)?$/);
  if (m) return `/${m[1].toLowerCase()}${m[2] ?? ""}`;
  return p;
}

/** A force push that can overwrite someone else's commits. `--force-with-lease` is the safe form. */
export function isForcePush(sub: string): boolean {
  const t = argv(sub);
  if (t[0] !== "git") return false;
  const pushAt = t.indexOf("push");
  if (pushAt === -1) return false;
  const rest = t.slice(pushAt + 1);
  if (rest.some((x) => x === "--force" || x === "--mirror" || x === "--delete" || x === "-d")) return true;
  // Short flags bundled with `f` (`-uf`). Letters-only plus a separate `f` check, because
  // `/^-[a-zA-Z]*f[a-zA-Z]*$/` backtracks quadratically on a long run of letters.
  if (rest.some((x) => /^-[a-zA-Z]+$/.test(x) && x.includes("f"))) return true;
  return rest.some((x) => !x.startsWith("-") && x.startsWith("+") && x.length > 1);
}

export function gitSubcommand(sub: string): { verb: string; args: string[] } | null {
  const t = argv(sub);
  if (t[0] !== "git") return null;
  let i = 1;
  while (i < t.length && t[i].startsWith("-")) {
    if (t[i] === "-C" || t[i] === "-c") i += 2;
    else i++;
  }
  if (i >= t.length) return null;
  return { verb: t[i], args: t.slice(i + 1) };
}

export function isHardReset(sub: string): boolean {
  const g = gitSubcommand(sub);
  return !!g && g.verb === "reset" && g.args.includes("--hard");
}

/** `git checkout -f` / `git switch --discard-changes` throw away uncommitted work like `reset --hard`. */
export function isForceCheckout(sub: string): boolean {
  const g = gitSubcommand(sub);
  if (!g || (g.verb !== "checkout" && g.verb !== "switch")) return false;
  const dashDash = g.args.indexOf("--");
  const opts = dashDash === -1 ? g.args : g.args.slice(0, dashDash);
  return opts.some((a) => a === "--force" || a === "--discard-changes" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f")));
}

export function isForceClean(sub: string): boolean {
  const g = gitSubcommand(sub);
  if (!g || g.verb !== "clean") return false;
  const flags = g.args.filter((a) => a.startsWith("-")).join("");
  return flags.includes("f") && (flags.includes("d") || flags.includes("x") || flags.includes("X"));
}

export function isDiskWipe(sub: string): boolean {
  // After `dd`, the text up to `of=` is either empty or starts with a non-space. Same matches as
  // `dd\s+.*\bof=`, but the space run can only be split one way, so a long run of spaces stays linear.
  return /^\s*(?:sudo\s+)?(?:mkfs(?:\.\w+)?|format\s+[a-z]:|diskpart|dd\s+(?:\S.*)?\bof=\/dev\/)/i.test(sub);
}

const READERS = new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "type",
  "get-content",
  "gc",
  "bat",
  "nl",
  "strings",
  "base64",
  "xxd",
  "od",
  "grep",
  "rg",
  "awk",
  "sed",
  "cp",
  "scp",
  "rsync",
  "source",
  ".",
  "open",
  "tar",
  "zip",
  "7z",
  "gzip",
  "bzip2",
  "xz",
  "zstd",
  "jq",
  "yq",
  "sort",
  "uniq",
  "cut",
  "diff",
  "cmp",
  "tac",
  "rev",
  "paste",
  "select-string",
  "sls",
  "copy-item",
  "cpi",
  "copy",
]);

/** Names the sensitive-file check knows, used to test what a shell glob such as `.e*` could expand to. */
const SENSITIVE_SAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "server.pem",
  "server.key",
  "cert.p12",
  "cert.pfx",
  ".npmrc",
  ".netrc",
  ".pgpass",
];

function hasGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

/**
 * Anchored regex for a shell glob, with the shell's dotfile rule: a `*` or `?` at the start of a
 * path segment does not match a leading `.`.
 */
export function shellGlobRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const segStart = i === 0 || glob[i - 1] === "/";
    if (c === "*") re += segStart ? "(?!\\.)[^/]*" : "[^/]*";
    else if (c === "?") re += segStart ? "[^/.]" : "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function globMayMatchSecret(arg: string): boolean {
  const p = arg.replace(/\\/g, "/");
  const slash = p.lastIndexOf("/");
  const dir = p.slice(0, slash + 1);
  const base = p.slice(slash + 1);
  if (!hasGlob(base) || hasGlob(dir) || !/[^*?[\]]/.test(base)) return false;
  const re = shellGlobRegExp(base);
  return SENSITIVE_SAMPLES.some((s) => re.test(s) && isSensitiveFile(dir + s));
}

/** A shell command that reads or copies a secrets file. */
export function readsSensitiveFile(sub: string): string | null {
  for (const parsed of commandVariants(sub)) {
    const redirectIn = parsed.redirects.find((r) => r.op === "<" && r.target);
    if (redirectIn && (isSensitiveFile(redirectIn.target) || globMayMatchSecret(redirectIn.target)))
      return redirectIn.target;

    const t = peelCommand(parsed.args).args;
    if (t.length === 0) continue;
    const bin = t[0];

    if (bin === "git") {
      const g = gitSubcommand(sub);
      if (g && (g.verb === "show" || g.verb === "cat-file")) {
        for (const a of g.args) {
          const colon = a.indexOf(":");
          if (colon > -1 && !a.startsWith("-") && isSensitiveFile(a.slice(colon + 1))) return a;
        }
      }
      continue;
    }
    if (bin === "dd") {
      const input = t.find((a) => a.startsWith("if="));
      if (input && isSensitiveFile(input.slice(3))) return input.slice(3);
      continue;
    }
    if (!READERS.has(bin)) continue;
    for (const arg of t.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (isSensitiveFile(arg) || globMayMatchSecret(arg)) return arg;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes, deletes and moves

const ALWAYS_WRITES = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "ln",
  "link",
  "touch",
  "truncate",
  "tee",
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "shred",
  "install",
  "rsync",
  "set-content",
  "add-content",
  "out-file",
  "clear-content",
  "clc",
  "tee-object",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "move-item",
  "mi",
  "move",
  "copy-item",
  "cpi",
  "copy",
  "new-item",
  "ni",
  "rename-item",
  "rni",
  "ren",
  "rename",
  "xcopy",
  "robocopy",
  "mklink",
  "set-itemproperty",
]);

const GIT_WRITE_VERBS = new Set(["rm", "mv", "checkout", "restore", "clean"]);

/** Interpreter one-liners: the code string follows one of these flags. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  python: ["-c"],
  python3: ["-c"],
  py: ["-c"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
};

const INLINE_WRITE_API =
  /write|append|unlink|rmdir|rmtree|\brm\b|rmSync|remove|rename|copy|move|truncate|chmod|symlink|replace|outputFile|open\s*\([^)]*['"][wax+]/i;

function isWriteRedirect(op: string, target: string): boolean {
  if (!op.includes(">")) return false;
  if (op.endsWith(">&") && /^(?:\d+|-)$/.test(target)) return false; // 2>&1 duplicates a descriptor
  return true;
}

/**
 * Paths a shell command writes, deletes, moves or re-permissions (operands of write verbs and
 * redirect targets), or null when it does not write at all. An empty list means "writes, but
 * the target is not visible" (for example `rm` reading its operands from stdin).
 */
export function shellWriteTargets(sub: string): string[] | null {
  let writes = false;
  const targets = new Set<string>();
  const add = (xs: string[]) => {
    writes = true;
    for (const x of xs) if (x) targets.add(x);
  };

  for (const parsed of commandVariants(sub)) {
    for (const r of parsed.redirects) if (isWriteRedirect(r.op, r.target)) add([r.target]);

    const t = peelCommand(parsed.args).args;
    if (t.length === 0) continue;
    const bin = t[0];
    const operands = t.slice(1).filter((a) => !a.startsWith("-"));

    if (ALWAYS_WRITES.has(bin)) add(operands);
    else if (bin === "sed" && t.some((a) => /^-[^-]*i/.test(a) || /^--in-place(?:=|$)/.test(a))) add(operands);
    else if ((bin === "perl" || bin === "ruby") && t.some((a) => /^-[a-zA-Z]*i/.test(a))) add(operands);
    else if (bin === "dd") add(t.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
    else if (bin === "find" && t.includes("-delete")) {
      const roots: string[] = [];
      for (let i = 1; i < t.length && !t[i].startsWith("-") && t[i] !== "(" && t[i] !== "!"; i++) roots.push(t[i]);
      add(roots.length > 0 ? roots : ["."]);
    } else if (bin === "git") {
      const g = gitSubcommand(sub);
      if (g && GIT_WRITE_VERBS.has(g.verb)) add(g.args.filter((a) => !a.startsWith("-")));
    } else if (INLINE_CODE_FLAGS[bin]) {
      const flags = INLINE_CODE_FLAGS[bin];
      const at = t.findIndex((a, i) => i > 0 && flags.includes(a));
      const code = at > -1 ? t[at + 1] : undefined;
      if (code && INLINE_WRITE_API.test(code)) {
        const literals = [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
        if (literals.length > 0) add(literals);
      }
    }
  }
  return writes ? [...targets] : null;
}

/** Target of `cd X`, `pushd X`, `Set-Location X` (`~` when bare), or null when `sub` is not a cd. */
export function cdTarget(sub: string): string | null {
  const t = argv(sub);
  if (!["cd", "pushd", "chdir", "set-location", "sl"].includes(t[0] ?? "")) return null;
  const args = t.slice(1).filter((a) => !a.startsWith("-") && !/^\/d$/i.test(a));
  return args[0] ?? "~";
}

/** A standalone `NAME=value` / `export NAME=value`, so a later `$NAME/x` can be resolved. */
export function shellAssignment(sub: string): { name: string; value: string } | null {
  const t = tokenize(sub);
  const words = t[0] === "export" || t[0] === "local" || t[0] === "declare" ? t.slice(1) : t;
  if (words.length !== 1) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(words[0]);
  return m ? { name: m[1], value: m[2] } : null;
}

/** Where user-level supervisor config lives (`CTRLPLANE_HOME`, default `~/.ctrlplane`), forward slashes. */
export function ctrlplaneHome(): string {
  return (process.env.CTRLPLANE_HOME || join(homedir(), ".ctrlplane")).replace(/\\/g, "/").replace(/\/+$/, "");
}

const VAR_REF =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gi;

/**
 * Turns a shell path word into the form rules compare: known variables expanded (`$CTRLPLANE_HOME`,
 * `$HOME`, `~`, `$PWD`, `$(pwd)` and variables assigned earlier in the same command), git-bash
 * `/c/x` read as `C:/x`, joined to the current `cd` directory, NTFS suffixes removed, and finally
 * project-relative when inside the project.
 */
export function resolveShellPath(
  word: string,
  projectRoot: string,
  cwd = "",
  vars: ReadonlyMap<string, string> = new Map(),
): string {
  const home = homedir().replace(/\\/g, "/");
  const here = (cwd ? (isAbsolute(cwd) ? cwd : join(projectRoot, cwd)) : projectRoot).replace(/\\/g, "/");
  let p = word
    .replace(/^(?:\$\(pwd\)|`pwd`)(?=[/\\]|$)/, here)
    .replace(VAR_REF, (m, a?: string, b?: string, c?: string, d?: string) => {
      const name = (a ?? b ?? c ?? d) as string;
      const upper = name.toUpperCase();
      if (upper === "CTRLPLANE_HOME") return ctrlplaneHome();
      if (upper === "HOME" || upper === "USERPROFILE") return home;
      if (upper === "PWD") return here;
      return vars.get(name) ?? m;
    })
    .replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  if (process.platform === "win32") p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  const absolute = p.startsWith("/") || /^[a-zA-Z]:/.test(p);
  if (cwd && !absolute) p = posix.join(cwd.replace(/\\/g, "/"), p);
  p = normalizeFsPath(p);
  const rel = toProjectPath(p, projectRoot).replace(/\\/g, "/");
  return rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) ? rel : posix.normalize(rel);
}

/** Absolute, forward-slash, lower-cased where the file system ignores case. */
export function comparablePath(p: string, projectRoot: string): string {
  const abs = (isAbsolute(p) || /^[a-zA-Z]:/.test(p) ? p : join(projectRoot, p)).replace(/\\/g, "/");
  const clean = trimTrailing(posix.normalize(abs), "/");
  return CASE_INSENSITIVE_FS ? clean.toLowerCase() : clean;
}

/** True when `p` is `dir` or inside it. */
export function isInside(p: string, dir: string, projectRoot: string): boolean {
  const a = comparablePath(p, projectRoot);
  const d = comparablePath(dir, projectRoot);
  return a === d || a.startsWith(`${d}/`);
}

export interface ShellPathPolicy {
  /** Resolved path (project-relative or absolute) → protected? */
  isProtected: (path: string) => boolean;
  /** Concrete protected paths, so a glob target like `.claude/*.json` can be tested against them. */
  samples: string[];
}

/**
 * The first sub-command that writes, deletes or moves a protected path, or that writes anything
 * after a `cd` into one; null when there is none. Targets are resolved by {@link resolveShellPath}.
 */
export function shellTouchesProtected(
  subCommands: string[],
  projectRoot: string,
  policy: ShellPathPolicy,
): string | null {
  let cwd = "";
  const vars = new Map<string, string>();
  for (const sub of subCommands) {
    const assign = shellAssignment(sub);
    if (assign) {
      vars.set(assign.name, assign.value);
      continue;
    }
    const cd = cdTarget(sub);
    if (cd !== null) {
      cwd = resolveShellPath(cd, projectRoot, cwd, vars);
      if (cwd === ".") cwd = "";
      continue;
    }
    const targets = shellWriteTargets(sub);
    if (targets === null) continue;
    if (cwd && policy.isProtected(cwd)) return sub;
    for (const word of targets) {
      if (isDynamicWord(word) && !/^\$\{?[A-Za-z_]|^\$env:|^\$\(pwd\)|^`pwd`/i.test(word)) continue;
      const p = resolveShellPath(word, projectRoot, cwd, vars);
      if (policy.isProtected(p)) return sub;
      if (hasGlob(p)) {
        const re = shellGlobRegExp(p);
        if (policy.samples.some((s) => re.test(s))) return sub;
      }
    }
  }
  return null;
}

/**
 * The directory each sub-command runs in after the `cd`s before it, as the shell word
 * (`..`, `src`, `/`, `~`), relative ones joined; "" means the starting directory.
 */
export function cwdPerSubCommand(subCommands: string[]): string[] {
  let cwd = "";
  return subCommands.map((sub) => {
    const here = cwd;
    const cd = cdTarget(sub);
    if (cd !== null) {
      const t = cd.replace(/\\/g, "/");
      cwd = /^(?:\/|[a-zA-Z]:|~|\$|%)/.test(t) ? t : posix.join(cwd || ".", t);
      if (cwd === ".") cwd = "";
    }
    return here;
  });
}
