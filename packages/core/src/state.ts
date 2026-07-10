import type {
  AssetId,
  ClientOrderId,
  Mandate,
  MoneyCents,
  OrderStatus,
  PriceMicros,
  QtyMicros,
  RiskConfig,
  Side,
  TimeInForce,
} from "@lucre/types";
import { DEFAULT_RISK_CONFIG } from "@lucre/types";

export interface Position {
  assetId: AssetId;
  ticker: string;
  qtyMicros: QtyMicros;
  /** Volume-weighted average cost in price micros. */
  avgCostMicros: PriceMicros;
  openedAt: string; // ISO — first fill
  sector: string | null;
}

export interface OpenOrder {
  clientOrderId: ClientOrderId;
  assetId: AssetId;
  ticker: string;
  side: Side;
  qtyMicros: QtyMicros;
  filledQtyMicros: QtyMicros;
  limitPriceMicros: PriceMicros;
  timeInForce: TimeInForce;
  status: OrderStatus;
  brokerOrderId: string | null;
  tradingDay: string;
  submittedAt: string;
  decisionEventId: string | null;
  moveId: string | null;
}

export interface EquityMark {
  tradingDay: string;
  equityCents: MoneyCents;
  cashCents: MoneyCents;
  longMarketValueCents: MoneyCents;
  asOf: string;
}

export interface LedgerState {
  /** False until GENESIS. */
  initialized: boolean;
  paper: boolean;
  ownerLabel: string | null;
  risk: RiskConfig;
  decisionModel: string | null;
  screenModel: string | null;
  reviewModel: string | null;

  cashCents: MoneyCents;
  positions: Map<string, Position>; // key: assetId
  orders: Map<string, OpenOrder>; // key: clientOrderId

  mandate: Mandate | null;
  mandateVersion: number;
  mandateHash: string | null;
  /** Pending mandate waiting for effectiveAt cool-off. */
  pendingMandate: { mandate: Mandate; mandateHash: string; effectiveAt: string } | null;

  /** Peak equity for drawdown halt (cents). */
  peakEquityCents: MoneyCents;
  /** Last start-of-day / mark equity for daily-loss halt. */
  dayStartEquityCents: MoneyCents | null;
  lastMark: EquityMark | null;

  riskHalted: boolean;
  riskHaltReason: string | null;
  budgetHalted: boolean;
  /** monthKey → spend cents */
  spendByMonth: Map<string, MoneyCents>;

  /** Orders submitted per tradingDay (for maxOrdersPerDay). */
  ordersByDay: Map<string, number>;

  lastDecision: {
    tradingDay: string;
    moveId: string;
    eventId: string;
  } | null;

  lastSeq: number;
  lastHash: string | null;
  eventCount: number;
}

export const EMPTY_STATE: LedgerState = {
  initialized: false,
  paper: true,
  ownerLabel: null,
  risk: DEFAULT_RISK_CONFIG,
  decisionModel: null,
  screenModel: null,
  reviewModel: null,
  cashCents: 0,
  positions: new Map(),
  orders: new Map(),
  mandate: null,
  mandateVersion: 0,
  mandateHash: null,
  pendingMandate: null,
  peakEquityCents: 0,
  dayStartEquityCents: null,
  lastMark: null,
  riskHalted: false,
  riskHaltReason: null,
  budgetHalted: false,
  spendByMonth: new Map(),
  ordersByDay: new Map(),
  lastDecision: null,
  lastSeq: 0,
  lastHash: null,
  eventCount: 0,
};

export function cloneState(s: LedgerState): LedgerState {
  return {
    ...s,
    risk: { ...s.risk },
    positions: new Map(
      [...s.positions.entries()].map(([k, v]) => [k, { ...v }]),
    ),
    orders: new Map([...s.orders.entries()].map(([k, v]) => [k, { ...v }])),
    mandate: s.mandate ? structuredClone(s.mandate) : null,
    pendingMandate: s.pendingMandate
      ? {
          mandate: structuredClone(s.pendingMandate.mandate),
          mandateHash: s.pendingMandate.mandateHash,
          effectiveAt: s.pendingMandate.effectiveAt,
        }
      : null,
    lastMark: s.lastMark ? { ...s.lastMark } : null,
    spendByMonth: new Map(s.spendByMonth),
    ordersByDay: new Map(s.ordersByDay),
    lastDecision: s.lastDecision ? { ...s.lastDecision } : null,
  };
}
