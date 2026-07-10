import { z } from "zod";
import { DecisionSchema, OrderStatus, Side, TimeInForce } from "./decision.js";
import {
  AssetIdSchema,
  ClientOrderIdSchema,
  EventIdSchema,
  MoveIdSchema,
  RunIdSchema,
  uuid,
} from "./ids.js";
import { Mandate } from "./mandate.js";
import { MoneyCents, PriceMicros, QtyMicros } from "./money.js";
import { RiskConfig } from "./risk.js";

export const SCHEMA_VERSION = 1 as const;

// ── Event kinds ──────────────────────────────────────────────────────
export const EventKind = z.enum([
  "GENESIS",
  "CONFIG_CHANGED",
  "MANDATE_SET",
  "MANDATE_CHANGED",
  "INTERVIEW_ARCHIVED",
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "MARKET_SNAPSHOT_RECORDED",
  "EQUITY_MARKED",
  "LEGAL_MOVES_COMPUTED",
  "SCREEN_COMPLETED",
  "BATCH_SUBMITTED",
  "DECISION_MADE",
  "DECISION_REJECTED",
  "ORDER_SUBMITTED",
  "ORDER_PLACED",
  "ORDER_FILLED",
  "ORDER_CANCELED",
  "ORDER_EXPIRED",
  "ORDER_REJECTED",
  "CORP_ACTION_APPLIED",
  "POSITIONS_RECONCILED",
  "RECONCILIATION_DIVERGED",
  "BROKER_CORRECTION",
  "INFERENCE_RECORDED",
  "BUDGET_HALTED",
  "BUDGET_RESET",
  "RISK_HALTED",
  "RISK_RESUMED",
  "MEMORY_WRITTEN",
  "REVIEW_COMPLETED",
  "UNIVERSE_TICKER_FLAGGED",
  "UNIVERSE_FLAG_RESOLVED",
  "MANDATE_DRIFT_FLAGGED",
  "MANDATE_ADJUDICATED",
  "POSITION_CONVERTED",
]);
export type EventKind = z.infer<typeof EventKind>;

// ── Per-kind payloads ────────────────────────────────────────────────
const Genesis = z.object({
  kind: z.literal("GENESIS"),
  payload: z.object({
    ownerLabel: z.string().default("syedos"),
    paper: z.boolean().default(true),
    risk: RiskConfig,
    startingCashCents: MoneyCents.default(0),
    decisionModel: z.string().default("gpt-5.6-terra"),
    screenModel: z.string().default("gpt-5.4-mini"),
    reviewModel: z.string().default("gpt-5.6-sol"),
  }),
});

const ConfigChanged = z.object({
  kind: z.literal("CONFIG_CHANGED"),
  payload: z.object({
    risk: RiskConfig.partial().optional(),
    decisionModel: z.string().optional(),
    screenModel: z.string().optional(),
    reviewModel: z.string().optional(),
    note: z.string().optional(),
  }),
});

const MandateSet = z.object({
  kind: z.literal("MANDATE_SET"),
  payload: z.object({
    mandate: Mandate,
    mandateHash: z.string().min(1),
  }),
});

const MandateChanged = z.object({
  kind: z.literal("MANDATE_CHANGED"),
  payload: z.object({
    mandate: Mandate,
    mandateHash: z.string().min(1),
    basedOnVersion: z.number().int().positive(),
    /** ISO datetime; risk-loosening edits may set future effectiveAt (72h cool-off). */
    effectiveAt: z.string().datetime().nullable().default(null),
    diffSummary: z.string().optional(),
  }),
});

const InterviewArchived = z.object({
  kind: z.literal("INTERVIEW_ARCHIVED"),
  payload: z.object({
    transcriptHash: z.string().min(1),
    localPathHint: z.string().optional(),
  }),
});

const RunStarted = z.object({
  kind: z.literal("RUN_STARTED"),
  payload: z.object({
    runId: RunIdSchema,
    slot: z.enum([
      "orphan_sweep",
      "decision_submit",
      "decision_harvest",
      "execute",
      "stop_loss",
      "screen",
      "mark",
      "review",
    ]),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const RunCompleted = z.object({
  kind: z.literal("RUN_COMPLETED"),
  payload: z.object({
    runId: RunIdSchema,
    summary: z.string().optional(),
  }),
});

const RunFailed = z.object({
  kind: z.literal("RUN_FAILED"),
  payload: z.object({
    runId: RunIdSchema,
    error: z.string(),
  }),
});

const MarketSnapshotRecorded = z.object({
  kind: z.literal("MARKET_SNAPSHOT_RECORDED"),
  payload: z.object({
    sidecarSha256: z.string().min(1),
    sidecarPath: z.string().optional(),
    asOf: z.string().datetime(),
  }),
});

const EquityMarked = z.object({
  kind: z.literal("EQUITY_MARKED"),
  payload: z.object({
    equityCents: MoneyCents,
    cashCents: MoneyCents,
    longMarketValueCents: MoneyCents,
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    asOf: z.string().datetime(),
  }),
});

const LegalMovesComputed = z.object({
  kind: z.literal("LEGAL_MOVES_COMPUTED"),
  payload: z.object({
    mandateVersion: z.number().int().positive(),
    mandateHash: z.string().min(1),
    algoVersion: z.string().min(1),
    moveIds: z.array(MoveIdSchema),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const ScreenCompleted = z.object({
  kind: z.literal("SCREEN_COMPLETED"),
  payload: z.object({
    triggersFired: z.array(z.string()),
    escalated: z.boolean(),
    summary: z.string().optional(),
  }),
});

const BatchSubmitted = z.object({
  kind: z.literal("BATCH_SUBMITTED"),
  payload: z.object({
    batchId: z.string().min(1),
    provider: z.string().default("openai"),
    model: z.string(),
    runId: RunIdSchema.optional(),
  }),
});

const DecisionMade = z.object({
  kind: z.literal("DECISION_MADE"),
  payload: z.object({
    decision: DecisionSchema,
    moveId: MoveIdSchema,
    mandateVersion: z.number().int().positive(),
    mandateHash: z.string().min(1),
    algoVersion: z.string().min(1),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    menuMoveIds: z.array(MoveIdSchema),
  }),
});

const DecisionRejected = z.object({
  kind: z.literal("DECISION_REJECTED"),
  payload: z.object({
    reason: z.string(),
    raw: z.string().optional(),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const OrderSubmitted = z.object({
  kind: z.literal("ORDER_SUBMITTED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
    assetId: AssetIdSchema,
    ticker: z.string().min(1),
    side: Side,
    qtyMicros: QtyMicros.positive(),
    limitPriceMicros: PriceMicros,
    timeInForce: TimeInForce.default("day"),
    decisionEventId: EventIdSchema.optional(),
    moveId: MoveIdSchema.optional(),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const OrderPlaced = z.object({
  kind: z.literal("ORDER_PLACED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
    brokerOrderId: z.string().min(1),
    status: OrderStatus.default("placed"),
  }),
});

const OrderFilled = z.object({
  kind: z.literal("ORDER_FILLED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
    fillId: z.string().min(1),
    assetId: AssetIdSchema,
    side: Side,
    qtyMicros: QtyMicros.positive(),
    priceMicros: PriceMicros,
    /** Cash impact: negative for buys (cash out), positive for sells. */
    cashDeltaCents: MoneyCents,
    filledAt: z.string().datetime(),
    partial: z.boolean().default(false),
  }),
});

const OrderCanceled = z.object({
  kind: z.literal("ORDER_CANCELED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
    reason: z.string().optional(),
  }),
});

const OrderExpired = z.object({
  kind: z.literal("ORDER_EXPIRED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
  }),
});

const OrderRejected = z.object({
  kind: z.literal("ORDER_REJECTED"),
  payload: z.object({
    clientOrderId: ClientOrderIdSchema,
    reason: z.string(),
  }),
});

const CorpActionApplied = z.object({
  kind: z.literal("CORP_ACTION_APPLIED"),
  payload: z.object({
    assetId: AssetIdSchema,
    action: z.enum(["split", "reverse_split", "spinoff", "merger", "dividend_cash", "dividend_stock"]),
    /** For splits: newQty = oldQty * numerator / denominator. */
    numerator: z.number().int().positive().optional(),
    denominator: z.number().int().positive().optional(),
    cashDeltaCents: MoneyCents.default(0),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
  }),
});

const PositionsReconciled = z.object({
  kind: z.literal("POSITIONS_RECONCILED"),
  payload: z.object({
    cashCents: MoneyCents,
    positions: z.array(
      z.object({
        assetId: AssetIdSchema,
        ticker: z.string(),
        qtyMicros: QtyMicros,
      }),
    ),
    asOf: z.string().datetime(),
  }),
});

const ReconciliationDiverged = z.object({
  kind: z.literal("RECONCILIATION_DIVERGED"),
  payload: z.object({
    details: z.string(),
    brokerCashCents: MoneyCents.optional(),
    ledgerCashCents: MoneyCents.optional(),
  }),
});

const BrokerCorrection = z.object({
  kind: z.literal("BROKER_CORRECTION"),
  payload: z.object({
    reason: z.string(),
    cashCents: MoneyCents.optional(),
    positions: z
      .array(
        z.object({
          assetId: AssetIdSchema,
          ticker: z.string(),
          qtyMicros: QtyMicros,
          avgCostMicros: PriceMicros.optional(),
        }),
      )
      .optional(),
  }),
});

const InferenceRecorded = z.object({
  kind: z.literal("INFERENCE_RECORDED"),
  payload: z.object({
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costCents: MoneyCents.nonnegative(),
    purpose: z.enum(["decision", "screen", "review", "interview", "other"]),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  }),
});

const BudgetHalted = z.object({
  kind: z.literal("BUDGET_HALTED"),
  payload: z.object({
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    spentCents: MoneyCents,
    capCents: MoneyCents,
  }),
});

const BudgetReset = z.object({
  kind: z.literal("BUDGET_RESET"),
  payload: z.object({
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  }),
});

const RiskHalted = z.object({
  kind: z.literal("RISK_HALTED"),
  payload: z.object({
    reason: z.enum(["daily_loss", "drawdown", "manual", "reconciliation", "other"]),
    detail: z.string().optional(),
  }),
});

const RiskResumed = z.object({
  kind: z.literal("RISK_RESUMED"),
  payload: z.object({
    note: z.string().optional(),
  }),
});

const MemoryWritten = z.object({
  kind: z.literal("MEMORY_WRITTEN"),
  payload: z.object({
    path: z.string(),
    sha256: z.string().min(1),
    tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

const ReviewCompleted = z.object({
  kind: z.literal("REVIEW_COMPLETED"),
  payload: z.object({
    summary: z.string(),
    model: z.string().optional(),
  }),
});

const UniverseTickerFlagged = z.object({
  kind: z.literal("UNIVERSE_TICKER_FLAGGED"),
  payload: z.object({
    assetId: AssetIdSchema,
    reason: z.string(),
  }),
});

const UniverseFlagResolved = z.object({
  kind: z.literal("UNIVERSE_FLAG_RESOLVED"),
  payload: z.object({
    assetId: AssetIdSchema,
    resolution: z.enum(["tradable", "add_frozen", "removed_to_watchlist"]),
  }),
});

const MandateDriftFlagged = z.object({
  kind: z.literal("MANDATE_DRIFT_FLAGGED"),
  payload: z.object({
    details: z.string(),
  }),
});

const MandateAdjudicated = z.object({
  kind: z.literal("MANDATE_ADJUDICATED"),
  payload: z.object({
    assetId: AssetIdSchema,
    category: z.string(),
    ruling: z.enum(["keep", "exclude", "exception"]),
    holdRuling: z
      .enum(["divest_now", "divest_by_date", "grandfather_hold_no_add"])
      .nullable()
      .default(null),
  }),
});

const PositionConverted = z.object({
  kind: z.literal("POSITION_CONVERTED"),
  payload: z.object({
    fromAssetId: AssetIdSchema,
    toAssetId: AssetIdSchema,
    toTicker: z.string(),
    qtyMicros: QtyMicros,
    reason: z.string(),
  }),
});

// ── Envelope ─────────────────────────────────────────────────────────
/**
 * Hash covers the full body envelope (id, seq, createdAt, kind, payload,
 * schemaVersion) plus prevHash in the chain input — timestamps and sequence
 * are tamper-evident.
 */
const eventBase = {
  id: EventIdSchema,
  seq: z.number().int().positive(),
  createdAt: z.string().datetime(),
  prevHash: z.string().nullable(),
  hash: z.string().min(1),
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),
};

export const LucreEvent = z.discriminatedUnion("kind", [
  Genesis.extend(eventBase),
  ConfigChanged.extend(eventBase),
  MandateSet.extend(eventBase),
  MandateChanged.extend(eventBase),
  InterviewArchived.extend(eventBase),
  RunStarted.extend(eventBase),
  RunCompleted.extend(eventBase),
  RunFailed.extend(eventBase),
  MarketSnapshotRecorded.extend(eventBase),
  EquityMarked.extend(eventBase),
  LegalMovesComputed.extend(eventBase),
  ScreenCompleted.extend(eventBase),
  BatchSubmitted.extend(eventBase),
  DecisionMade.extend(eventBase),
  DecisionRejected.extend(eventBase),
  OrderSubmitted.extend(eventBase),
  OrderPlaced.extend(eventBase),
  OrderFilled.extend(eventBase),
  OrderCanceled.extend(eventBase),
  OrderExpired.extend(eventBase),
  OrderRejected.extend(eventBase),
  CorpActionApplied.extend(eventBase),
  PositionsReconciled.extend(eventBase),
  ReconciliationDiverged.extend(eventBase),
  BrokerCorrection.extend(eventBase),
  InferenceRecorded.extend(eventBase),
  BudgetHalted.extend(eventBase),
  BudgetReset.extend(eventBase),
  RiskHalted.extend(eventBase),
  RiskResumed.extend(eventBase),
  MemoryWritten.extend(eventBase),
  ReviewCompleted.extend(eventBase),
  UniverseTickerFlagged.extend(eventBase),
  UniverseFlagResolved.extend(eventBase),
  MandateDriftFlagged.extend(eventBase),
  MandateAdjudicated.extend(eventBase),
  PositionConverted.extend(eventBase),
]);
export type LucreEvent = z.infer<typeof LucreEvent>;

/** kind + payload only — construct before hashing/seq assignment. */
export type LucreEventBody = Pick<LucreEvent, "kind" | "payload">;

export type LucreEventEnvelope = {
  id: string;
  seq: number;
  createdAt: string;
  schemaVersion: number;
  kind: LucreEvent["kind"];
  payload: LucreEvent["payload"];
};
