import { z } from "zod";
import { Bps, MoneyCents } from "./money.js";

/**
 * Risk rails live in the ledger (GENESIS / CONFIG_CHANGED), not a free-floating
 * config file — replays must reproduce historical behavior under the rules that
 * governed them.
 */
export const RiskConfig = z.object({
  /** Max single position as % of equity (default 10% = 1000 bps). */
  maxPositionPctBps: Bps.default(1000),
  /** Max single sector as % of equity. */
  maxSectorPctBps: Bps.default(4000),
  /** Cash floor as % of equity that must remain uninvested. */
  cashFloorPctBps: Bps.default(500),
  /** Daily equity loss from start-of-day mark → halt new entries (default −2%). */
  dailyLossHaltPctBps: Bps.default(200),
  /** Drawdown from peak equity → full risk halt (default −10%). */
  drawdownHaltPctBps: Bps.default(1000),
  /** Deterministic per-position stop from avg cost (default −8%). */
  stopLossPctBps: Bps.default(800),
  /** Max new orders submitted per trading day. */
  maxOrdersPerDay: z.number().int().positive().default(3),
  /** Max single order notional as % of equity. */
  maxSingleOrderPctBps: Bps.default(1000),
  /** Minimum hold days before non-risk SELL (risk/exclusion exits exempt). */
  minHoldDays: z.number().int().min(0).default(0),
  /** Monthly inference spend cap in cents (default $10.00). */
  monthlySpendCapCents: MoneyCents.default(1000),
  /** Price gap abort: re-quote vs decision-time, abort if |Δ| > this (default 3%). */
  reQuoteGapAbortPctBps: Bps.default(300),
  /** Shorting disabled account-side and in the type system for v1. */
  allowShort: z.literal(false).default(false),
});
export type RiskConfig = z.infer<typeof RiskConfig>;

export const DEFAULT_RISK_CONFIG: RiskConfig = RiskConfig.parse({});
