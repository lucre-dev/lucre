import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  hashEvent,
  reduceEvents,
  EMPTY_STATE,
  type LedgerState,
} from "@lucre/core";
import {
  LucreEvent,
  SCHEMA_VERSION,
  type LucreEvent as LucreEventT,
  type LucreEventBody,
} from "@lucre/types";
import { eventsPath, lucreHome } from "../paths.js";
import { withLock } from "./lock.js";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface EventStore {
  home: string;
  path: string;
  load(): LucreEventT[];
  reduce(): LedgerState;
  /** Verify every line parses and the hash chain is intact. */
  verifyChain(): { ok: true; count: number; tip: string | null } | { ok: false; error: string };
  /**
   * Append one event under lock. Computes seq + hash from current tip.
   * fsyncs after write.
   */
  append(body: LucreEventBody, createdAt?: string): Promise<LucreEventT>;
  /** Append multiple bodies in one lock (sequential chain). */
  appendMany(bodies: LucreEventBody[], createdAt?: string): Promise<LucreEventT[]>;
}

export function openStore(home = lucreHome()): EventStore {
  const file = eventsPath(home);
  return {
    home,
    path: file,

    load(): LucreEventT[] {
      if (!existsSync(file)) return [];
      const text = readFileSync(file, "utf8");
      if (!text.trim()) return [];
      const events: LucreEventT[] = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new StoreError(`invalid JSON at ${file}:${i + 1}`);
        }
        const parsed = LucreEvent.safeParse(raw);
        if (!parsed.success) {
          throw new StoreError(
            `event schema fail at ${file}:${i + 1}: ${parsed.error.message}`,
          );
        }
        events.push(parsed.data);
      }
      return events;
    },

    reduce(): LedgerState {
      return reduceEvents(this.load(), EMPTY_STATE);
    },

    verifyChain() {
      try {
        const events = this.load();
        let prevHash: string | null = null;
        let expectedSeq = 1;
        for (const e of events) {
          if (e.prevHash !== prevHash) {
            return {
              ok: false as const,
              error: `hash chain broken at seq=${e.seq}: prevHash mismatch`,
            };
          }
          if (e.seq !== expectedSeq) {
            return {
              ok: false as const,
              error: `seq gap at event ${e.id}: expected ${expectedSeq}, got ${e.seq}`,
            };
          }
          const recomputed = hashEvent(prevHash, {
            id: e.id,
            seq: e.seq,
            createdAt: e.createdAt,
            schemaVersion: e.schemaVersion,
            kind: e.kind,
            payload: e.payload,
          });
          if (recomputed !== e.hash) {
            return {
              ok: false as const,
              error: `hash mismatch at seq=${e.seq} id=${e.id}`,
            };
          }
          // Full reduce also enforces domain invariants
          prevHash = e.hash;
          expectedSeq += 1;
        }
        // Domain reduce (throws on invariant break)
        reduceEvents(events, EMPTY_STATE);
        return {
          ok: true as const,
          count: events.length,
          tip: prevHash,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async append(body, createdAt) {
      const [ev] = await this.appendMany([body], createdAt);
      return ev!;
    },

    async appendMany(bodies, createdAt) {
      if (bodies.length === 0) return [];
      return withLock(
        async () => {
          await mkdir(home, { recursive: true });
          const existing = this.load();
          let state = reduceEvents(existing, EMPTY_STATE);
          const out: LucreEventT[] = [];
          const at = createdAt ?? new Date().toISOString();

          for (const body of bodies) {
            const id = randomUUID();
            const seq = state.lastSeq + 1;
            const envelope = {
              id,
              seq,
              createdAt: at,
              schemaVersion: SCHEMA_VERSION,
              kind: body.kind,
              payload: body.payload,
            };
            const hash = hashEvent(state.lastHash, envelope as never);
            const event = {
              ...envelope,
              prevHash: state.lastHash,
              hash,
            } as LucreEventT;

            // Validate full event schema before write
            const parsed = LucreEvent.parse(event);
            appendLineFsync(file, JSON.stringify(parsed));
            out.push(parsed);
            state = reduceEvents([parsed], state);
          }
          return out;
        },
        { home },
      );
    },
  };
}

function appendLineFsync(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    writeSync(fd, line.endsWith("\n") ? line : `${line}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
