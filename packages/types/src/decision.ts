import { z } from "zod";
import { AssetIdSchema, MoveIdSchema } from "./ids.js";
import { MoneyCents, PriceMicros, QtyMicros } from "./money.js";

/**
 * Order side. Shorting is not representable for v1 opens —
 * SELL is only against held long qty.
 */
export const Side = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof Side>;

/**
 * Limit-only. Market orders are deliberately absent from the type system.
 */
export const OrderType = z.literal("limit");
export type OrderType = z.infer<typeof OrderType>;

export const TimeInForce = z.enum(["day", "gtc", "ioc", "fok"]);
export type TimeInForce = z.infer<typeof TimeInForce>;

/**
 * A pre-validated legal move the model may pick by id.
 * Off-menu proposals are structurally impossible at the decision boundary.
 */
export const LegalMove = z.discriminatedUnion("kind", [
  z.object({
    id: MoveIdSchema,
    kind: z.literal("WAIT"),
    reason: z.string().optional(),
  }),
  z.object({
    id: MoveIdSchema,
    kind: z.literal("BUY"),
    assetId: AssetIdSchema,
    ticker: z.string().min(1),
    /** Max qty the rails allow right now (micros). */
    maxQtyMicros: QtyMicros,
    /** Suggested / cap notional in cents. */
    maxNotionalCents: MoneyCents,
    /** Limit price at menu-compute time (micros). Re-quoted before submit. */
    limitPriceMicros: PriceMicros,
    conviction: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    id: MoveIdSchema,
    kind: z.literal("SELL"),
    assetId: AssetIdSchema,
    ticker: z.string().min(1),
    /** Max qty sellable = ledger qty − open sell orders. */
    maxQtyMicros: QtyMicros,
    limitPriceMicros: PriceMicros,
    /** Why this SELL is legal even if exclusion/minHold would block buys. */
    lane: z.enum(["discretionary", "stop", "exclusion", "risk", "corp_action"]),
  }),
]);
export type LegalMove = z.infer<typeof LegalMove>;

/**
 * Model decision contract. The model MUST pick an existing moveId from
 * today's menu — it cannot invent tickers, sizes, or sides.
 */
export const DecisionSchema = z.object({
  moveId: MoveIdSchema,
  /** Optional size ≤ menu max. If omitted, executor uses menu max or a sizing rule. */
  qtyMicros: QtyMicros.optional(),
  /** Optional limit re-price within re-quote gap rails. */
  limitPriceMicros: PriceMicros.optional(),
  confidence: z.number().min(0).max(1).optional(),
  thesis: z.string().min(1),
  noteToFutureSelf: z.string().max(2000).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const OrderStatus = z.enum([
  "submitted",
  "placed",
  "partially_filled",
  "filled",
  "canceled",
  "expired",
  "rejected",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;
