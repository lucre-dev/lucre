import { mkdir, rm, writeFile } from "node:fs/promises";
import { lockPath, lucreHome } from "../paths.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_MS = 25;

/**
 * Exclusive critical section via atomic mkdir lock.
 * Holder writes a pid file for debugging; always releases in finally.
 */
export async function withLock<T>(
  fn: () => Promise<T>,
  opts?: { home?: string; timeoutMs?: number },
): Promise<T> {
  const home = opts?.home ?? lucreHome();
  const dir = lockPath(home);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  // Ensure parent exists
  await mkdir(home, { recursive: true });

  while (true) {
    try {
      await mkdir(dir);
      await writeFile(
        `${dir}/pid`,
        `${process.pid} ${new Date().toISOString()}\n`,
        "utf8",
      );
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `could not acquire lucre lock at ${dir} within ${timeoutMs}ms`,
        );
      }
      await sleep(RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort unlock
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
