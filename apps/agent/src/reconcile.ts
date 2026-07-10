import type { LedgerState } from "@lucre/core";
import { getOpenOrders, getPositions } from "@lucre/core";
import type { LucreEventBody } from "@lucre/types";
import {
  createAlpacaClient,
  dollarsToCents,
  qtyToMicros,
  type AlpacaClient,
  type AlpacaOrder,
  type AlpacaPosition,
} from "./alpaca/client.js";

export interface BrokerSnapshot {
  cashCents: number;
  equityCents: number;
  longMarketValueCents: number;
  positions: {
    assetId: string;
    ticker: string;
    qtyMicros: number;
    avgCostMicros: number;
  }[];
  openOrders: AlpacaOrder[];
  accountNumber: string;
  asOf: string;
}

export async function fetchBrokerSnapshot(
  client: AlpacaClient = createAlpacaClient(),
): Promise<BrokerSnapshot> {
  const [account, positions, openOrders] = await Promise.all([
    client.getAccount(),
    client.getPositions(),
    client.getOrders({ status: "open", limit: 100 }),
  ]);
  return {
    cashCents: dollarsToCents(account.cash),
    equityCents: dollarsToCents(account.equity),
    longMarketValueCents: dollarsToCents(account.long_market_value),
    positions: positions.map(mapPosition),
    openOrders,
    accountNumber: account.account_number,
    asOf: new Date().toISOString(),
  };
}

function mapPosition(p: AlpacaPosition) {
  return {
    assetId: p.asset_id,
    ticker: p.symbol,
    qtyMicros: qtyToMicros(p.qty),
    avgCostMicros: Math.round(Number(p.avg_entry_price) * 1_000_000),
  };
}

export interface DiffLine {
  kind: "cash" | "position_missing_ledger" | "position_missing_broker" | "position_qty" | "orphan_order";
  detail: string;
}

export interface ReconcileResult {
  matched: boolean;
  diffs: DiffLine[];
  snapshot: BrokerSnapshot;
  /** Events to append when seeding empty/mismatched ledger from broker truth. */
  seedEvents: LucreEventBody[];
  /** Events when clean match. */
  reconcileEvent: LucreEventBody | null;
  /** Events when diverged (halt). */
  divergeEvent: LucreEventBody | null;
}

/**
 * Compare ledger state to broker snapshot.
 * - matched → POSITIONS_RECONCILED
 * - ledger empty-ish (cash-only genesis, no positions) + broker has cash → optional seed then reconcile
 * - real divergence → RECONCILIATION_DIVERGED
 */
export function reconcile(
  state: LedgerState,
  snapshot: BrokerSnapshot,
  opts?: { autoSeed?: boolean },
): ReconcileResult {
  const autoSeed = opts?.autoSeed ?? false;
  const diffs = diffLedgerVsBroker(state, snapshot);

  if (diffs.length === 0) {
    return {
      matched: true,
      diffs,
      snapshot,
      seedEvents: [],
      reconcileEvent: {
        kind: "POSITIONS_RECONCILED",
        payload: {
          cashCents: snapshot.cashCents,
          positions: snapshot.positions.map((p) => ({
            assetId: p.assetId,
            ticker: p.ticker,
            qtyMicros: p.qtyMicros,
          })),
          asOf: snapshot.asOf,
        },
      },
      divergeEvent: null,
    };
  }

  // Auto-seed: ledger has no positions and never filled an order — adopt broker truth.
  const canSeed =
    autoSeed &&
    state.positions.size === 0 &&
    [...state.orders.values()].every((o) => o.status === "submitted" ? false : true) &&
    state.orders.size === 0;

  // Broader seed: only cash difference from genesis, no orders ever.
  const onlyCashDrift =
    autoSeed &&
    state.orders.size === 0 &&
    state.positions.size === 0 &&
    snapshot.positions.length === 0 &&
    diffs.every((d) => d.kind === "cash");

  if (canSeed || onlyCashDrift) {
    const seedEvents: LucreEventBody[] = [
      {
        kind: "BROKER_CORRECTION",
        payload: {
          reason: onlyCashDrift
            ? "seed cash from broker on first sync"
            : "seed portfolio from broker on first sync",
          cashCents: snapshot.cashCents,
          positions: snapshot.positions.map((p) => ({
            assetId: p.assetId,
            ticker: p.ticker,
            qtyMicros: p.qtyMicros,
            avgCostMicros: p.avgCostMicros,
          })),
        },
      },
      {
        kind: "POSITIONS_RECONCILED",
        payload: {
          cashCents: snapshot.cashCents,
          positions: snapshot.positions.map((p) => ({
            assetId: p.assetId,
            ticker: p.ticker,
            qtyMicros: p.qtyMicros,
          })),
          asOf: snapshot.asOf,
        },
      },
      {
        kind: "EQUITY_MARKED",
        payload: {
          equityCents: snapshot.equityCents,
          cashCents: snapshot.cashCents,
          longMarketValueCents: snapshot.longMarketValueCents,
          tradingDay: snapshot.asOf.slice(0, 10),
          asOf: snapshot.asOf,
        },
      },
    ];
    return {
      matched: true,
      diffs,
      snapshot,
      seedEvents,
      reconcileEvent: null,
      divergeEvent: null,
    };
  }

  return {
    matched: false,
    diffs,
    snapshot,
    seedEvents: [],
    reconcileEvent: null,
    divergeEvent: {
      kind: "RECONCILIATION_DIVERGED",
      payload: {
        details: diffs.map((d) => `${d.kind}: ${d.detail}`).join("; "),
        brokerCashCents: snapshot.cashCents,
        ledgerCashCents: state.cashCents,
      },
    },
  };
}

export function diffLedgerVsBroker(
  state: LedgerState,
  snapshot: BrokerSnapshot,
): DiffLine[] {
  const diffs: DiffLine[] = [];

  if (state.cashCents !== snapshot.cashCents) {
    diffs.push({
      kind: "cash",
      detail: `ledger=${state.cashCents} broker=${snapshot.cashCents}`,
    });
  }

  const brokerByAsset = new Map(snapshot.positions.map((p) => [p.assetId, p]));
  const ledgerPositions = getPositions(state);

  for (const lp of ledgerPositions) {
    const bp = brokerByAsset.get(lp.assetId);
    if (!bp) {
      diffs.push({
        kind: "position_missing_broker",
        detail: `${lp.ticker} (${lp.assetId}) qty=${lp.qtyMicros} not at broker`,
      });
      continue;
    }
    if (bp.qtyMicros !== lp.qtyMicros) {
      diffs.push({
        kind: "position_qty",
        detail: `${lp.ticker}: ledger=${lp.qtyMicros} broker=${bp.qtyMicros}`,
      });
    }
    brokerByAsset.delete(lp.assetId);
  }

  for (const bp of brokerByAsset.values()) {
    diffs.push({
      kind: "position_missing_ledger",
      detail: `${bp.ticker} (${bp.assetId}) qty=${bp.qtyMicros} not in ledger`,
    });
  }

  // Orphan check: ledger open orders must still exist at broker (by client_order_id)
  const brokerClientIds = new Set(
    snapshot.openOrders.map((o) => o.client_order_id),
  );
  for (const o of getOpenOrders(state)) {
    if (!brokerClientIds.has(o.clientOrderId) && !o.brokerOrderId) {
      // submitted but not yet placed — OK if very recent; still flag soft
      continue;
    }
    if (o.brokerOrderId && !snapshot.openOrders.some((b) => b.id === o.brokerOrderId)) {
      // might be filled/canceled — orphan sweep handles separately
      diffs.push({
        kind: "orphan_order",
        detail: `ledger open ${o.clientOrderId} not in broker open orders`,
      });
    }
  }

  return diffs;
}

/**
 * Resolve non-terminal ledger orders against broker by client_order_id.
 * Returns events to append (ORDER_PLACED / FILLED / CANCELED / etc.).
 */
export async function orphanSweep(
  state: LedgerState,
  client: AlpacaClient = createAlpacaClient(),
): Promise<{ events: LucreEventBody[]; notes: string[] }> {
  const events: LucreEventBody[] = [];
  const notes: string[] = [];
  const open = getOpenOrders(state);

  for (const o of open) {
    try {
      const broker = await client.getOrderByClientId(o.clientOrderId);
      notes.push(
        `${o.clientOrderId} → broker status=${broker.status} filled=${broker.filled_qty}`,
      );

      if (!o.brokerOrderId && broker.id) {
        events.push({
          kind: "ORDER_PLACED",
          payload: {
            clientOrderId: o.clientOrderId,
            brokerOrderId: broker.id,
            status: "placed",
          },
        });
      }

      const filledQty = qtyToMicros(broker.filled_qty || "0");
      if (filledQty > o.filledQtyMicros) {
        const delta = filledQty - o.filledQtyMicros;
        const price = broker.limit_price
          ? Number(broker.limit_price)
          : 0;
        // Prefer filled avg if present — Alpaca order may not have it; use limit as fallback
        const priceMicros = Math.round(
          (Number((broker as { filled_avg_price?: string }).filled_avg_price) ||
            price) * 1_000_000,
        );
        const dollars =
          (delta / 1_000_000) * (priceMicros / 1_000_000);
        const cashDeltaCents = Math.round(
          o.side === "buy" ? -dollars * 100 : dollars * 100,
        );
        events.push({
          kind: "ORDER_FILLED",
          payload: {
            clientOrderId: o.clientOrderId,
            fillId: `${broker.id}:sweep:${filledQty}`,
            assetId: o.assetId,
            side: o.side,
            qtyMicros: delta,
            priceMicros,
            cashDeltaCents,
            filledAt: broker.filled_at ?? new Date().toISOString(),
            partial: broker.status !== "filled",
          },
        });
      }

      if (broker.status === "canceled" || broker.status === "cancelled") {
        events.push({
          kind: "ORDER_CANCELED",
          payload: { clientOrderId: o.clientOrderId, reason: "orphan_sweep" },
        });
      } else if (broker.status === "expired") {
        events.push({
          kind: "ORDER_EXPIRED",
          payload: { clientOrderId: o.clientOrderId },
        });
      } else if (
        broker.status === "rejected" ||
        broker.status === "suspended"
      ) {
        events.push({
          kind: "ORDER_REJECTED",
          payload: {
            clientOrderId: o.clientOrderId,
            reason: broker.status,
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`${o.clientOrderId} → lookup failed: ${msg}`);
      // 404: order never reached broker
      if (msg.includes("404")) {
        events.push({
          kind: "ORDER_REJECTED",
          payload: {
            clientOrderId: o.clientOrderId,
            reason: "not found at broker during orphan sweep",
          },
        });
      }
    }
  }

  return { events, notes };
}
