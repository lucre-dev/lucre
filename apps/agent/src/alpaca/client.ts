/**
 * Minimal Alpaca Trading API v2 client (paper or live).
 * No SDK — fetch only. Keys never logged.
 */

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** Default paper endpoint. */
  baseUrl?: string;
}

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  equity: string;
  buying_power: string;
  long_market_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  account_blocked: boolean;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string | null;
  filled_qty: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  extended_hours: boolean;
}

export interface AlpacaFillActivity {
  id: string;
  activity_type: "FILL";
  transaction_time: string;
  type: string;
  price: string;
  qty: string;
  side: string;
  symbol: string;
  leaves_qty: string;
  order_id: string;
  cum_qty: string;
  order_status: string;
}

export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  fractionable: boolean;
}

export class AlpacaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "AlpacaError";
  }
}

export function loadAlpacaConfigFromEnv(): AlpacaConfig {
  const keyId =
    process.env.ALPACA_PAPER_KEY_ID?.trim() ||
    process.env.APCA_API_KEY_ID?.trim();
  const secretKey =
    process.env.ALPACA_PAPER_SECRET_KEY?.trim() ||
    process.env.APCA_API_SECRET_KEY?.trim();
  if (!keyId || !secretKey) {
    throw new AlpacaError(
      "missing Alpaca keys — set ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY in ~/.tokens",
    );
  }
  const baseUrl =
    process.env.ALPACA_BASE_URL?.trim() ||
    process.env.APCA_API_BASE_URL?.trim() ||
    "https://paper-api.alpaca.markets";
  return { keyId, secretKey, baseUrl };
}

export function createAlpacaClient(config: AlpacaConfig = loadAlpacaConfigFromEnv()) {
  const base = (config.baseUrl ?? "https://paper-api.alpaca.markets").replace(
    /\/$/,
    "",
  );

  async function request<T>(
    method: string,
    path: string,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        "APCA-API-KEY-ID": config.keyId,
        "APCA-API-SECRET-KEY": config.secretKey,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AlpacaError(
        `Alpaca ${method} ${path} → ${res.status}`,
        res.status,
        text.slice(0, 500),
      );
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    baseUrl: base,

    getAccount(): Promise<AlpacaAccount> {
      return request<AlpacaAccount>("GET", "/v2/account");
    },

    getPositions(): Promise<AlpacaPosition[]> {
      return request<AlpacaPosition[]>("GET", "/v2/positions");
    },

    getOrders(opts?: {
      status?: "open" | "closed" | "all";
      limit?: number;
      nested?: boolean;
    }): Promise<AlpacaOrder[]> {
      return request<AlpacaOrder[]>("GET", "/v2/orders", {
        status: opts?.status ?? "open",
        limit: opts?.limit !== undefined ? String(opts.limit) : "50",
        nested: opts?.nested ? "true" : undefined,
      });
    },

    getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder> {
      return request<AlpacaOrder>(
        "GET",
        `/v2/orders:by_client_order_id`,
        { client_order_id: clientOrderId },
      );
    },

    getFillActivities(opts?: {
      after?: string;
      until?: string;
      pageSize?: number;
    }): Promise<AlpacaFillActivity[]> {
      return request<AlpacaFillActivity[]>("GET", "/v2/account/activities/FILL", {
        after: opts?.after,
        until: opts?.until,
        page_size: opts?.pageSize !== undefined ? String(opts.pageSize) : "100",
        direction: "desc",
      });
    },

    getAsset(symbolOrId: string): Promise<AlpacaAsset> {
      return request<AlpacaAsset>(
        "GET",
        `/v2/assets/${encodeURIComponent(symbolOrId)}`,
      );
    },

    /**
     * Submit a limit order. Market orders intentionally unsupported.
     * Always use a stable client_order_id for idempotent recovery.
     */
    async submitLimitOrder(req: {
      symbol: string;
      qty: string; // decimal string shares
      side: "buy" | "sell";
      limit_price: string;
      time_in_force?: "day" | "gtc" | "ioc" | "fok";
      client_order_id: string;
      extended_hours?: boolean;
    }): Promise<AlpacaOrder> {
      const url = new URL(`${base}/v2/orders`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "APCA-API-KEY-ID": config.keyId,
          "APCA-API-SECRET-KEY": config.secretKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbol: req.symbol,
          qty: req.qty,
          side: req.side,
          type: "limit",
          time_in_force: req.time_in_force ?? "day",
          limit_price: req.limit_price,
          client_order_id: req.client_order_id,
          extended_hours: req.extended_hours ?? false,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AlpacaError(
          `Alpaca POST /v2/orders → ${res.status}`,
          res.status,
          text.slice(0, 500),
        );
      }
      return JSON.parse(text) as AlpacaOrder;
    },

    async cancelOrder(brokerOrderId: string): Promise<void> {
      const url = new URL(`${base}/v2/orders/${encodeURIComponent(brokerOrderId)}`);
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          "APCA-API-KEY-ID": config.keyId,
          "APCA-API-SECRET-KEY": config.secretKey,
        },
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new AlpacaError(
          `Alpaca DELETE /v2/orders → ${res.status}`,
          res.status,
          text.slice(0, 500),
        );
      }
    },

    /** Latest trade price via data API (same keys). Falls back errors to caller. */
    async getLatestTrade(
      symbol: string,
      dataBaseUrl = process.env.ALPACA_DATA_URL?.trim() ||
        "https://data.alpaca.markets",
    ): Promise<{ price: number; timestamp: string }> {
      const url = new URL(
        `${dataBaseUrl.replace(/\/$/, "")}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
      );
      const res = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": config.keyId,
          "APCA-API-SECRET-KEY": config.secretKey,
          Accept: "application/json",
        },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AlpacaError(
          `Alpaca data latest trade ${symbol} → ${res.status}`,
          res.status,
          text.slice(0, 500),
        );
      }
      const json = JSON.parse(text) as { trade?: { p: number; t: string } };
      if (!json.trade?.p) throw new AlpacaError(`no trade for ${symbol}`);
      return { price: json.trade.p, timestamp: json.trade.t };
    },
  };
}

export type AlpacaClient = ReturnType<typeof createAlpacaClient>;

/** Dollars string → integer cents. */
export function dollarsToCents(dollars: string | number): number {
  const n = typeof dollars === "number" ? dollars : Number(dollars);
  if (!Number.isFinite(n)) throw new Error(`bad dollar amount: ${dollars}`);
  return Math.round(n * 100);
}

/** Share qty string → micros (1e6). */
export function qtyToMicros(qty: string | number): number {
  const n = typeof qty === "number" ? qty : Number(qty);
  if (!Number.isFinite(n)) throw new Error(`bad qty: ${qty}`);
  return Math.round(n * 1_000_000);
}

/** Price dollars → price micros (1e6). */
export function priceToMicros(price: string | number): number {
  const n = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad price: ${price}`);
  return Math.round(n * 1_000_000);
}
