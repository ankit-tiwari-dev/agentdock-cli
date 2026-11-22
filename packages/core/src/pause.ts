import { readFileSync } from "node:fs";
import { pauseStatePath } from "./paths.ts";

export const PAUSE_CEILING_MS = 8 * 60 * 60 * 1000;

export interface PauseState {
  firstPausedAt: number;
  until: number;
}

/**
 * The active pause, or null. It never throws and never touches the file: the hook reads it before anything else,
 * so a crash later on can still be bypassed by the developer (D-18). Anything unreadable counts as not paused.
 * The 8-hour ceiling applies here too, so a hand-edited file cannot pause supervision for longer.
 */
export function activePause(projectRoot: string, now = Date.now()): PauseState | null {
  try {
    const state = JSON.parse(readFileSync(pauseStatePath(projectRoot), "utf8")) as Partial<PauseState> | null;
    const first = state?.firstPausedAt;
    const until = state?.until;
    if (typeof first !== "number" || !Number.isFinite(first) || first > now || typeof until !== "number") return null;
    const capped = Math.min(until, first + PAUSE_CEILING_MS);
    return capped > now ? { firstPausedAt: first, until: capped } : null;
  } catch {
    return null;
  }
}
