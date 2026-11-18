import type { ModelUsage, Session } from "../../core/src/index.ts";
import { readClaudeUsage } from "../../agent-adapters/src/claude-usage.ts";
import {
  checkTranscriptPath,
  defaultOpener,
  MAX_TRANSCRIPT_BYTES,
  type GuardFs,
  type TranscriptOpener,
  type TranscriptRefusal,
} from "./transcript-guard.ts";

export type UsageJobOutcome = "written" | "skipped" | "empty" | `refused:${TranscriptRefusal}` | "failed";

export interface UsageJobDeps {
  storage: {
    getSession(id: string): Session | null;
    replaceSessionUsage(sessionId: string, rows: readonly ModelUsage[], updatedAt?: number): void;
  };
  home: string;
  fs?: GuardFs;
  opener?: TranscriptOpener;
  warn: (line: string) => void;
  now?: () => number;
  /** Tests only. */
  onDone?: (sessionId: string, outcome: UsageJobOutcome) => void;
}

/** How long a session must be quiet after a Stop before its transcript is read. */
export const USAGE_SETTLE_MS = 1000;

interface Slot {
  timer: ReturnType<typeof setTimeout> | null;
  again: boolean;
  done: Promise<void>;
  finish: () => void;
}

/**
 * Records a Claude Code session's token use and cost after Stop or SessionEnd, off the hook's path. Parsing a large
 * transcript takes tens of milliseconds of the daemon's time, so a job waits until the session has been quiet for
 * `settleMs` and a burst of Stops reads the file once. One job per session at a time: a Stop that arrives while that
 * session's job runs asks for one more run after another quiet wait. A job that fails is not retried; the next Stop
 * reads the whole file again.
 */
export class UsageJobQueue {
  private deps: UsageJobDeps;
  private settleMs: number;
  private slots = new Map<string, Slot>();
  private closed = false;

  constructor(deps: UsageJobDeps & { settleMs?: number }) {
    this.deps = deps;
    this.settleMs = deps.settleMs ?? USAGE_SETTLE_MS;
  }

  public schedule(sessionId: string): void {
    if (this.closed) return;
    const slot = this.slots.get(sessionId);
    if (slot) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = this.arm(sessionId, slot);
      } else {
        slot.again = true;
      }
      return;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const fresh: Slot = { timer: null, again: false, done, finish };
    this.slots.set(sessionId, fresh);
    fresh.timer = this.arm(sessionId, fresh);
  }

  /** Resolves when no job is running or waiting. */
  public async idle(): Promise<void> {
    while (this.slots.size > 0) {
      await Promise.all([...this.slots.values()].map((s) => s.done));
    }
  }

  /** Stops taking jobs, runs the waiting ones now and waits for all, so no write reaches a closed database. */
  public async close(): Promise<void> {
    this.closed = true;
    for (const [sessionId, slot] of this.slots) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        this.start(sessionId, slot);
      }
    }
    await this.idle();
  }

  private arm(sessionId: string, slot: Slot): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.start(sessionId, slot), this.settleMs);
  }

  private start(sessionId: string, slot: Slot): void {
    slot.timer = null;
    void this.drain(sessionId, slot);
  }

  private async drain(sessionId: string, slot: Slot): Promise<void> {
    try {
      for (;;) {
        slot.again = false;
        const outcome = await this.run(sessionId);
        try {
          this.deps.onDone?.(sessionId, outcome);
        } catch {
          // A test listener must not stop the queue.
        }
        if (!slot.again) break;
        if (!this.closed) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      }
    } finally {
      this.slots.delete(sessionId);
      slot.finish();
    }
  }

  private async run(sessionId: string): Promise<UsageJobOutcome> {
    try {
      const session = this.deps.storage.getSession(sessionId);
      const transcriptPath = session?.metadata?.transcriptPath;
      if (session?.agentType !== "claude-code" || typeof transcriptPath !== "string" || !transcriptPath) {
        return "skipped";
      }

      const checked = await checkTranscriptPath(transcriptPath, { home: this.deps.home, fs: this.deps.fs });
      if (!checked.ok) {
        // The reason and id only: the path is the agent's and may name the user's folders.
        this.deps.warn(`usage job refused: reason=${checked.reason} session=${sessionId}`);
        return `refused:${checked.reason}`;
      }

      const opener = this.deps.opener ?? defaultOpener;
      const rows = await readClaudeUsage(opener.lines(checked.realPath, MAX_TRANSCRIPT_BYTES), sessionId);
      if (rows.length === 0) return "empty";
      this.deps.storage.replaceSessionUsage(sessionId, rows, (this.deps.now ?? Date.now)());
      return "written";
    } catch (err) {
      // Never err.message: Node's file errors put the path in it.
      const code = (err as { code?: unknown } | null)?.code;
      this.deps.warn(`usage job failed: code=${typeof code === "string" ? code : "unknown"} session=${sessionId}`);
      return "failed";
    }
  }
}
