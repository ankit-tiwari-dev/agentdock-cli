import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

const cache = new Map<string, RegExp>();

/**
 * Converts a glob into a regex. A pattern without a leading `/` matches at any directory
 * boundary, so `.git/**` matches both `.git/config` and `/repo/.git/config`.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;

  let pattern = glob.replace(/\\/g, "/");
  let anchoredStart = false;
  if (pattern.startsWith("~/")) {
    pattern = homedir().replace(/\\/g, "/") + pattern.slice(1);
    anchoredStart = true;
  } else if (pattern.startsWith("/") || /^[a-zA-Z]:\//.test(pattern)) {
    anchoredStart = true;
  }

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const followedBySlash = pattern[i + 2] === "/";
        re += followedBySlash ? "(?:.*/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }

  const prefix = anchoredStart ? "^" : "(?:^|/)";
  const compiled = new RegExp(`${prefix}${re}$`, "i");
  cache.set(glob, compiled);
  return compiled;
}

/**
 * The name the file system really opens. Windows ignores trailing dots and spaces in each path
 * segment and treats `name:stream` / `name::$DATA` as the file `name`, so `.env::$DATA` and
 * `.claude./settings.json` are read as `.env` and `.claude/settings.json`. Applied on every
 * platform: a rule must never miss a protected file because of how its name was spelled.
 */
export function normalizeFsPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((seg, i) => {
      if (seg === "" || seg === "." || seg === "..") return seg;
      if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg;
      const colon = seg.indexOf(":");
      const base = colon > 0 ? seg.slice(0, colon) : seg;
      const trimmed = base.replace(/[. ]+$/, "");
      return trimmed === "" ? base : trimmed;
    })
    .join("/");
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizeFsPath(path));
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/** Project-relative forward-slash path when inside the project, absolute forward-slash otherwise. */
export function toProjectPath(filePath: string, projectRoot: string): string {
  const expanded = filePath.startsWith("~/") || filePath === "~" ? homedir() + filePath.slice(1) : filePath;
  const abs = isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
  const rel = relative(projectRoot, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
  if (rel === "") return ".";
  return abs.replace(/\\/g, "/");
}
