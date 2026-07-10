import type { MoneyCents, QtyMicros } from "@lucre/types";
import type { LedgerState, OpenOrder, Position } from "./state.js";

/** Positions with non-zero qty. */
export function getPositions(state: LedgerState): Position[] {
  return [...state.positions.values()].filter((p) => p.qtyMicros !== 0);
}

export function getPosition(state: LedgerState, assetId: string): Position | null {
  return state.positions.get(assetId) ?? null;
}

/** Open (non-terminal) orders. */
export function getOpenOrders(state: LedgerState): OpenOrder[] {
  return [...state.orders.values()].filter(
    (o) =>
      o.status === "submitted" ||
      o.status === "placed" ||
      o.status === "partially_filled",
  );
}

/** Qty already reserved by open sell orders for an asset. */
export function getOpenSellQty(state: LedgerState, assetId: string): QtyMicros {
  let reserved = 0;
  for (const o of getOpenOrders(state)) {
    if (o.assetId === assetId && o.side === "sell") {
      reserved += o.qtyMicros - o.filledQtyMicros;
    }
  }
  return reserved;
}

/** Max sellable qty = ledger position − open sells. */
export function getSellableQty(state: LedgerState, assetId: string): QtyMicros {
  const pos = state.positions.get(assetId);
  if (!pos) return 0;
  return Math.max(0, pos.qtyMicros - getOpenSellQty(state, assetId));
}

export function getCash(state: LedgerState): MoneyCents {
  return state.cashCents;
}

/** Last marked equity, or cash-only if never marked. */
export function getEquity(state: LedgerState): MoneyCents {
  if (state.lastMark) return state.lastMark.equityCents;
  return state.cashCents;
}

/**
 * Drawdown from peak in bps (positive number means underwater).
 * 0 if no peak or at/above peak.
 */
export function getDrawdownBps(state: LedgerState): number {
  const peak = state.peakEquityCents;
  if (peak <= 0) return 0;
  const equity = getEquity(state);
  if (equity >= peak) return 0;
  return Math.round(((peak - equity) / peak) * 10_000);
}

/**
 * Daily loss from day-start mark in bps (positive = loss).
 * null if no day-start mark.
 */
export function getDailyLossBps(state: LedgerState): number | null {
  const start = state.dayStartEquityCents;
  if (start === null || start <= 0) return null;
  const equity = getEquity(state);
  if (equity >= start) return 0;
  return Math.round(((start - equity) / start) * 10_000);
}

export function getMonthSpend(state: LedgerState, monthKey: string): MoneyCents {
  return state.spendByMonth.get(monthKey) ?? 0;
}

export function isAnalysisHalted(state: LedgerState): boolean {
  return state.budgetHalted || state.riskHalted;
}

/** Entries may be blocked by risk halt; stop-loss path is separate. */
export function isEntryHalted(state: LedgerState): boolean {
  return state.riskHalted || state.budgetHalted;
}

export function getOrdersSubmittedToday(state: LedgerState, tradingDay: string): number {
  return state.ordersByDay.get(tradingDay) ?? 0;
}

export function getEffectiveMandate(state: LedgerState) {
  return state.mandate;
}
