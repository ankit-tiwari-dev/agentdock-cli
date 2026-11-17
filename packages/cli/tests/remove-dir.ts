import { rmSync } from "node:fs";

const RETRY_CODES = ["EBUSY", "EPERM", "ENOTEMPTY"];

// Node 22's rmSync does not retry EBUSY on the folder itself, so the retry loop is ours (docs/PITFALLS.md P-6).
function tryRemove(dir: string, attempt: number): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (attempt >= 30 || !RETRY_CODES.includes(code)) throw err;
    return false;
  }
}

/** Removes a test folder a process may still hold on Windows, retrying for up to 3 seconds. */
export async function removeDir(dir: string): Promise<void> {
  for (let attempt = 1; !tryRemove(dir, attempt); attempt++) await new Promise((r) => setTimeout(r, 100));
}

/** The same for synchronous tests; blocks the thread between tries. */
export function removeDirSync(dir: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; !tryRemove(dir, attempt); attempt++) Atomics.wait(pause, 0, 0, 100);
}
