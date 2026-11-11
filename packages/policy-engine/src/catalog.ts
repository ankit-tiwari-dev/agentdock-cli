import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PolicyRule, RuleContext } from "../../core/src/index.ts";
import { DEFAULT_SAFETY_RULES, createSafetyRules, deepFreeze, type SafetyRuleOptions } from "./default-rules.ts";
import { argv, gitSubcommand } from "./command-checks.ts";
import { matchesAnyGlob } from "./glob.ts";
import { splitShellSegments } from "./shell.ts";

function list(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function allowedByPattern(sub: string, params: Record<string, unknown>): boolean {
  return list(params, "allowPatterns").some((p) => {
    try {
      return new RegExp(p, "i").test(sub);
    } catch {
      return false;
    }
  });
}

function firstSub(ctx: RuleContext, test: (sub: string, t: string[]) => boolean): string | null {
  for (const sub of ctx.subCommands) {
    if (test(sub, argv(sub))) return sub;
  }
  return null;
}

function currentBranch(root: string): string | null {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const INFRA_TOOLS: { id: string; name: string; bins: string[]; mutating: RegExp }[] = [
  {
    id: "RULE-INFRA-KUBECTL",
    name: "Kubernetes changes need approval",
    bins: ["kubectl", "oc"],
    mutating:
      /\b(apply|create|delete|edit|patch|replace|scale|rollout|drain|cordon|taint|label|annotate|set|exec|cp)\b/,
  },
  {
    id: "RULE-INFRA-TERRAFORM",
    name: "Terraform changes need approval",
    bins: ["terraform", "tofu", "terragrunt"],
    mutating: /\b(apply|destroy|import|taint|untaint|state\s+(rm|mv|push)|force-unlock)\b/,
  },
  {
    id: "RULE-INFRA-HELM",
    name: "Helm releases need approval",
    bins: ["helm"],
    mutating: /\b(install|upgrade|uninstall|delete|rollback)\b/,
  },
  {
    id: "RULE-INFRA-CLOUD-CLI",
    name: "Cloud CLI changes need approval",
    bins: ["aws", "gcloud", "az", "doctl", "flyctl", "vercel", "netlify", "heroku"],
    mutating:
      /\b(create|delete|remove|rm|update|put|set|deploy|terminate|stop|start|restart|destroy|attach|detach|modify|scale|purge)\b/,
  },
];

const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"]);
const SCRIPT_RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
  "pwsh",
  "powershell",
  "iex",
  "invoke-expression",
  "source",
  ".",
]);
const DOWNLOAD_SUBSTITUTION =
  /(?:<\(|\$\(|`)\s*(?:\S*[\\/])?(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
const PWSH_DOWNLOAD_EXPRESSION =
  /\b(?:iex|invoke-expression)\s*[(\s]\s*\(*\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object)\b/i;

/** A download that runs as code: piped into, substituted into, or evaluated by a shell or interpreter. */
function runsDownload(cmd: string): boolean {
  if (PWSH_DOWNLOAD_EXPRESSION.test(cmd)) return true;
  for (const seg of splitShellSegments(cmd)) {
    if (!SCRIPT_RUNNERS.has(argv(seg.text)[0] ?? "")) continue;
    if (seg.pipedFrom.some((stage) => DOWNLOADERS.has(argv(stage)[0] ?? ""))) return true;
    if (DOWNLOAD_SUBSTITUTION.test(seg.text)) return true;
  }
  return false;
}

const PROC_ENVIRON = /^\/proc\/(?:self|thread-self|\d+|\*)\/environ$/;

export const EXTENDED_RULES: readonly PolicyRule[] = deepFreeze([
  {
    id: "RULE-BLOCK-ENV-DUMP",
    name: "Block environment variable dumps",
    description:
      "Stops `env`, `printenv`, `set` and similar from printing every secret in the environment into the transcript.",
    event: "PreToolUse",
    category: "secrets",
    targetTools: ["Bash"],
    action: "DENY",
    message:
      "Security Policy: dumping all environment variables would copy secrets into the conversation. Read the one variable you need, by name.",
    check: (ctx) => {
      const sub = firstSub(ctx, (s, t) => {
        const bin = (t[0] ?? "").toLowerCase();
        if ((bin === "env" || bin === "printenv") && t.length === 1) return true;
        if (bin === "set" && t.length === 1) return true;
        if (bin === "export" && (t.length === 1 || t[1] === "-p")) return true;
        if (/^(get-childitem|gci|dir|ls)$/.test(bin) && /^env:\\?$/i.test(t[1] ?? "")) return true;
        if (t.some((a) => PROC_ENVIRON.test(a))) return true;
        return /process\.env\)|os\.environ\b(?!\[|\.get)/.test(s);
      });
      return sub
        ? {
            message: `Security Policy: dumping all environment variables would copy secrets into the conversation. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  {
    id: "RULE-BLOCK-CURL-PIPE-SHELL",
    name: "Block piping downloads into a shell",
    description: "`curl ... | sh` runs code nobody reviewed. Download, read, then run.",
    event: "PreToolUse",
    category: "destructive",
    targetTools: ["Bash"],
    action: "DENY",
    message:
      "Security Policy: piping a download straight into a shell runs unreviewed code. Download the script to a file and inspect it first.",
    check: (ctx) => {
      const cmd = ctx.command ?? "";
      if (
        /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|invoke-expression|pwsh|powershell)\b/i.test(
          cmd,
        ) ||
        runsDownload(cmd)
      ) {
        return {
          message: `Security Policy: piping a download straight into a shell runs unreviewed code. (Triggered by command: '${cmd}')`,
        };
      }
      return null;
    },
  },
  {
    id: "RULE-ASK-SUDO",
    name: "Ask before sudo",
    description: "Privileged commands need a human. Add regexes to params.allowPatterns for ones you trust.",
    event: "PreToolUse",
    category: "destructive",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    params: { allowPatterns: [] as string[] },
    message: "Privileged command: developer approval required.",
    check: (ctx, params) => {
      const sub = ctx.subCommands.find((s) => /^\s*(sudo|doas|runas)\b/i.test(s) && !allowedByPattern(s, params));
      return sub ? { message: `Privileged command needs developer approval. (Triggered by command: '${sub}')` } : null;
    },
  },
  {
    id: "RULE-GIT-PROTECTED-BRANCH-PUSH",
    name: "Ask before pushing to a protected branch",
    description: "Pushing straight to main/master/production skips review.",
    event: "PreToolUse",
    category: "git",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    params: { protectedBranches: ["main", "master", "production", "prod", "release"] },
    message:
      "Pushing to a protected branch requires developer approval. Push a feature branch and open a pull request instead.",
    check: (ctx, params) => {
      const branches = list(params, "protectedBranches");
      for (const sub of ctx.subCommands) {
        const g = gitSubcommand(sub);
        if (!g || g.verb !== "push") continue;
        const positional = g.args.filter((a) => !a.startsWith("-"));
        const refs = positional.slice(1);
        const targets =
          refs.length > 0
            ? refs.map((r) => r.replace(/^\+/, "").split(":").pop() ?? r)
            : [currentBranch(ctx.projectRoot) ?? ""];
        const hit = targets.find((t) => branches.includes(t.replace(/^refs\/heads\//, "")));
        if (hit)
          return {
            message: `Pushing to protected branch '${hit}' requires developer approval. Push a feature branch and open a pull request instead. (Triggered by command: '${sub}')`,
          };
      }
      return null;
    },
  },
  {
    id: "RULE-GIT-COMMIT-ON-PROTECTED",
    name: "Ask before committing on a protected branch",
    description: "Opt-in: keeps agents on feature branches.",
    event: "PreToolUse",
    category: "git",
    enabledByDefault: false,
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    params: { protectedBranches: ["main", "master"] },
    message: "Committing directly on a protected branch requires developer approval. Create a feature branch first.",
    check: (ctx, params) => {
      const branch = currentBranch(ctx.projectRoot);
      if (!branch || !list(params, "protectedBranches").includes(branch)) return null;
      const sub = firstSub(ctx, (s) => {
        const g = gitSubcommand(s);
        return !!g && (g.verb === "commit" || g.verb === "merge" || g.verb === "rebase" || g.verb === "cherry-pick");
      });
      return sub
        ? {
            message: `You are on protected branch '${branch}'. Create a feature branch before committing. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  {
    id: "RULE-GIT-NO-VERIFY",
    name: "Block skipping git hooks",
    description: "`--no-verify` bypasses the project's lint and test gates.",
    event: "PreToolUse",
    category: "git",
    targetTools: ["Bash"],
    action: "DENY",
    message: "Skipping git hooks is not allowed. Fix what the hook reports instead of bypassing it.",
    check: (ctx) => {
      const sub = firstSub(ctx, (s) => {
        const g = gitSubcommand(s);
        return (
          !!g &&
          (g.verb === "commit" || g.verb === "push" || g.verb === "merge") &&
          (g.args.includes("--no-verify") ||
            (g.verb === "commit" && g.args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))))
        );
      });
      return sub
        ? {
            message: `Skipping git hooks is not allowed. Fix what the hook reports instead. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  {
    id: "RULE-GIT-DISCARD-WORK",
    name: "Ask before discarding uncommitted work",
    description:
      "`git checkout -- .`, `git restore .`, `git stash drop/clear`, `git branch -D` lose work that may not be the agent's.",
    event: "PreToolUse",
    category: "git",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    message: "This git command discards work. Developer approval required.",
    check: (ctx) => {
      const sub = firstSub(ctx, (s) => {
        const g = gitSubcommand(s);
        if (!g) return false;
        if (
          g.verb === "checkout" &&
          g.args.includes("--") &&
          g.args.slice(g.args.indexOf("--") + 1).some((a) => a === "." || a === "*")
        )
          return true;
        if (g.verb === "checkout" && g.args.includes(".") && !g.args.includes("-b")) return true;
        if (g.verb === "restore" && !g.args.includes("--staged") && g.args.some((a) => a === "." || a === "*"))
          return true;
        if (g.verb === "stash" && (g.args[0] === "drop" || g.args[0] === "clear")) return true;
        if (g.verb === "branch" && (g.args.includes("-D") || (g.args.includes("-d") && g.args.includes("--force"))))
          return true;
        return false;
      });
      return sub
        ? {
            message: `This git command discards work that may not be yours. Developer approval required. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  {
    id: "RULE-GIT-AMEND",
    name: "Warn on amending commits",
    description: "Amending rewrites a commit that may already be pushed.",
    event: "PreToolUse",
    category: "git",
    targetTools: ["Bash"],
    action: "INSTRUCT",
    message: "Prefer a new commit over --amend; amending rewrites history that may already be pushed.",
    check: (ctx) => {
      const sub = firstSub(ctx, (s) => {
        const g = gitSubcommand(s);
        return !!g && g.verb === "commit" && g.args.includes("--amend");
      });
      return sub
        ? { message: "Prefer a new commit over --amend: amending rewrites history that may already be pushed." }
        : null;
    },
  },
  {
    id: "RULE-GIT-STAGE-ALL",
    name: "Warn on staging everything",
    description: "`git add -A` / `git add .` sweeps in unrelated files and secrets.",
    event: "PreToolUse",
    category: "git",
    targetTools: ["Bash"],
    action: "INSTRUCT",
    message:
      "Stage files by name. `git add -A` or `git add .` can sweep in unrelated changes, build output or secrets.",
    check: (ctx) => {
      const sub = firstSub(ctx, (s) => {
        const g = gitSubcommand(s);
        return !!g && g.verb === "add" && g.args.some((a) => a === "-A" || a === "--all" || a === "." || a === "-u");
      });
      return sub
        ? {
            message:
              "Stage files by name: `git add -A` / `git add .` can sweep in unrelated changes, build output or secrets.",
          }
        : null;
    },
  },
  {
    id: "RULE-GH-PIPELINE",
    name: "Ask before merging, releasing or triggering CI from the agent",
    description: "`gh pr merge`, `gh release create`, `gh workflow run`, `gh secret set` act on shared infrastructure.",
    event: "PreToolUse",
    category: "infra",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    params: { allowPatterns: [] as string[] },
    message: "This GitHub action affects shared infrastructure. Developer approval required.",
    check: (ctx, params) => {
      const sub = firstSub(
        ctx,
        (s, t) =>
          t[0] === "gh" &&
          /^(pr\s+(merge|close)|release\s+(create|delete|edit)|workflow\s+(run|enable|disable)|secret\s+(set|delete)|variable\s+(set|delete)|repo\s+(delete|archive|edit|rename))\b/.test(
            t.slice(1, 3).join(" "),
          ) &&
          !allowedByPattern(s, params),
      );
      return sub
        ? {
            message: `This GitHub action affects shared infrastructure. Developer approval required. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  ...INFRA_TOOLS.map((tool): PolicyRule => ({
    id: tool.id,
    name: tool.name,
    description: `Read-only ${tool.bins.join("/")} commands pass; anything that changes infrastructure asks first. Trusted commands go in params.allowPatterns.`,
    event: "PreToolUse",
    category: "infra",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    params: { allowPatterns: [] as string[] },
    message: `${tool.name}.`,
    check: (ctx, params) => {
      const sub = firstSub(
        ctx,
        (s, t) =>
          tool.bins.includes((t[0] ?? "").toLowerCase()) &&
          tool.mutating.test(t.slice(1).join(" ")) &&
          !allowedByPattern(s, params),
      );
      return sub ? { message: `${tool.name}. (Triggered by command: '${sub}')` } : null;
    },
  })),
  {
    id: "RULE-DB-DESTRUCTIVE-SQL",
    name: "Ask before destructive SQL",
    description: "DROP, TRUNCATE, and DELETE/UPDATE without WHERE, in shell commands.",
    event: "PreToolUse",
    category: "database",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    message:
      "Destructive SQL needs developer approval. Count the affected rows first and scope the statement to explicit ids.",
    check: (ctx) => {
      const cmd = ctx.command ?? "";
      const destructive =
        /\b(drop\s+(table|database|schema|index|view)|truncate\s+(table\s+)?\w)/i.test(cmd) ||
        /\bdelete\s+from\s+[\w."`[\]]+\s*(;|"|'|$)/im.test(cmd) ||
        /\bupdate\s+[\w."`[\]]+\s+set\b(?![\s\S]*\bwhere\b)/i.test(cmd) ||
        /\.(drop|deleteMany|remove)\(\s*(\{\s*\})?\s*\)/.test(cmd) ||
        /\bflushall\b|\bflushdb\b/i.test(cmd);
      return destructive
        ? {
            message:
              "Destructive database statement: developer approval required. Count the affected rows first and scope it to explicit ids.",
          }
        : null;
    },
  },
  {
    id: "RULE-DB-SCHEMA-CHANGE",
    name: "Warn on schema changes run from the shell",
    description: "ALTER TABLE ... DROP/RENAME run directly instead of through a migration.",
    event: "PreToolUse",
    category: "database",
    targetTools: ["Bash"],
    action: "INSTRUCT",
    message: "Schema changes belong in a migration file, not an ad-hoc shell command.",
    check: (ctx) =>
      /\balter\s+table\b[\s\S]*\b(drop|rename)\b/i.test(ctx.command ?? "")
        ? { message: "Schema change run ad hoc: put it in a migration file so it is reviewed and reproducible." }
        : null,
  },
  {
    id: "RULE-PKG-PUBLISH",
    name: "Ask before publishing packages or images",
    description: "npm/pnpm/yarn publish, cargo publish, twine upload, gem push, docker push.",
    event: "PreToolUse",
    category: "packages",
    targetTools: ["Bash"],
    action: "REQUIRE_MANUAL_APPROVAL",
    message: "Publishing is public and permanent. Developer approval required.",
    check: (ctx) => {
      const sub = firstSub(ctx, (_s, t) => {
        const a = t.join(" ");
        return (
          /^(npm|pnpm|yarn|bun)\s+publish\b/.test(a) ||
          /^cargo\s+publish\b/.test(a) ||
          /^twine\s+upload\b/.test(a) ||
          /^gem\s+push\b/.test(a) ||
          /^(docker|podman)\s+push\b/.test(a) ||
          /^poetry\s+publish\b/.test(a) ||
          /^uv\s+publish\b/.test(a)
        );
      });
      return sub
        ? {
            message: `Publishing is public and permanent. Developer approval required. (Triggered by command: '${sub}')`,
          }
        : null;
    },
  },
  {
    id: "RULE-PKG-GLOBAL-INSTALL",
    name: "Warn on global installs",
    description: "Global installs change the developer's machine, not the project.",
    event: "PreToolUse",
    category: "packages",
    targetTools: ["Bash"],
    action: "INSTRUCT",
    message: "Install as a project dependency instead of globally; global installs change the developer's machine.",
    check: (ctx) => {
      const sub = firstSub(ctx, (_s, t) => {
        const a = t.join(" ");
        return (
          /^(npm|pnpm|bun)\s+(i|install|add)\b.*\s(-g|--global)\b/.test(a) ||
          /^yarn\s+global\s+add\b/.test(a) ||
          /^pip3?\s+install\b.*\s--user\b/.test(a) ||
          /^cargo\s+install\b/.test(a) ||
          /^go\s+install\b/.test(a)
        );
      });
      return sub
        ? { message: `Install as a project dependency instead of globally. (Triggered by command: '${sub}')` }
        : null;
    },
  },
  {
    id: "RULE-PKG-MANAGER",
    name: "Use the project's package manager",
    description: 'Opt-in. Set params.allowed (e.g. ["pnpm"]) and other managers are blocked.',
    event: "PreToolUse",
    category: "packages",
    enabledByDefault: false,
    targetTools: ["Bash"],
    action: "DENY",
    params: { allowed: [] as string[] },
    message: "Use the project's package manager.",
    check: (ctx, params) => {
      const allowed = list(params, "allowed");
      if (allowed.length === 0) return null;
      const managers = ["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "pipenv"];
      const sub = firstSub(ctx, (_s, t) => managers.includes(t[0] ?? "") && !allowed.includes(t[0]));
      return sub ? { message: `This project uses ${allowed.join("/")}. (Triggered by command: '${sub}')` } : null;
    },
  },
  {
    id: "RULE-READ-OUTSIDE-PROJECT",
    name: "Keep file access inside the project",
    description: "Opt-in. Blocks reads/edits outside the project root except params.allowPaths globs.",
    event: "PreToolUse",
    category: "secrets",
    enabledByDefault: false,
    targetTools: ["Read", "Edit", "Write", "Grep", "Glob"],
    action: "DENY",
    params: { allowPaths: ["~/.claude/**", "/tmp/**"] },
    message: "File access outside the project is not allowed.",
    check: (ctx, params) => {
      const outside = ctx.filePaths.find((p) => isAbsolute(p) && !matchesAnyGlob(p, list(params, "allowPaths")));
      return outside
        ? { message: `File access outside the project is not allowed. (Target file: '${outside}')` }
        : null;
    },
  },
  {
    id: "RULE-LARGE-FILE-WRITE",
    name: "Warn on very large file writes",
    description: "A single write above params.thresholdKb is usually generated output or a mistake.",
    event: "PreToolUse",
    category: "agent-behavior",
    targetTools: ["Write", "Edit"],
    action: "INSTRUCT",
    params: { thresholdKb: 512 },
    message: "Very large file write.",
    check: (ctx, params) => {
      const limit = Number(params.thresholdKb ?? 512) * 1024;
      const size = Buffer.byteLength(ctx.content ?? "", "utf8");
      return size > limit
        ? {
            message: `This write is ${(size / 1024).toFixed(0)} KB. Generated or vendored output should not be hand-written into the repo; check this is intended.`,
          }
        : null;
    },
  },
  {
    id: "RULE-BACKGROUND-PROCESS",
    name: "Warn on detached background processes",
    description: "Processes left running after the turn keep ports and files locked.",
    event: "PreToolUse",
    category: "agent-behavior",
    targetTools: ["Bash"],
    action: "INSTRUCT",
    message: "Background process started: stop it when you are done so it does not hold ports or files.",
    check: (ctx) => {
      const cmd = ctx.command ?? "";
      return /\bnohup\b|\bdisown\b|\bsetsid\b|Start-Process\b|&\s*$/.test(cmd.trim())
        ? {
            message:
              "You started a detached background process. Note its PID and stop it before you finish so it does not hold ports or files.",
          }
        : null;
    },
  },

  {
    id: "STOP-NO-CONFLICT-MARKERS",
    name: "No merge-conflict markers at turn end",
    description: "Stops the agent from finishing while changed files still contain <<<<<<< markers.",
    event: "Stop",
    category: "workflow",
    action: "DENY",
    message: "Changed files still contain merge-conflict markers.",
    check: (ctx) => {
      if (ctx.permissionMode === "plan" || !existsSync(join(ctx.projectRoot, ".git"))) return null;
      const changed = (git(ctx.projectRoot, ["diff", "--name-only", "HEAD"]) ?? "").split(/\r?\n/).filter(Boolean);
      const hits = changed.filter((f) => {
        try {
          return /^(<{7}|>{7}) /m.test(readFileSync(join(ctx.projectRoot, f), "utf8"));
        } catch {
          return false;
        }
      });
      return hits.length
        ? { message: `Resolve the merge-conflict markers in: ${hits.slice(0, 10).join(", ")}.` }
        : null;
    },
  },
  {
    id: "STOP-REQUIRE-COMMIT",
    name: "Commit before finishing",
    description: "Opt-in. The agent cannot end its turn with uncommitted changes.",
    event: "Stop",
    category: "workflow",
    enabledByDefault: false,
    action: "DENY",
    message: "There are uncommitted changes.",
    check: (ctx) => {
      if (ctx.permissionMode === "plan") return null;
      const status = git(ctx.projectRoot, ["status", "--porcelain"]);
      if (!status || !status.trim()) return null;
      const files = status
        .trim()
        .split(/\r?\n/)
        .slice(0, 8)
        .map((l) => l.slice(3));
      return { message: `Commit your changes before finishing (uncommitted: ${files.join(", ")}).` };
    },
  },
  {
    id: "STOP-REQUIRE-PUSH",
    name: "Push before finishing",
    description: "Opt-in. The agent cannot end its turn with local commits that are not on the remote.",
    event: "Stop",
    category: "workflow",
    enabledByDefault: false,
    action: "DENY",
    message: "There are unpushed commits.",
    check: (ctx) => {
      if (ctx.permissionMode === "plan") return null;
      const ahead = git(ctx.projectRoot, ["rev-list", "--count", "@{upstream}..HEAD"]);
      if (ahead === null) return null;
      const n = Number(ahead.trim());
      return n > 0 ? { message: `Push your ${n} local commit(s) before finishing.` } : null;
    },
  },
]);

/** Built-in catalog in evaluation order: integrity and safety first, workflow gates last. Frozen. */
export const BUILTIN_RULES: readonly PolicyRule[] = deepFreeze([...DEFAULT_SAFETY_RULES, ...EXTENDED_RULES]);

/**
 * A fresh copy of the catalog for one project. The safety rules are rebuilt from scratch, so
 * nothing a custom rules module did to the exported objects can reach the engine.
 */
export function createBuiltinRules(options: SafetyRuleOptions = {}): readonly PolicyRule[] {
  return deepFreeze([...createSafetyRules(options), ...EXTENDED_RULES]);
}
