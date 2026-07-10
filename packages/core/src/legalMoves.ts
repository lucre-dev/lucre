import type {
  LegalMove,
  Mandate,
  MoneyCents,
  PriceMicros,
  QtyMicros,
  UniverseEntry,
} from "@lucre/types";
import {
  getCash,
  getEquity,
  getOpenOrders,
  getOrdersSubmittedToday,
  getSellableQty,
  isEntryHalted,
} from "./selectors.js";
import type { LedgerState } from "./state.js";

/** Bump when legal-move math changes — stamped on DECISION_MADE / LEGAL_MOVES_COMPUTED. */
export const LEGAL_MOVES_ALGO_VERSION = "legal-moves-v1";

export interface Quote {
  assetId: string;
  ticker: string;
  /** Mid/last in price micros for sizing. */
  priceMicros: PriceMicros;
}

export interface LegalMovesInput {
  state: LedgerState;
  /** Quotes for universe + held names. Missing quote → no BUY for that name. */
  quotes: readonly Quote[];
  tradingDay: string;
  /**
   * Hard-exclusion involvement flags from screens/filings.
   * Missing data for an active hard category → unbuyable (fail closed).
   * Map: assetId → category → { involved: boolean | null } where null = unknown.
   */
  exclusionData?: ReadonlyMap<
    string,
    ReadonlyMap<string, { involved: boolean | null; revenuePct?: number | null }>
  >;
}

/**
 * Pure menu computation. The model picks a move by id from this list —
 * it is structurally incapable of proposing off-mandate tickers/sizes/sides.
 *
 * Screens gate BUY only: every held lot always has a legal SELL.
 */
export function computeLegalMoves(input: LegalMovesInput): LegalMove[] {
  const { state, quotes, tradingDay } = input;
  const moves: LegalMove[] = [];

  // WAIT is always legal.
  moves.push({
    id: `wait:${tradingDay}`,
    kind: "WAIT",
    reason: "hold cash / no action",
  });

  const quoteByAsset = new Map(quotes.map((q) => [q.assetId, q]));
  const mandate = state.mandate;
  const equity = getEquity(state);
  const cash = getCash(state);
  const ordersToday = getOrdersSubmittedToday(state, tradingDay);
  const entryHalted = isEntryHalted(state);
  const orderSlotsLeft = Math.max(0, state.risk.maxOrdersPerDay - ordersToday);

  // ── SELLs: every held position with sellable qty ───────────────────
  for (const pos of state.positions.values()) {
    if (pos.qtyMicros <= 0) continue;
    const sellable = getSellableQty(state, pos.assetId);
    if (sellable <= 0) continue;
    const q = quoteByAsset.get(pos.assetId);
    if (!q) continue;

    const lane = sellLane(state, pos.assetId, mandate);
    moves.push({
      id: `sell:${pos.assetId}:${tradingDay}`,
      kind: "SELL",
      assetId: pos.assetId,
      ticker: pos.ticker,
      maxQtyMicros: sellable as QtyMicros,
      limitPriceMicros: q.priceMicros,
      lane,
    });
  }

  // ── BUYs: mandate universe only ────────────────────────────────────
  if (!mandate || entryHalted || orderSlotsLeft === 0 || equity <= 0) {
    return moves;
  }

  const cashFloor = Math.floor((equity * state.risk.cashFloorPctBps) / 10_000);
  const spendableCash = Math.max(0, cash - cashFloor) as MoneyCents;
  if (spendableCash <= 0) return moves;

  const maxPosNotional = Math.floor(
    (equity * state.risk.maxPositionPctBps) / 10_000,
  ) as MoneyCents;
  const maxOrderNotional = Math.floor(
    (equity * state.risk.maxSingleOrderPctBps) / 10_000,
  ) as MoneyCents;

  for (const entry of mandate.entries) {
    if (!isBuyable(entry, mandate, input.exclusionData)) continue;
    const q = quoteByAsset.get(entry.assetId);
    if (!q || q.priceMicros <= 0) continue;

    // Already held notional
    const held = state.positions.get(entry.assetId);
    const heldNotional = held
      ? Math.trunc((held.qtyMicros * q.priceMicros) / 1_000_000 / 10_000) // micros*micros → rough
      : 0;
    // More carefully: priceMicros is $/1e6, qtyMicros is shares/1e6
    // notional cents = qtyMicros * priceMicros / 1e6 / 1e4
    //   = qtyMicros * priceMicros / 1e10
    const heldNotionalCents = held
      ? (Math.trunc((held.qtyMicros * q.priceMicros) / 10_000_000_000) as MoneyCents)
      : (0 as MoneyCents);

    const roomInPosition = Math.max(0, maxPosNotional - heldNotionalCents);
    const maxNotional = Math.min(
      spendableCash,
      maxOrderNotional,
      roomInPosition,
    ) as MoneyCents;
    if (maxNotional <= 0) continue;

    // qty micros from notional cents: shares = dollars / price
    // dollars = maxNotional/100; price = priceMicros/1e6
    // shares = (maxNotional/100) / (priceMicros/1e6) = maxNotional * 1e6 / (100 * priceMicros)
    // qtyMicros = shares * 1e6 = maxNotional * 1e12 / (100 * priceMicros)
    //           = maxNotional * 1e10 / priceMicros
    const maxQtyMicros = Math.trunc(
      (maxNotional * 10_000_000_000) / q.priceMicros,
    ) as QtyMicros;
    if (maxQtyMicros <= 0) continue;

    // Sector cap (if sector known on entry)
    if (entry.sector && !sectorRoom(state, entry.sector, equity, q, maxQtyMicros)) {
      continue;
    }

    // Avoid double-counting unused heldNotional variable noise
    void heldNotional;

    moves.push({
      id: `buy:${entry.assetId}:${tradingDay}`,
      kind: "BUY",
      assetId: entry.assetId,
      ticker: entry.ticker,
      maxQtyMicros,
      maxNotionalCents: maxNotional,
      limitPriceMicros: q.priceMicros,
      conviction: entry.conviction,
    });
  }

  return moves;
}

/**
 * Validate that a decision's moveId exists in the menu and optional size ≤ max.
 */
export function assertMoveLegal(
  moves: readonly LegalMove[],
  moveId: string,
  qtyMicros?: number,
): LegalMove {
  const move = moves.find((m) => m.id === moveId);
  if (!move) {
    throw new Error(`moveId ${moveId} not in legal menu`);
  }
  if (qtyMicros !== undefined) {
    if (move.kind === "WAIT") {
      throw new Error("WAIT cannot have qty");
    }
    if (qtyMicros > move.maxQtyMicros) {
      throw new Error(
        `qty ${qtyMicros} exceeds menu max ${move.maxQtyMicros} for ${moveId}`,
      );
    }
    if (qtyMicros <= 0) {
      throw new Error("qty must be positive");
    }
  }
  return move;
}

// ── helpers ──────────────────────────────────────────────────────────

function isBuyable(
  entry: UniverseEntry,
  mandate: Mandate,
  exclusionData?: LegalMovesInput["exclusionData"],
): boolean {
  if (entry.status !== "tradable") return false;

  // Grandfather: adjudicated hold_no_add blocks new buys
  for (const a of mandate.adjudications) {
    if (
      a.assetId === entry.assetId &&
      (a.ruling === "exclude" || a.holdRuling === "grandfather_hold_no_add")
    ) {
      if (a.ruling === "exclude") return false;
      if (a.holdRuling === "grandfather_hold_no_add") return false;
    }
  }

  for (const rule of mandate.exclusions) {
    const data = exclusionData?.get(entry.assetId)?.get(rule.category);
    if (rule.mode === "hard") {
      // Fail closed: unknown or involved → unbuyable
      if (!data || data.involved === null || data.involved === true) {
        // Exception adjudication can override
        const ex = mandate.adjudications.find(
          (a) =>
            a.assetId === entry.assetId &&
            a.category === rule.category &&
            (a.ruling === "keep" || a.ruling === "exception"),
        );
        if (!ex) return false;
      }
    } else {
      // soft: threshold on revenue
      if (data?.revenuePct != null && data.revenuePct > rule.revenueThresholdPct) {
        const ex = mandate.adjudications.find(
          (a) =>
            a.assetId === entry.assetId &&
            a.category === rule.category &&
            (a.ruling === "keep" || a.ruling === "exception"),
        );
        if (!ex) return false;
      }
      // soft with unknown data: allow (unlike hard)
    }
  }

  return true;
}

function sellLane(
  state: LedgerState,
  assetId: string,
  mandate: Mandate | null,
): "discretionary" | "stop" | "exclusion" | "risk" | "corp_action" {
  if (state.riskHalted) return "risk";
  if (mandate) {
    const excluded = mandate.adjudications.some(
      (a) =>
        a.assetId === assetId &&
        (a.ruling === "exclude" ||
          a.holdRuling === "divest_now" ||
          a.holdRuling === "divest_by_date"),
    );
    if (excluded) return "exclusion";
    const entry = mandate.entries.find((e) => e.assetId === assetId);
    if (entry?.status === "flagged") return "corp_action";
  }
  return "discretionary";
}

function sectorRoom(
  state: LedgerState,
  sector: string,
  equity: MoneyCents,
  quote: Quote,
  addQtyMicros: QtyMicros,
): boolean {
  const cap = Math.floor((equity * state.risk.maxSectorPctBps) / 10_000);
  let sectorNotional = 0;
  for (const pos of state.positions.values()) {
    if (pos.sector !== sector) continue;
    // without per-pos quote we approximate with this quote only for same asset
    if (pos.assetId === quote.assetId) {
      sectorNotional += Math.trunc(
        (pos.qtyMicros * quote.priceMicros) / 10_000_000_000,
      );
    }
  }
  const addNotional = Math.trunc(
    (addQtyMicros * quote.priceMicros) / 10_000_000_000,
  );
  return sectorNotional + addNotional <= cap;
}

/** Open order count helper re-export for callers. */
export function countOpenOrders(state: LedgerState): number {
  return getOpenOrders(state).length;
}
