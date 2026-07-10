import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Load export KEY=value lines from ~/.tokens into process.env (non-destructive).
 * Used so `lucre` works even if the shell didn't source tokens.
 */
export async function loadTokenStore(
  path = join(homedir(), ".tokens"),
): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^export\s+([A-Z0-9_]+)=(['"]?)(.*)\2\s*$/);
      if (!m) continue;
      const [, key, , val] = m;
      if (key && val !== undefined && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // optional
  }
}

export function bedrockAuthPresent(): boolean {
  return Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() ||
      (process.env.AWS_ACCESS_KEY_ID?.trim() &&
        process.env.AWS_SECRET_ACCESS_KEY?.trim()),
  );
}
