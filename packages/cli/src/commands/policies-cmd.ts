import { resolve } from "node:path";
import {
  buildProjectEngine,
  clearPause,
  parseDuration,
  readPause,
  setPause,
  updateRuleOverride,
  PAUSE_DEFAULT_MS,
  type ConfigScope,
} from "../../../policy-engine/src/index.ts";
import type { PolicyAction } from "../../../core/src/index.ts";

export interface CommandResult {
  output: string;
  exitCode: number;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function scopeOf(args: string[]): ConfigScope {
  if (args.includes("--local")) return "local";
  if (args.includes("--user")) return "user";
  return "project";
}

const EXPECT: Record<string, PolicyAction> = {
  allow: "ALLOW",
  deny: "DENY",
  block: "DENY",
  ask: "REQUIRE_MANUAL_APPROVAL",
  instruct: "INSTRUCT",
  steer: "INSTRUCT",
};

const LABEL: Record<PolicyAction, string> = {
  ALLOW: "allow",
  DENY: "deny",
  REQUIRE_MANUAL_APPROVAL: "ask",
  INSTRUCT: "steer",
};

export async function handlePoliciesCommand(
  sub: string | undefined,
  args: string[],
  projectPath = process.cwd(),
): Promise<CommandResult> {
  const root = resolve(projectPath);
  const project = await buildProjectEngine(root);
  const engine = project.engine;
  const rules = engine.getRules();

  if (!sub || sub === "list") {
    const lines = rules.map((r) => {
      const eff = engine.resolveRule(r);
      const state = r.alwaysOn ? "always-on" : eff.enabled ? eff.mode : "off";
      return `${state.padEnd(9)} ${LABEL[r.action].padEnd(5)} ${(r.category ?? "custom").padEnd(14)} ${r.id}  ${r.name}`;
    });
    const pause = readPause(root);
    const header = [
      `${rules.length} rules (${project.customRules.length} custom). Config: ${project.config.sources.length ? project.config.sources.join(", ") : "defaults"}`,
      pause ? `PAUSED until ${new Date(pause.until).toLocaleTimeString()} (always-on rules still apply)` : "",
      `STATE     DOES  CATEGORY       ID  NAME`,
    ].filter(Boolean);
    return { output: [...header, ...lines].join("\n"), exitCode: 0 };
  }

  if (sub === "show") {
    const rule = rules.find((r) => r.id === args[0]);
    if (!rule) return { output: `Unknown rule '${args[0] ?? ""}'. Run \`ctrlplane policies list\`.`, exitCode: 2 };
    const eff = engine.resolveRule(rule);
    return {
      output: [
        `${rule.id} — ${rule.name}`,
        rule.description ?? "",
        `Event: ${rule.event}   Category: ${rule.category ?? "custom"}   Default outcome: ${LABEL[rule.action]}`,
        `State: ${rule.alwaysOn ? "always-on (cannot be disabled, paused or observed)" : eff.enabled ? eff.mode : "off"}`,
        `Tools: ${(rule.targetTools ?? ["*"]).join(", ")}`,
        `Params: ${JSON.stringify(eff.params)}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
      exitCode: 0,
    };
  }

  if (sub === "enable" || sub === "disable" || sub === "observe" || sub === "enforce") {
    const rule = rules.find((r) => r.id === args[0]);
    if (!rule) return { output: `Unknown rule '${args[0] ?? ""}'.`, exitCode: 2 };
    if (rule.alwaysOn && sub !== "enable" && sub !== "enforce") {
      return {
        output: `${rule.id} is always-on: it protects the supervisor itself and cannot be ${sub}d.`,
        exitCode: 2,
      };
    }
    const patch =
      sub === "enable"
        ? { enabled: true }
        : sub === "disable"
          ? { enabled: false }
          : { mode: sub as "observe" | "enforce", enabled: true };
    const path = updateRuleOverride(root, scopeOf(args), rule.id, patch);
    return {
      output: `${rule.id}: ${sub === "observe" ? "observe mode (logs 'would block', never blocks)" : sub + "d"} in ${path}`,
      exitCode: 0,
    };
  }

  if (sub === "set") {
    const [id, param, raw] = args;
    const rule = rules.find((r) => r.id === id);
    if (!rule || !param || raw === undefined)
      return { output: "Usage: ctrlplane policies set <rule-id> <param> <json-value> [--local|--user]", exitCode: 2 };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    const current = engine.resolveRule(rule).params;
    const known = Object.keys(rule.params ?? {});
    if (!known.includes(param)) {
      return {
        output: `${id} has no param '${param}'. Known: ${known.length ? known.join(", ") : "(none)"}`,
        exitCode: 2,
      };
    }
    const path = updateRuleOverride(root, scopeOf(args), id, { params: { ...current, [param]: value } });
    return { output: `${id}.${param} = ${JSON.stringify(value)} in ${path}`, exitCode: 0 };
  }

  if (sub === "test") {
    const command = flag(args, "--command");
    const file = flag(args, "--file");
    const tool = flag(args, "--tool") ?? (command ? "Bash" : "Edit");
    const event = flag(args, "--event") ?? "PreToolUse";
    const expect = flag(args, "--expect");
    if (!command && !file && event === "PreToolUse") {
      return {
        output:
          'Usage: ctrlplane policies test --command "git push --force" [--expect deny]  |  --file path [--tool Edit]',
        exitCode: 2,
      };
    }
    const toolInput: Record<string, unknown> = {};
    if (command) toolInput.command = command;
    if (file) toolInput.file_path = file;
    if (flag(args, "--content")) toolInput.content = flag(args, "--content");

    const result = engine.evaluate({
      event,
      toolName: tool,
      toolInput,
      projectRoot: root,
      breaker: project.newBreaker(),
    });
    const lines = [
      `Decision: ${LABEL[result.decision]}${result.matchedRuleId ? `  (rule ${result.matchedRuleId})` : ""}`,
      `Reason:   ${result.reason}`,
    ];
    for (const o of result.observed ?? [])
      lines.push(`Observed: ${o.ruleId} would ${LABEL[o.wouldDecide]} — ${o.reason}`);

    if (expect) {
      const wanted = EXPECT[expect.toLowerCase()];
      if (!wanted) return { output: `Unknown --expect '${expect}'. Use allow, deny, ask or instruct.`, exitCode: 2 };
      const ok = wanted === result.decision;
      lines.push(ok ? `PASS: expected ${expect}` : `FAIL: expected ${expect}, got ${LABEL[result.decision]}`);
      return { output: lines.join("\n"), exitCode: ok ? 0 : 1 };
    }
    return { output: lines.join("\n"), exitCode: 0 };
  }

  return { output: "Usage: ctrlplane policies <list|show|enable|disable|observe|enforce|set|test> ...", exitCode: 2 };
}

export function handlePauseCommand(args: string[], projectPath = process.cwd()): CommandResult {
  const ms = args[0] ? parseDuration(args[0]) : PAUSE_DEFAULT_MS;
  if (ms === null) return { output: `Could not read duration '${args[0]}'. Examples: 30m, 2h, 1h30m.`, exitCode: 2 };
  const state = setPause(resolve(projectPath), ms);
  const capped = state.until < Date.now() + ms - 1000;
  return {
    output: `Supervision paused until ${new Date(state.until).toLocaleTimeString()}${capped ? " (capped: a pause run can last at most 8h)" : ""}. Always-on integrity rules still apply. Resume with \`ctrlplane resume\`.`,
    exitCode: 0,
  };
}

export function handleResumeCommand(projectPath = process.cwd()): CommandResult {
  return {
    output: clearPause(resolve(projectPath)) ? "Supervision resumed." : "Supervision was not paused.",
    exitCode: 0,
  };
}
