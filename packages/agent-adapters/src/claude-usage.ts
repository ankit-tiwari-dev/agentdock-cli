import type { ModelUsage } from "../../core/src/session-usage.ts";
import { createClaudeTranscriptAccumulator, usageByModel } from "./backtracer.ts";

/** Per-model token use and cost of a Claude Code transcript, read line by line. Lines that do not parse are skipped. */
export async function readClaudeUsage(lines: AsyncIterable<string>, sessionId?: string): Promise<ModelUsage[]> {
  const accumulator = createClaudeTranscriptAccumulator(sessionId);
  for await (const line of lines) accumulator.addLine(line);
  return usageByModel(accumulator.finish());
}
