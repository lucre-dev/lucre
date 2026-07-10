import type { EventStore } from "./store/jsonl.js";
import type { Broker } from "./broker/types.js";
import type { LegalMove } from "@lucre/types";

export interface ExecuteBuySellArgs {
  store: EventStore;
  broker: Broker;
  move: Extract<LegalMove, { kind: "BUY" | "SELL" }>;
  qtyMicros: number;
  limitPriceMicros: number;
  tradingDay: string;
  decisionEventId?: string;
  /** Crash hooks for chaos tests */
  hooks?: {
    afterOrderSubmitted?: () => void;
    afterBrokerPost?: () => void;
  };
}

export interface ExecuteResult {
  clientOrderId: string;
  brokerOrderId: string | null;
  status: "placed" | "filled" | "rejected" | "ambiguous";
  notes: string[];
}

function microsToQtyStr(micros: number): string {
  const shares = micros / 1_000_000;
  // Alpaca accepts up to 9 decimal places for fractionals
  return shares.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function microsToPriceStr(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

/**
 * Invariant: ORDER_SUBMITTED is fsynced *before* the broker HTTP POST.
 * On ambiguity (network error after submit), GET by client_order_id — never blind-retry.
 */
export async function executeLimitMove(
  args: ExecuteBuySellArgs,
): Promise<ExecuteResult> {
  const {
    store,
    broker,
    move,
    qtyMicros,
    limitPriceMicros,
    tradingDay,
    decisionEventId,
    hooks,
  } = args;
  const notes: string[] = [];

  if (qtyMicros <= 0) throw new Error("qty must be positive");
  if (qtyMicros > move.maxQtyMicros) {
    throw new Error(
      `qty ${qtyMicros} exceeds legal max ${move.maxQtyMicros}`,
    );
  }

  const clientOrderId = `lucre-${tradingDay}-${move.id}`.replace(
    /[^a-zA-Z0-9-]/g,
    "",
  ).slice(0, 48);

  // Resume path: if already submitted in ledger, don't re-submit body —
  // jump to broker lookup.
  const state = store.reduce();
  const existing = state.orders.get(clientOrderId);

  if (!existing) {
    await store.append({
      kind: "ORDER_SUBMITTED",
      payload: {
        clientOrderId,
        assetId: move.assetId,
        ticker: move.ticker,
        side: move.kind === "BUY" ? "buy" : "sell",
        qtyMicros,
        limitPriceMicros,
        timeInForce: "day",
        decisionEventId: decisionEventId as never,
        moveId: move.id,
        tradingDay,
      },
    });
    notes.push(`ORDER_SUBMITTED ${clientOrderId}`);
    hooks?.afterOrderSubmitted?.();
  } else {
    notes.push(`resume existing ORDER_SUBMITTED ${clientOrderId}`);
  }

  // Broker POST (or recovery GET)
  let brokerOrderId: string | null = existing?.brokerOrderId ?? null;
  try {
    if (!brokerOrderId) {
      const placed = await broker.submitLimitOrder({
        symbol: move.ticker,
        assetId: move.assetId,
        qty: microsToQtyStr(qtyMicros),
        side: move.kind === "BUY" ? "buy" : "sell",
        limit_price: microsToPriceStr(limitPriceMicros),
        time_in_force: "day",
        client_order_id: clientOrderId,
      });
      brokerOrderId = placed.id;
      hooks?.afterBrokerPost?.();

      await store.append({
        kind: "ORDER_PLACED",
        payload: {
          clientOrderId,
          brokerOrderId: placed.id,
          status: "placed",
        },
      });
      notes.push(`ORDER_PLACED broker=${placed.id} status=${placed.status}`);

      // Immediate fill (paper/sim often fills instantly)
      if (
        placed.status === "filled" ||
        Number(placed.filled_qty) > 0
      ) {
        await recordFill(store, {
          clientOrderId,
          assetId: move.assetId,
          side: move.kind === "BUY" ? "buy" : "sell",
          qtyMicros: Math.round(Number(placed.filled_qty) * 1_000_000) || qtyMicros,
          priceMicros: Math.round(
            Number(placed.filled_avg_price || placed.limit_price) * 1_000_000,
          ),
          fillId: `${placed.id}:fill`,
          filledAt: placed.filled_at ?? new Date().toISOString(),
          partial: placed.status !== "filled",
        });
        notes.push("ORDER_FILLED (immediate)");
        return {
          clientOrderId,
          brokerOrderId,
          status: "filled",
          notes,
        };
      }

      return {
        clientOrderId,
        brokerOrderId,
        status: "placed",
        notes,
      };
    }

    // Already had broker id — refresh
    const remote = await broker.getOrderByClientId(clientOrderId);
    notes.push(`broker status=${remote.status}`);
    return {
      clientOrderId,
      brokerOrderId: remote.id,
      status: remote.status === "filled" ? "filled" : "placed",
      notes,
    };
  } catch (err) {
    // Ambiguity path: did the order land?
    notes.push(
      `broker error: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      const remote = await broker.getOrderByClientId(clientOrderId);
      if (!existing?.brokerOrderId) {
        await store.append({
          kind: "ORDER_PLACED",
          payload: {
            clientOrderId,
            brokerOrderId: remote.id,
            status: "placed",
          },
        });
      }
      notes.push(`recovered via GET client_order_id → ${remote.id}`);
      return {
        clientOrderId,
        brokerOrderId: remote.id,
        status: "ambiguous",
        notes,
      };
    } catch {
      await store.append({
        kind: "ORDER_REJECTED",
        payload: {
          clientOrderId,
          reason: err instanceof Error ? err.message : String(err),
        },
      });
      notes.push("ORDER_REJECTED (not found after error)");
      return {
        clientOrderId,
        brokerOrderId: null,
        status: "rejected",
        notes,
      };
    }
  }
}

async function recordFill(
  store: EventStore,
  p: {
    clientOrderId: string;
    assetId: string;
    side: "buy" | "sell";
    qtyMicros: number;
    priceMicros: number;
    fillId: string;
    filledAt: string;
    partial: boolean;
  },
): Promise<void> {
  const dollars = (p.qtyMicros / 1_000_000) * (p.priceMicros / 1_000_000);
  const cashDeltaCents = Math.round(
    p.side === "buy" ? -dollars * 100 : dollars * 100,
  );
  await store.append({
    kind: "ORDER_FILLED",
    payload: {
      clientOrderId: p.clientOrderId,
      fillId: p.fillId,
      assetId: p.assetId,
      side: p.side,
      qtyMicros: p.qtyMicros,
      priceMicros: p.priceMicros,
      cashDeltaCents,
      filledAt: p.filledAt,
      partial: p.partial,
    },
  });
}
