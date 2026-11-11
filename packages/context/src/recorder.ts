import type { AgentHookPayload } from "../../core/src/index.ts";
import type { StorageEngine } from "../../storage/src/index.ts";
import { diffCapabilities, renderCapabilities, scanCapabilities, type Capability } from "./capabilities.ts";
import { cleanPrompt } from "./intent.ts";
import { aiSummarize, digestSession, isEmptyDigest, renderDigest, type SummaryRunner } from "./summary.ts";

export interface RecorderOptions {
  /** Ask the local `claude` CLI for a model-written summary at compaction and session end. */
  aiSummaries?: boolean;
  /** Set false where nothing may outlive the call (the daemon-less hook process). */
  allowAsync?: boolean;
  summaryRunner?: SummaryRunner;
  home?: string;
}

/**
 * Turns hook events into context entries. Everything a SessionStart context pack needs is written
 * synchronously before the hook returns; only the optional model summary runs afterwards.
 */
export class ContextRecorder {
  private pendingAi = new Set<Promise<void>>();
  private storage: StorageEngine;
  private projectRoot: string;
  private options: RecorderOptions;

  constructor(storage: StorageEngine, projectRoot: string, options: RecorderOptions = {}) {
    this.storage = storage;
    this.projectRoot = projectRoot;
    this.options = options;
  }

  public record(payload: AgentHookPayload, sessionId: string): void {
    switch (payload.hookEventName) {
      case "UserPromptSubmit": {
        const text = cleanPrompt(payload.prompt);
        if (text) this.storage.addContextEntry({ sessionId, kind: "intent", body: text });
        return;
      }
      case "SessionStart":
        this.snapshotCapabilities(sessionId);
        return;
      case "Stop":
        this.writeSummary(sessionId, "summary", false);
        return;
      case "PreCompact":
        this.writeSummary(sessionId, "compact", true);
        return;
      case "SessionEnd":
        this.writeSummary(sessionId, "summary", true);
        return;
      default:
        return;
    }
  }

  /** Resolves when every model summary started so far has finished (tests and shutdown). */
  public async drain(): Promise<void> {
    await Promise.all([...this.pendingAi]);
  }

  private writeSummary(sessionId: string, kind: "summary" | "compact", withAi: boolean): void {
    const digest = digestSession(sessionId, this.storage.listEventsForSession(sessionId), this.projectRoot);
    if (isEmptyDigest(digest)) return;
    const text = renderDigest(digest);
    this.storage.replaceContextEntry({ sessionId, kind, body: text, meta: { ai: false, toolCalls: digest.toolCalls, filesChanged: digest.filesChanged } });

    if (!withAi || !this.options.aiSummaries || this.options.allowAsync === false) return;
    const job = aiSummarize(text, this.options.summaryRunner).then((ai) => {
      if (!ai) return;
      try {
        this.storage.replaceContextEntry({ sessionId, kind, body: ai, meta: { ai: true, toolCalls: digest.toolCalls, filesChanged: digest.filesChanged } });
      } catch {
        // Store closed while the model was answering.
      }
    });
    this.pendingAi.add(job);
    job.finally(() => this.pendingAi.delete(job));
  }

  /** Stores the capability list only when it changed, with what was added since the previous snapshot. */
  private snapshotCapabilities(sessionId: string): void {
    const current = scanCapabilities(this.projectRoot, this.options.home);
    const last = this.storage.listContextEntries("capabilities", { limit: 1 })[0];
    const previous = (last?.meta?.items as Capability[] | undefined) ?? null;
    const { added, removed } = previous ? diffCapabilities(previous, current) : { added: [], removed: [] };
    if (previous && !added.length && !removed.length) return;
    this.storage.addContextEntry({ sessionId, kind: "capabilities", body: renderCapabilities(current), meta: { items: current, added, removed, first: !previous } });
  }
}
