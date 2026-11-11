import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripCommandPrefix, tokenize } from "./shell.ts";
import { isSensitiveFile } from "../../git-analyzer/src/index.ts";

export function argv(sub: string): string[] {
  return stripCommandPrefix(tokenize(sub));
}

function hasShortFlag(tokens: string[], letter: string): boolean {
  return tokens.some((t) => /^-[a-zA-Z]+$/.test(t) && t.includes(letter));
}

/** `rm -rf` (or a Windows equivalent) aimed at a target whose loss is catastrophic. */
export function isCatastrophicDelete(sub: string, projectRoot: string): boolean {
  const t = argv(sub);
  if (t.length === 0) return false;
  const bin = t[0].toLowerCase();

  if (bin === "rm") {
    const recursive = hasShortFlag(t, "r") || hasShortFlag(t, "R") || t.includes("--recursive");
    if (!recursive) return false;
    const targets = t.slice(1).filter((x) => !x.startsWith("-"));
    return targets.some((x) => isCatastrophicTarget(x, projectRoot));
  }

  if (bin === "remove-item" || bin === "rd" || bin === "rmdir" || bin === "del") {
    const recursive = t.some((x) => /^(-recurse|\/s)$/i.test(x));
    if (!recursive) return false;
    const targets = t.slice(1).filter((x) => !x.startsWith("-") && !/^\/[a-z]$/i.test(x));
    return targets.some((x) => isCatastrophicTarget(x, projectRoot));
  }

  if (bin === "find" && t.includes("-delete")) {
    return t[1] !== undefined && isCatastrophicTarget(t[1], projectRoot);
  }
  return false;
}

const TEMP_ROOTS = [tmpdir(), "/tmp", "/var/tmp"].map((p) => p.replace(/\\/g, "/").toLowerCase());

/**
 * Catastrophic: filesystem root, home, bare wildcards, the project root itself, its `.git`,
 * a parent directory, or an absolute path outside both the project and the temp directory.
 */
export function isCatastrophicTarget(target: string, projectRoot: string): boolean {
  const x = target.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (["/", "/*", "~", "~/*", "*", ".", "./*", "$HOME", "${HOME}", "%USERPROFILE%"].includes(x)) return true;
  if (x.startsWith("~") || x.startsWith("$HOME") || x.startsWith("${HOME}") || x.startsWith("%USERPROFILE%")) return true;
  if (x === ".." || x.startsWith("../") || x.includes("/../")) return true;
  if (x === ".git" || x.startsWith(".git/") || x.endsWith("/.git")) return true;

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
  if (rest.some((x) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x))) return true;
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

export function isForceClean(sub: string): boolean {
  const g = gitSubcommand(sub);
  if (!g || g.verb !== "clean") return false;
  const flags = g.args.filter((a) => a.startsWith("-")).join("");
  return flags.includes("f") && (flags.includes("d") || flags.includes("x") || flags.includes("X"));
}

export function isDiskWipe(sub: string): boolean {
  return /^\s*(?:sudo\s+)?(?:mkfs(?:\.\w+)?|format\s+[a-z]:|diskpart|dd\s+.*\bof=\/dev\/)/i.test(sub);
}

const READERS = new Set([
  "cat", "less", "more", "head", "tail", "type", "get-content", "gc", "bat", "nl", "strings",
  "base64", "xxd", "od", "grep", "rg", "awk", "sed", "cp", "scp", "rsync", "source", ".", "open",
]);

/** A shell command that reads or copies a secrets file. */
export function readsSensitiveFile(sub: string): string | null {
  const t = argv(sub);
  if (t.length === 0) return null;
  const bin = t[0].toLowerCase().replace(/\.exe$/, "");
  if (!READERS.has(bin)) {
    const redirectIn = sub.match(/<\s*(\S+)/);
    if (redirectIn && isSensitiveFile(redirectIn[1])) return redirectIn[1];
    return null;
  }
  for (const arg of t.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (isSensitiveFile(arg)) return arg;
  }
  return null;
}

const WRITE_OPS = /(?:^|\s)(?:>>?|tee\b|rm\b|mv\b|cp\b|sed\s+-i|truncate\b|chmod\b|ln\b|Set-Content\b|Out-File\b|Remove-Item\b|Move-Item\b|Copy-Item\b|New-Item\b)/i;

/** A shell command that writes, moves or deletes something under one of `dirs` (e.g. `.ctrlplane/`). */
export function writesUnder(sub: string, dirs: string[]): string | null {
  if (!WRITE_OPS.test(sub) && !/>/.test(sub)) return null;
  const normalized = sub.replace(/\\/g, "/");
  for (const d of dirs) {
    const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s"'=/>])${escaped}`, "i").test(normalized)) return d;
  }
  return null;
}
