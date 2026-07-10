import { DecisionSchema, type Decision } from "@lucre/types";

/**
 * Normalize model JSON (nullables / alternate keys) into DecisionSchema.
 */
export function parseDecisionJson(raw: string): Decision {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Some models wrap in markdown fences
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("decision is not valid JSON");
    data = JSON.parse(m[0]!);
  }

  if (!data || typeof data !== "object") {
    throw new Error("decision root must be object");
  }

  const o = data as Record<string, unknown>;

  const cleaned = {
    moveId: String(o.moveId ?? o.move_id ?? ""),
    qtyMicros: nullishInt(o.qtyMicros ?? o.qty_micros),
    limitPriceMicros: nullishInt(o.limitPriceMicros ?? o.limit_price_micros),
    confidence: nullishNum(o.confidence),
    thesis: String(o.thesis ?? "").trim(),
    noteToFutureSelf: nullishStr(o.noteToFutureSelf ?? o.note_to_future_self),
  };

  // Drop nulls so zod .optional() accepts
  const forZod: Record<string, unknown> = {
    moveId: cleaned.moveId,
    thesis: cleaned.thesis,
  };
  if (cleaned.qtyMicros !== undefined) forZod.qtyMicros = cleaned.qtyMicros;
  if (cleaned.limitPriceMicros !== undefined)
    forZod.limitPriceMicros = cleaned.limitPriceMicros;
  if (cleaned.confidence !== undefined) forZod.confidence = cleaned.confidence;
  if (cleaned.noteToFutureSelf !== undefined)
    forZod.noteToFutureSelf = cleaned.noteToFutureSelf;

  return DecisionSchema.parse(forZod);
}

function nullishInt(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function nullishNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function nullishStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s.slice(0, 2000) : undefined;
}
