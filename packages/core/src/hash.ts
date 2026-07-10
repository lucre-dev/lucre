import { createHash } from "node:crypto";
import type { LucreEventEnvelope } from "@lucre/types";

/**
 * Deterministic content hash for an event, chaining off the previous hash.
 *
 * hash = sha256(prevHash ‖ envelopeCanonical)
 *
 * Envelope covers id, seq, createdAt, schemaVersion, kind, payload — so
 * timestamps and sequence are tamper-evident (they drive P&L windows / PDT).
 */
export function hashEvent(
  prevHash: string | null,
  envelope: LucreEventEnvelope,
): string {
  const canonical = stableStringify({
    id: envelope.id,
    seq: envelope.seq,
    createdAt: envelope.createdAt,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    payload: envelope.payload,
  });
  return createHash("sha256")
    .update(prevHash ?? "")
    .update("\x1f")
    .update(canonical)
    .digest("hex");
}

/** SHA-256 hex of arbitrary bytes/string (mandate snapshots, sidecars). */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON with object keys sorted recursively — order-independent hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
