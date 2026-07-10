import { z } from "zod";
import { AssetIdSchema } from "./ids.js";
import { Bps } from "./money.js";

export const PaymentRelation = z.enum([
  "paid_direct",
  "bundled",
  "free_tier",
  "ad_supported",
]);
export type PaymentRelation = z.infer<typeof PaymentRelation>;

export const UniverseStatus = z.enum([
  "tradable",
  "private",
  "unmapped",
  "flagged",
  "add_frozen",
]);
export type UniverseStatus = z.infer<typeof UniverseStatus>;

export const UniverseEntry = z.object({
  assetId: AssetIdSchema,
  cik: z.string().nullable().default(null),
  /** Display-only. Identity is assetId (Alpaca). */
  ticker: z.string().min(1),
  companyName: z.string().min(1),
  exchange: z.string().min(1),
  productsUsed: z.array(z.string()).default([]),
  usageEvidence: z.string().default(""),
  paymentRelation: PaymentRelation,
  conviction: z.number().int().min(1).max(5),
  forcedRank: z.number().int().positive().nullable().default(null),
  status: UniverseStatus,
  sector: z.string().nullable().default(null),
  addedAt: z.string().datetime(),
  lastAffirmedAt: z.string().datetime(),
});
export type UniverseEntry = z.infer<typeof UniverseEntry>;

export const ExclusionCategory = z.enum([
  "alcohol",
  "pork",
  "gambling",
  "tobacco",
  "weapons",
  "adult",
  "interest_finance",
  "custom",
]);
export type ExclusionCategory = z.infer<typeof ExclusionCategory>;

export const ExclusionRule = z.object({
  id: z.string().min(1),
  category: ExclusionCategory,
  customLabel: z.string().nullable().default(null),
  ownerDefinition: z.string().nullable().default(null),
  mode: z.enum(["hard", "soft"]),
  /** Soft only: max acceptable revenue % (e.g. 5 for halal incidental). Hard uses 0. */
  revenueThresholdPct: z.number().min(0).max(100),
  notes: z.string().nullable().default(null),
});
export type ExclusionRule = z.infer<typeof ExclusionRule>;

export const Adjudication = z.object({
  assetId: AssetIdSchema,
  category: ExclusionCategory,
  ruling: z.enum(["keep", "exclude", "exception"]),
  exposureEstimatePct: z.number().min(0).max(100).nullable().default(null),
  thresholdAtRuling: z.number().min(0).max(100).nullable().default(null),
  dataAsOf: z.string().datetime().nullable().default(null),
  ownerQuote: z.string().nullable().default(null),
  /** Held-position lifecycle when exclusion added mid-hold. */
  holdRuling: z
    .enum(["divest_now", "divest_by_date", "grandfather_hold_no_add"])
    .nullable()
    .default(null),
  divestBy: z.string().datetime().nullable().default(null),
});
export type Adjudication = z.infer<typeof Adjudication>;

export const SectorStance = z.enum(["overweight", "neutral", "zero"]);
export type SectorStance = z.infer<typeof SectorStance>;

export const Tilt = z.object({
  tilts: z
    .array(
      z.object({
        sector: z.string().min(1),
        stance: SectorStance,
        targetPctBps: Bps.nullable().default(null),
      }),
    )
    .default([]),
  tolerancePctBps: Bps.default(500),
});
export type Tilt = z.infer<typeof Tilt>;

export const StrategyPrefs = z.object({
  buyAndHoldGrowth: z.boolean().default(true),
  swingMomentum: z.boolean().default(false),
  buyTheDip: z.boolean().default(false),
  dipTriggerPctBps: Bps.nullable().default(null),
  catalystEarnings: z.boolean().default(false),
  earningsBlackoutDays: z.number().int().min(0).default(2),
  /** Ranking of enabled doctrines, highest first. */
  ranking: z.array(z.string()).default(["buyAndHoldGrowth"]),
  capitalWeightsBps: z.record(z.string(), Bps).default({ buyAndHoldGrowth: 10000 }),
});
export type StrategyPrefs = z.infer<typeof StrategyPrefs>;

export const MandateRiskParams = z.object({
  aggressiveness: z.enum(["conservative", "moderate", "aggressive"]).default("moderate"),
  maxPositionPctBps: Bps.default(1000),
  maxSectorPctBps: Bps.default(4000),
  cashFloorPctBps: Bps.default(500),
  drawdownHaltPctBps: Bps.default(1000),
  maxSingleOrderPctBps: Bps.default(1000),
  minHoldDays: z.number().int().min(0).default(0),
  maxTradesPerWeek: z.number().int().positive().default(5),
});
export type MandateRiskParams = z.infer<typeof MandateRiskParams>;

export const Mandate = z.object({
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive().default(1),
  entries: z.array(UniverseEntry),
  watchlist: z.array(UniverseEntry).default([]),
  exclusions: z.array(ExclusionRule).default([]),
  adjudications: z.array(Adjudication).default([]),
  tilt: Tilt.default({ tilts: [], tolerancePctBps: 500 }),
  strategy: StrategyPrefs.default({}),
  risk: MandateRiskParams.default({}),
  interviewTranscriptHash: z.string().nullable().default(null),
});
export type Mandate = z.infer<typeof Mandate>;
