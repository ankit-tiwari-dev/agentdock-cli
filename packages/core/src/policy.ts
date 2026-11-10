export type PolicyAction =
  | "ALLOW"
  | "DENY"
  | "INSTRUCT"
  | "REQUIRE_MANUAL_APPROVAL";

export type ConditionType =
  | "EXISTING_FILE_MODIFIED"
  | "DELETION_OF_ASSERTIONS"
  | "REGEX_COMMAND_MATCH"
  | "PATH_GLOB_MATCH"
  | "AST_PATTERN_MATCH";

export interface PolicyCondition {
  type: ConditionType;
  pattern?: string;
  inverted?: boolean;
}

export interface PolicyRule {
  id: string;
  name: string;
  description?: string;
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  targetTools?: string[];
  filePatterns?: string[];
  commandPatterns?: string[];
  conditions?: PolicyCondition[];
  action: PolicyAction;
  message: string;
}

export interface PolicyEvaluationResult {
  decision: PolicyAction;
  matchedRuleId?: string;
  reason: string;
  steeringInstruction?: string;
  latencyMs: number;
}

