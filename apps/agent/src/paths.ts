import { homedir } from "node:os";
import path from "node:path";

/** Override with LUCRE_HOME for tests / alternate data dirs. */
export function lucreHome(): string {
  return process.env.LUCRE_HOME?.trim() || path.join(homedir(), ".lucre");
}

export function eventsPath(home = lucreHome()): string {
  return path.join(home, "events.jsonl");
}

export function lockPath(home = lucreHome()): string {
  return path.join(home, ".lock");
}

export function sidecarDir(home = lucreHome()): string {
  return path.join(home, "sidecars");
}
