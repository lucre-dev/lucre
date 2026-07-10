import type { Broker, BrokerOrder, SubmitLimitRequest } from "./types.js";

/**
 * In-process broker for chaos tests. Optional fill-on-submit and
 * crash hooks between logical steps (used by the executor tests).
 */
export class SimBroker implements Broker {
  private orders = new Map<string, BrokerOrder>();
  private seq = 0;
  /** If set, throw on the Nth submit (1-based). */
  failSubmitOn?: number;
  private submitCount = 0;
  /** Instant-fill at limit when true. */
  autoFill: boolean;

  constructor(opts?: { autoFill?: boolean }) {
    this.autoFill = opts?.autoFill ?? true;
  }

  async submitLimitOrder(req: SubmitLimitRequest): Promise<BrokerOrder> {
    this.submitCount += 1;
    if (this.failSubmitOn === this.submitCount) {
      throw new Error("sim: injected submit failure");
    }
    // Idempotent: same client_order_id returns existing
    const existing = this.orders.get(req.client_order_id);
    if (existing) return existing;

    const id = `sim-${++this.seq}`;
    const order: BrokerOrder = {
      id,
      client_order_id: req.client_order_id,
      symbol: req.symbol,
      asset_id: req.assetId,
      side: req.side,
      qty: req.qty,
      filled_qty: this.autoFill ? req.qty : "0",
      type: "limit",
      limit_price: req.limit_price,
      status: this.autoFill ? "filled" : "new",
      filled_avg_price: this.autoFill ? req.limit_price : null,
      filled_at: this.autoFill ? new Date().toISOString() : null,
    };
    this.orders.set(req.client_order_id, order);
    return order;
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder> {
    const o = this.orders.get(clientOrderId);
    if (!o) {
      const err = new Error("sim: order not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return o;
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    for (const [cid, o] of this.orders) {
      if (o.id === brokerOrderId) {
        this.orders.set(cid, { ...o, status: "canceled" });
        return;
      }
    }
  }

  /** Test helper */
  all(): BrokerOrder[] {
    return [...this.orders.values()];
  }
}
