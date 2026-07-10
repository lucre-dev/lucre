import type { DecideContext } from "./types.js";

export function buildSystemPrompt(): string {
  return `You are lucre, a personal autonomous portfolio manager.

You may ONLY choose from the provided legal-moves menu by moveId.
You cannot invent tickers, sides, or sizes outside the menu.
Market orders are forbidden — all buys/sells are limit orders already constrained in the menu.

Doctrine: Peter Lynch "invest in what you know" — the universe is the owner's products.
Prefer patience (WAIT) when nothing is compelling. Do not churn.
When buying, size via qtyMicros ≤ the move's maxQtyMicros; smaller is fine.
When selling, respect the lane (exclusion/stop/risk sells should be taken).

Respond with JSON matching the schema only. thesis must be concrete (what changed, why now).
noteToFutureSelf is a short memo for tomorrow's run (≤500 chars).`;
}

export function buildUserPrompt(ctx: DecideContext): string {
  const { state, moves, quotes, tradingDay, memoryNotes } = ctx;
  const equity = state.lastMark?.equityCents ?? state.cashCents;
  const positions = [...state.positions.values()].filter((p) => p.qtyMicros > 0);

  const menu = moves.map((m) => {
    if (m.kind === "WAIT") return { id: m.id, kind: "WAIT", reason: m.reason ?? null };
    if (m.kind === "BUY")
      return {
        id: m.id,
        kind: "BUY",
        ticker: m.ticker,
        maxQtyShares: m.maxQtyMicros / 1_000_000,
        maxNotionalUsd: m.maxNotionalCents / 100,
        limitPriceUsd: m.limitPriceMicros / 1_000_000,
        conviction: m.conviction ?? null,
      };
    return {
      id: m.id,
      kind: "SELL",
      ticker: m.ticker,
      maxQtyShares: m.maxQtyMicros / 1_000_000,
      limitPriceUsd: m.limitPriceMicros / 1_000_000,
      lane: m.lane,
    };
  });

  const payload = {
    tradingDay,
    paper: state.paper,
    cashUsd: state.cashCents / 100,
    equityUsd: equity / 100,
    peakEquityUsd: state.peakEquityCents / 100,
    riskHalted: state.riskHalted,
    budgetHalted: state.budgetHalted,
    riskRails: {
      maxPositionPct: state.risk.maxPositionPctBps / 100,
      cashFloorPct: state.risk.cashFloorPctBps / 100,
      maxOrdersPerDay: state.risk.maxOrdersPerDay,
      stopLossPct: state.risk.stopLossPctBps / 100,
    },
    mandate: state.mandate
      ? {
          version: state.mandateVersion,
          universe: state.mandate.entries.map((e) => ({
            ticker: e.ticker,
            conviction: e.conviction,
            status: e.status,
            products: e.productsUsed,
            paymentRelation: e.paymentRelation,
          })),
          exclusions: state.mandate.exclusions.map((x) => ({
            category: x.category,
            mode: x.mode,
            threshold: x.revenueThresholdPct,
          })),
          strategy: state.mandate.strategy,
        }
      : null,
    positions: positions.map((p) => ({
      ticker: p.ticker,
      qtyShares: p.qtyMicros / 1_000_000,
      avgCostUsd: p.avgCostMicros / 1_000_000,
    })),
    quotes: quotes.map((q) => ({
      ticker: q.ticker,
      lastUsd: q.priceMicros / 1_000_000,
    })),
    legalMoves: menu,
    memoryNotes: (memoryNotes ?? []).slice(0, 5),
    instructions: {
      pickMoveIdFromMenu: true,
      qtyMicrosIsShareMicros: "1 share = 1000000 qtyMicros",
      defaultAction: "WAIT if unsure",
    },
  };

  return JSON.stringify(payload, null, 2);
}

/** OpenAI strict json_schema for Decision. Nullables instead of optional. */
export const DECISION_JSON_SCHEMA = {
  name: "lucre_decision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      moveId: { type: "string", description: "Must be an id from legalMoves" },
      qtyMicros: {
        type: ["integer", "null"],
        description: "Share micros; null to use default sizing",
      },
      limitPriceMicros: {
        type: ["integer", "null"],
        description: "Limit price in USD micros; null to use menu price",
      },
      confidence: {
        type: ["number", "null"],
        description: "0..1",
      },
      thesis: { type: "string", minLength: 1 },
      noteToFutureSelf: { type: ["string", "null"] },
    },
    required: [
      "moveId",
      "qtyMicros",
      "limitPriceMicros",
      "confidence",
      "thesis",
      "noteToFutureSelf",
    ],
  },
} as const;
