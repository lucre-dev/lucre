import type {
  LucreEvent,
  MoneyCents,
  PriceMicros,
  QtyMicros,
  RiskConfig,
} from "@lucre/types";
import { cloneState, EMPTY_STATE, type LedgerState, type Position } from "./state.js";

export class LedgerReducerError extends Error {
  constructor(
    message: string,
    readonly eventId?: string,
  ) {
    super(message);
    this.name = "LedgerReducerError";
  }
}

export function reduceEvents(
  events: readonly LucreEvent[],
  initialState: LedgerState = EMPTY_STATE,
): LedgerState {
  return events.reduce((s, e) => reduce(s, e), cloneState(initialState));
}

export function reduce(state: LedgerState, event: LucreEvent): LedgerState {
  assertHashChain(state, event);
  assertSeq(state, event);

  if (!state.initialized && event.kind !== "GENESIS") {
    throw new LedgerReducerError(
      `first event must be GENESIS, got ${event.kind}`,
      event.id,
    );
  }

  const next = cloneState(state);
  next.lastHash = event.hash;
  next.lastSeq = event.seq;
  next.eventCount += 1;

  // Apply pending mandate cool-off if this event's timestamp is past effectiveAt.
  applyPendingMandate(next, event.createdAt);

  switch (event.kind) {
    case "GENESIS": {
      if (state.initialized) {
        throw new LedgerReducerError("GENESIS already applied", event.id);
      }
      const p = event.payload;
      next.initialized = true;
      next.paper = p.paper;
      next.ownerLabel = p.ownerLabel;
      next.risk = { ...p.risk };
      next.decisionModel = p.decisionModel;
      next.screenModel = p.screenModel;
      next.reviewModel = p.reviewModel;
      next.cashCents = p.startingCashCents;
      next.peakEquityCents = p.startingCashCents;
      next.dayStartEquityCents = p.startingCashCents;
      break;
    }

    case "CONFIG_CHANGED": {
      if (event.payload.risk) {
        next.risk = { ...next.risk, ...event.payload.risk } as RiskConfig;
      }
      if (event.payload.decisionModel) next.decisionModel = event.payload.decisionModel;
      if (event.payload.screenModel) next.screenModel = event.payload.screenModel;
      if (event.payload.reviewModel) next.reviewModel = event.payload.reviewModel;
      break;
    }

    case "MANDATE_SET": {
      if (next.mandate !== null) {
        throw new LedgerReducerError(
          "MANDATE_SET only valid once; use MANDATE_CHANGED",
          event.id,
        );
      }
      next.mandate = event.payload.mandate;
      next.mandateVersion = event.payload.mandate.version;
      next.mandateHash = event.payload.mandateHash;
      // Overlay mandate risk params onto operational risk rails where they apply.
      mergeMandateRisk(next);
      break;
    }

    case "MANDATE_CHANGED": {
      if (!next.mandate) {
        throw new LedgerReducerError("no mandate to change", event.id);
      }
      if (event.payload.basedOnVersion !== next.mandateVersion) {
        throw new LedgerReducerError(
          `mandate concurrency: basedOnVersion=${event.payload.basedOnVersion} but state.mandateVersion=${next.mandateVersion}`,
          event.id,
        );
      }
      const effectiveAt = event.payload.effectiveAt;
      if (effectiveAt && effectiveAt > event.createdAt) {
        // Risk-loosening cool-off: park until effectiveAt.
        next.pendingMandate = {
          mandate: event.payload.mandate,
          mandateHash: event.payload.mandateHash,
          effectiveAt,
        };
      } else {
        next.mandate = event.payload.mandate;
        next.mandateVersion = event.payload.mandate.version;
        next.mandateHash = event.payload.mandateHash;
        next.pendingMandate = null;
        mergeMandateRisk(next);
      }
      break;
    }

    case "EQUITY_MARKED": {
      const p = event.payload;
      next.lastMark = {
        tradingDay: p.tradingDay,
        equityCents: p.equityCents,
        cashCents: p.cashCents,
        longMarketValueCents: p.longMarketValueCents,
        asOf: p.asOf,
      };
      // Keep cash in sync with broker mark if provided (paper/live truth).
      next.cashCents = p.cashCents;
      if (p.equityCents > next.peakEquityCents) {
        next.peakEquityCents = p.equityCents;
      }
      // First mark of a trading day becomes day-start for daily-loss rails.
      if (
        next.dayStartEquityCents === null ||
        next.lastMark === null ||
        // after assignment lastMark is p; compare previous trading day via event
        // — if this is a new day vs stored dayStart context, reset.
        (state.lastMark && state.lastMark.tradingDay !== p.tradingDay)
      ) {
        next.dayStartEquityCents = p.equityCents;
      }
      // Auto risk halt on drawdown / daily loss (selectors pure; we set flags here).
      maybeTripRiskHalts(next);
      break;
    }

    case "ORDER_SUBMITTED": {
      const p = event.payload;
      if (next.orders.has(p.clientOrderId)) {
        throw new LedgerReducerError(
          `duplicate clientOrderId ${p.clientOrderId}`,
          event.id,
        );
      }
      if (p.side === "sell") {
        const pos = next.positions.get(p.assetId);
        const openSell = openSellQty(next, p.assetId);
        const available = (pos?.qtyMicros ?? 0) - openSell;
        if (p.qtyMicros > available) {
          throw new LedgerReducerError(
            `oversell: want ${p.qtyMicros} micros, available ${available}`,
            event.id,
          );
        }
      }
      next.orders.set(p.clientOrderId, {
        clientOrderId: p.clientOrderId,
        assetId: p.assetId,
        ticker: p.ticker,
        side: p.side,
        qtyMicros: p.qtyMicros,
        filledQtyMicros: 0,
        limitPriceMicros: p.limitPriceMicros,
        timeInForce: p.timeInForce,
        status: "submitted",
        brokerOrderId: null,
        tradingDay: p.tradingDay,
        submittedAt: event.createdAt,
        decisionEventId: p.decisionEventId ?? null,
        moveId: p.moveId ?? null,
      });
      next.ordersByDay.set(
        p.tradingDay,
        (next.ordersByDay.get(p.tradingDay) ?? 0) + 1,
      );
      break;
    }

    case "ORDER_PLACED": {
      const o = requireOrder(next, event.payload.clientOrderId, event.id);
      o.status = "placed";
      o.brokerOrderId = event.payload.brokerOrderId;
      break;
    }

    case "ORDER_FILLED": {
      const p = event.payload;
      const o = requireOrder(next, p.clientOrderId, event.id);
      o.filledQtyMicros += p.qtyMicros;
      if (o.filledQtyMicros > o.qtyMicros) {
        throw new LedgerReducerError(
          `fill exceeds order qty for ${p.clientOrderId}`,
          event.id,
        );
      }
      o.status =
        o.filledQtyMicros === o.qtyMicros
          ? "filled"
          : p.partial
            ? "partially_filled"
            : "partially_filled";

      applyFill(next, {
        assetId: p.assetId,
        ticker: o.ticker,
        side: p.side,
        qtyMicros: p.qtyMicros,
        priceMicros: p.priceMicros,
        cashDeltaCents: p.cashDeltaCents,
        filledAt: p.filledAt,
      });
      break;
    }

    case "ORDER_CANCELED": {
      const o = requireOrder(next, event.payload.clientOrderId, event.id);
      o.status = "canceled";
      break;
    }

    case "ORDER_EXPIRED": {
      const o = requireOrder(next, event.payload.clientOrderId, event.id);
      o.status = "expired";
      break;
    }

    case "ORDER_REJECTED": {
      const o = requireOrder(next, event.payload.clientOrderId, event.id);
      o.status = "rejected";
      break;
    }

    case "CORP_ACTION_APPLIED": {
      const p = event.payload;
      const pos = next.positions.get(p.assetId);
      if (!pos) break;

      if (
        (p.action === "split" || p.action === "reverse_split") &&
        p.numerator &&
        p.denominator
      ) {
        // qty' = qty * num / den; cost' = cost * den / num (integer truncation).
        pos.qtyMicros = Math.trunc(
          (pos.qtyMicros * p.numerator) / p.denominator,
        ) as QtyMicros;
        pos.avgCostMicros = Math.trunc(
          (pos.avgCostMicros * p.denominator) / p.numerator,
        ) as PriceMicros;
        if (pos.qtyMicros === 0) next.positions.delete(p.assetId);
      }
      if (p.cashDeltaCents !== 0) {
        next.cashCents = (next.cashCents + p.cashDeltaCents) as MoneyCents;
      }
      break;
    }

    case "POSITIONS_RECONCILED": {
      // Confirm match — if already diverged path was taken, this is the green check.
      // We trust the ledger; reconcile event is audit that broker matched.
      // Cash may be refreshed from broker truth.
      next.cashCents = event.payload.cashCents;
      break;
    }

    case "RECONCILIATION_DIVERGED": {
      next.riskHalted = true;
      next.riskHaltReason = `reconciliation: ${event.payload.details}`;
      break;
    }

    case "BROKER_CORRECTION": {
      // The only convergence path — never edit history; append truth.
      if (event.payload.cashCents !== undefined) {
        next.cashCents = event.payload.cashCents;
      }
      if (event.payload.positions) {
        next.positions.clear();
        for (const p of event.payload.positions) {
          if (p.qtyMicros === 0) continue;
          next.positions.set(p.assetId, {
            assetId: p.assetId,
            ticker: p.ticker,
            qtyMicros: p.qtyMicros,
            avgCostMicros: p.avgCostMicros ?? (0 as PriceMicros),
            openedAt: event.createdAt,
            sector: null,
          });
        }
      }
      break;
    }

    case "DECISION_MADE": {
      next.lastDecision = {
        tradingDay: event.payload.tradingDay,
        moveId: event.payload.moveId,
        eventId: event.id,
      };
      break;
    }

    case "INFERENCE_RECORDED": {
      const { monthKey, costCents } = event.payload;
      const spent = (next.spendByMonth.get(monthKey) ?? 0) + costCents;
      next.spendByMonth.set(monthKey, spent as MoneyCents);
      if (spent >= next.risk.monthlySpendCapCents) {
        next.budgetHalted = true;
      }
      break;
    }

    case "BUDGET_HALTED": {
      next.budgetHalted = true;
      break;
    }

    case "BUDGET_RESET": {
      next.budgetHalted = false;
      next.spendByMonth.set(event.payload.monthKey, 0);
      break;
    }

    case "RISK_HALTED": {
      next.riskHalted = true;
      next.riskHaltReason = event.payload.reason;
      break;
    }

    case "RISK_RESUMED": {
      next.riskHalted = false;
      next.riskHaltReason = null;
      break;
    }

    case "POSITION_CONVERTED": {
      const p = event.payload;
      const from = next.positions.get(p.fromAssetId);
      if (!from) {
        throw new LedgerReducerError(
          `POSITION_CONVERTED unknown fromAsset ${p.fromAssetId}`,
          event.id,
        );
      }
      if (from.qtyMicros < p.qtyMicros) {
        throw new LedgerReducerError("POSITION_CONVERTED qty exceeds held", event.id);
      }
      from.qtyMicros = (from.qtyMicros - p.qtyMicros) as QtyMicros;
      if (from.qtyMicros === 0) next.positions.delete(p.fromAssetId);

      const existing = next.positions.get(p.toAssetId);
      if (existing) {
        existing.qtyMicros = (existing.qtyMicros + p.qtyMicros) as QtyMicros;
      } else {
        next.positions.set(p.toAssetId, {
          assetId: p.toAssetId,
          ticker: p.toTicker,
          qtyMicros: p.qtyMicros,
          avgCostMicros: from.avgCostMicros,
          openedAt: event.createdAt,
          sector: from.sector,
        });
      }
      // Inherited corporate-action stock should be flagged at mandate layer (M1+).
      break;
    }

    case "UNIVERSE_TICKER_FLAGGED":
    case "UNIVERSE_FLAG_RESOLVED": {
      if (!next.mandate) break;
      const assetId =
        event.kind === "UNIVERSE_TICKER_FLAGGED"
          ? event.payload.assetId
          : event.payload.assetId;
      next.mandate = {
        ...next.mandate,
        entries: next.mandate.entries.map((e) => {
          if (e.assetId !== assetId) return e;
          if (event.kind === "UNIVERSE_TICKER_FLAGGED") {
            return { ...e, status: "flagged" as const };
          }
          const res = event.payload.resolution;
          if (res === "tradable") return { ...e, status: "tradable" as const };
          if (res === "add_frozen") return { ...e, status: "add_frozen" as const };
          return e;
        }),
      };
      if (
        event.kind === "UNIVERSE_FLAG_RESOLVED" &&
        event.payload.resolution === "removed_to_watchlist" &&
        next.mandate
      ) {
        const entry = next.mandate.entries.find((e) => e.assetId === assetId);
        next.mandate = {
          ...next.mandate,
          entries: next.mandate.entries.filter((e) => e.assetId !== assetId),
          watchlist: entry
            ? [...next.mandate.watchlist, { ...entry, status: "private" as const }]
            : next.mandate.watchlist,
        };
      }
      break;
    }

    // Audit / pipeline events — advance chain only.
    case "INTERVIEW_ARCHIVED":
    case "RUN_STARTED":
    case "RUN_COMPLETED":
    case "RUN_FAILED":
    case "MARKET_SNAPSHOT_RECORDED":
    case "LEGAL_MOVES_COMPUTED":
    case "SCREEN_COMPLETED":
    case "BATCH_SUBMITTED":
    case "DECISION_REJECTED":
    case "MEMORY_WRITTEN":
    case "REVIEW_COMPLETED":
    case "MANDATE_DRIFT_FLAGGED":
    case "MANDATE_ADJUDICATED":
      break;

    default: {
      const _never: never = event;
      throw new LedgerReducerError(
        `unhandled event kind: ${JSON.stringify(_never)}`,
      );
    }
  }

  return next;
}

// ── Internals ────────────────────────────────────────────────────────

function assertHashChain(state: LedgerState, event: LucreEvent): void {
  if (event.prevHash !== state.lastHash) {
    throw new LedgerReducerError(
      `hash chain broken: event.prevHash=${event.prevHash} but state.lastHash=${state.lastHash}`,
      event.id,
    );
  }
}

function assertSeq(state: LedgerState, event: LucreEvent): void {
  const expected = state.lastSeq + 1;
  if (event.seq !== expected) {
    throw new LedgerReducerError(
      `seq gap: expected ${expected}, got ${event.seq}`,
      event.id,
    );
  }
}

function applyPendingMandate(state: LedgerState, nowIso: string): void {
  if (!state.pendingMandate) return;
  if (state.pendingMandate.effectiveAt <= nowIso) {
    state.mandate = state.pendingMandate.mandate;
    state.mandateVersion = state.pendingMandate.mandate.version;
    state.mandateHash = state.pendingMandate.mandateHash;
    state.pendingMandate = null;
    mergeMandateRisk(state);
  }
}

function mergeMandateRisk(state: LedgerState): void {
  if (!state.mandate) return;
  const r = state.mandate.risk;
  state.risk = {
    ...state.risk,
    maxPositionPctBps: r.maxPositionPctBps,
    maxSectorPctBps: r.maxSectorPctBps,
    cashFloorPctBps: r.cashFloorPctBps,
    drawdownHaltPctBps: r.drawdownHaltPctBps,
    maxSingleOrderPctBps: r.maxSingleOrderPctBps,
    minHoldDays: r.minHoldDays,
  };
}

function maybeTripRiskHalts(state: LedgerState): void {
  const equity = state.lastMark?.equityCents ?? state.cashCents;
  if (state.peakEquityCents > 0) {
    const ddBps = Math.round(
      ((state.peakEquityCents - equity) / state.peakEquityCents) * 10_000,
    );
    if (ddBps >= state.risk.drawdownHaltPctBps) {
      state.riskHalted = true;
      state.riskHaltReason = "drawdown";
    }
  }
  if (state.dayStartEquityCents && state.dayStartEquityCents > 0) {
    const lossBps = Math.round(
      ((state.dayStartEquityCents - equity) / state.dayStartEquityCents) * 10_000,
    );
    if (lossBps >= state.risk.dailyLossHaltPctBps) {
      state.riskHalted = true;
      state.riskHaltReason = state.riskHaltReason ?? "daily_loss";
    }
  }
}

function requireOrder(
  state: LedgerState,
  clientOrderId: string,
  eventId: string,
) {
  const o = state.orders.get(clientOrderId);
  if (!o) {
    throw new LedgerReducerError(`unknown order ${clientOrderId}`, eventId);
  }
  return o;
}

function openSellQty(state: LedgerState, assetId: string): number {
  let n = 0;
  for (const o of state.orders.values()) {
    if (
      o.assetId === assetId &&
      o.side === "sell" &&
      (o.status === "submitted" ||
        o.status === "placed" ||
        o.status === "partially_filled")
    ) {
      n += o.qtyMicros - o.filledQtyMicros;
    }
  }
  return n;
}

function applyFill(
  state: LedgerState,
  fill: {
    assetId: string;
    ticker: string;
    side: "buy" | "sell";
    qtyMicros: QtyMicros;
    priceMicros: PriceMicros;
    cashDeltaCents: MoneyCents;
    filledAt: string;
  },
): void {
  state.cashCents = (state.cashCents + fill.cashDeltaCents) as MoneyCents;

  const existing = state.positions.get(fill.assetId);
  if (fill.side === "buy") {
    if (!existing) {
      const pos: Position = {
        assetId: fill.assetId as Position["assetId"],
        ticker: fill.ticker,
        qtyMicros: fill.qtyMicros,
        avgCostMicros: fill.priceMicros,
        openedAt: fill.filledAt,
        sector: null,
      };
      state.positions.set(fill.assetId, pos);
    } else {
      // VWAP cost
      const totalCost =
        existing.avgCostMicros * existing.qtyMicros +
        fill.priceMicros * fill.qtyMicros;
      const newQty = existing.qtyMicros + fill.qtyMicros;
      existing.qtyMicros = newQty as QtyMicros;
      existing.avgCostMicros = Math.trunc(totalCost / newQty) as PriceMicros;
    }
  } else {
    // sell
    if (!existing || existing.qtyMicros < fill.qtyMicros) {
      throw new LedgerReducerError(
        `sell fill exceeds position for ${fill.assetId}`,
      );
    }
    existing.qtyMicros = (existing.qtyMicros - fill.qtyMicros) as QtyMicros;
    if (existing.qtyMicros === 0) {
      state.positions.delete(fill.assetId);
    }
  }
}

export { EMPTY_STATE, cloneState };
export type { LedgerState };
