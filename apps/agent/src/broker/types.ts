/** Broker abstraction so SimBroker and Alpaca share the executor path. */

export interface BrokerOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  asset_id: string;
  side: "buy" | "sell";
  qty: string;
  filled_qty: string;
  type: "limit";
  limit_price: string;
  status: string;
  filled_avg_price?: string | null;
  filled_at?: string | null;
}

export interface SubmitLimitRequest {
  symbol: string;
  assetId: string;
  qty: string;
  side: "buy" | "sell";
  limit_price: string;
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  client_order_id: string;
}

export interface Broker {
  submitLimitOrder(req: SubmitLimitRequest): Promise<BrokerOrder>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}
