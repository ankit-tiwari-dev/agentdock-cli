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

/** The developer's own words from a prompt: harness-injected blocks removed, whitespace collapsed, length capped. */
export function cleanPrompt(prompt: string | undefined, maxChars = 400): string {
  if (!prompt) return "";
  let text = prompt;
  for (const tag of NOISE_TAGS) {
    text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
