import { redactSecrets } from "../../storage/src/redactor.ts";

const NOISE_TAGS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "user-prompt-submit-hook",
];

/**
 * Agent-controlled text (skill and subagent names, file paths, MCP server names, notes) as one inert line: line
 * breaks become spaces and a leading `#` or `- [` is escaped, so the text cannot open a heading or a checklist
 * item of its own in a summary or a context pack.
 */
export function inertLine(text: string): string {
  return text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ").replace(/^(\s*)(#|- \[)/, "$1\\$2");
}

/**
 * The developer's own words from a prompt: secrets redacted, harness-injected blocks removed, whitespace collapsed,
 * length capped. Redaction comes before the cap: a cut can remove the end of a secret (a private key's END line, the
 * tail of a token) that the redactor needs to recognise it.
 */
export function cleanPrompt(prompt: string | undefined, maxChars = 400): string {
  if (!prompt) return "";
  let text = redactSecrets(prompt).sanitized;
  for (const tag of NOISE_TAGS) {
    text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
