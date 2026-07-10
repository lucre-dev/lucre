import {
  createAlpacaClient,
  type AlpacaClient,
  type AlpacaOrder,
} from "../alpaca/client.js";
import type { Broker, BrokerOrder, SubmitLimitRequest } from "./types.js";

function mapOrder(o: AlpacaOrder): BrokerOrder {
  return {
    id: o.id,
    client_order_id: o.client_order_id,
    symbol: o.symbol,
    asset_id: o.asset_id,
    side: o.side as "buy" | "sell",
    qty: o.qty ?? "0",
    filled_qty: o.filled_qty,
    type: "limit",
    limit_price: o.limit_price ?? "0",
    status: o.status,
    filled_avg_price: (o as { filled_avg_price?: string | null }).filled_avg_price,
    filled_at: o.filled_at,
  };
}

export function alpacaAsBroker(
  client: AlpacaClient = createAlpacaClient(),
): Broker {
  return {
    async submitLimitOrder(req: SubmitLimitRequest): Promise<BrokerOrder> {
      const o = await client.submitLimitOrder({
        symbol: req.symbol,
        qty: req.qty,
        side: req.side,
        limit_price: req.limit_price,
        time_in_force: req.time_in_force,
        client_order_id: req.client_order_id,
      });
      return mapOrder(o);
    },
    async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder> {
      const o = await client.getOrderByClientId(clientOrderId);
      return mapOrder(o);
    },
    async cancelOrder(brokerOrderId: string): Promise<void> {
      await client.cancelOrder(brokerOrderId);
    },
  };
}
