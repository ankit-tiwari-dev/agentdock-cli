/**
 * ALLOW: let it run. DENY: block it. INSTRUCT: let it run but steer the agent with a message.
 * REQUIRE_MANUAL_APPROVAL: hand the decision to the human ("ask").
 */
export type PolicyAction = "ALLOW" | "DENY" | "INSTRUCT" | "REQUIRE_MANUAL_APPROVAL";

export type PolicyEvent =
  "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SubagentStop" | "SessionStart" | "PreCompact";

/** enforce: the verdict is applied. observe: the verdict is only logged ("would deny"). */
export type PolicyMode = "enforce" | "observe";

export type PolicyCategory =
  "integrity" | "secrets" | "destructive" | "git" | "infra" | "database" | "packages" | "workflow" | "agent-behavior";

export type ConditionType =
  "EXISTING_FILE_MODIFIED" | "DELETION_OF_ASSERTIONS" | "REGEX_COMMAND_MATCH" | "PATH_GLOB_MATCH" | "AST_PATTERN_MATCH";

export interface PolicyCondition {
  type: ConditionType;
  pattern?: string;
  inverted?: boolean;
}

/** Everything a rule may look at, already normalised across agents. */
export interface RuleContext {
  event: PolicyEvent;
  toolName?: string;
  canonicalVerb: string;
  /** Full shell command, when the call runs one. */
  command?: string;
  /** The command split on `&&`, `||`, `;`, `|` and newlines. */
  subCommands: string[];
  /** Project-relative, forward-slash paths (absolute when outside the project). */
  filePaths: string[];
  content?: string;
  projectRoot: string;
  prompt?: string;
  toolResponse?: Record<string, unknown> | string;
  stopHookActive?: boolean;
  permissionMode?: string;
  isExistingFile: (relPath: string) => boolean;
}

export interface RuleHit {
  /** Overrides the rule's default action for this hit. */
  action?: PolicyAction;
  message: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  description?: string;
  event: PolicyEvent;
  category?: PolicyCategory;
  targetTools?: string[];
  filePatterns?: string[];
  commandPatterns?: string[];
  conditions?: PolicyCondition[];
  action: PolicyAction;
  message: string;
  /** Defaults to "enforce". */
  mode?: PolicyMode;
  /** Cannot be disabled, paused or switched to observe. */
  alwaysOn?: boolean;
  /** Defaults to true. Opt-in rules ship with false. */
  enabledByDefault?: boolean;
  /** Tunable values (protected branches, allow-lists, thresholds). Config overrides merge on top. */
  params?: Record<string, unknown>;
  /** For logic a pattern cannot express. Runs after targetTools filtering. */
  check?: (ctx: RuleContext, params: Record<string, unknown>) => RuleHit | null;
}

export interface PolicyEvaluationResult {
  decision: PolicyAction;
  matchedRuleId?: string;
  reason: string;
  steeringInstruction?: string;
  /** Set when a rule matched in observe mode; `decision` is then ALLOW. */
  observed?: { ruleId: string; wouldDecide: PolicyAction; reason: string }[];
  latencyMs: number;
}
