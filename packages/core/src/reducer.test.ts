import { describe, expect, it } from "vitest";
import type { LucreEvent, LucreEventBody } from "@lucre/types";
import { dollarsToPriceMicros, sharesToMicros } from "@lucre/types";
import {
  EMPTY_STATE,
  LedgerReducerError,
  reduceEvents,
} from "./reducer.js";
import { hashEvent } from "./hash.js";
import {
  getCash,
  getDrawdownBps,
  getPosition,
  getSellableQty,
} from "./selectors.js";
import { chain, genesis, sampleEntry, sampleMandate, uuid } from "./testUtils.js";

describe("hash chain", () => {
  it("accepts a well-linked chain", () => {
    const events = chain([genesis()]);
    const state = reduceEvents(events);
    expect(state.initialized).toBe(true);
    expect(state.lastHash).toBe(events[0]!.hash);
    expect(state.lastSeq).toBe(1);
  });

  it("rejects a broken prevHash", () => {
    const events = chain([genesis(), { kind: "RUN_STARTED", payload: {
      runId: uuid(1) as never,
      slot: "mark",
      tradingDay: "2026-01-05",
    }}]);
    const broken = events.map((e, i) =>
      i === 1 ? ({ ...e, prevHash: "WRONG" } as LucreEvent) : e,
    );
    expect(() => reduceEvents(broken)).toThrow(LedgerReducerError);
    expect(() => reduceEvents(broken)).toThrow(/hash chain broken/);
  });

  it("rejects non-null prevHash on first event", () => {
    const events = chain([genesis()]);
    const broken = [{ ...events[0]!, prevHash: "bogus" } as LucreEvent];
    expect(() => reduceEvents(broken)).toThrow(/hash chain broken/);
  });

  it("rejects seq gaps", () => {
    const events = chain([genesis()]);
    const second = chain(
      [{ kind: "RISK_RESUMED", payload: { note: "x" } }],
      { startSeq: 3, startPrevHash: events[0]!.hash },
    )[0]!;
    expect(() => reduceEvents([...events, second])).toThrow(/seq gap/);
  });

  it("real hash matches hashEvent recomputation (tamper detection)", () => {
    const events = chain([genesis()]);
    const e = events[0]!;
    const recomputed = hashEvent(null, {
      id: e.id,
      seq: e.seq,
      createdAt: e.createdAt,
      schemaVersion: e.schemaVersion,
      kind: e.kind,
      payload: e.payload,
    });
    expect(recomputed).toBe(e.hash);

    // Tamper payload without rehashing
    const tampered = {
      ...e,
      payload: { ...e.payload, startingCashCents: 1 },
    } as LucreEvent;
    const expected = hashEvent(null, {
      id: tampered.id,
      seq: tampered.seq,
      createdAt: tampered.createdAt,
      schemaVersion: tampered.schemaVersion,
      kind: tampered.kind,
      payload: tampered.payload,
    });
    expect(expected).not.toBe(e.hash);
  });
});

describe("GENESIS", () => {
  it("requires GENESIS first", () => {
    const events = chain([
      { kind: "RISK_HALTED", payload: { reason: "manual" } },
    ]);
    expect(() => reduceEvents(events)).toThrow(/first event must be GENESIS/);
  });

  it("rejects double GENESIS", () => {
    const events = chain([genesis(), genesis()]);
    expect(() => reduceEvents(events)).toThrow(/GENESIS already/);
  });

  it("sets cash and risk rails", () => {
    const state = reduceEvents(
      chain([genesis({ cashCents: 50_000_00, risk: { maxOrdersPerDay: 2 } })]),
    );
    expect(getCash(state)).toBe(50_000_00);
    expect(state.risk.maxOrdersPerDay).toBe(2);
    expect(state.paper).toBe(true);
  });
});

describe("replay determinism", () => {
  it("same events → identical state twice", () => {
    const bodies: LucreEventBody[] = [
      genesis({ cashCents: 10_000_00 }),
      {
        kind: "MANDATE_SET",
        payload: {
          mandate: sampleMandate([sampleEntry(1, { ticker: "AAPL" })]),
          mandateHash: "mh1",
        },
      },
      {
        kind: "ORDER_SUBMITTED",
        payload: {
          clientOrderId: "c1",
          assetId: "asset-1",
          ticker: "AAPL",
          side: "buy",
          qtyMicros: sharesToMicros(1),
          limitPriceMicros: dollarsToPriceMicros(200),
          timeInForce: "day",
          tradingDay: "2026-01-05",
        },
      },
      {
        kind: "ORDER_PLACED",
        payload: { clientOrderId: "c1", brokerOrderId: "b1", status: "placed" },
      },
      {
        kind: "ORDER_FILLED",
        payload: {
          clientOrderId: "c1",
          fillId: "f1",
          assetId: "asset-1",
          side: "buy",
          qtyMicros: sharesToMicros(1),
          priceMicros: dollarsToPriceMicros(200),
          // 1 share * $200 = $200 = 20000 cents out
          cashDeltaCents: -20_000,
          filledAt: "2026-01-05T14:30:00.000Z",
          partial: false,
        },
      },
      {
        kind: "EQUITY_MARKED",
        payload: {
          equityCents: 10_000_00 - 20_000 + 20_000, // cash reduced, stock = 200
          cashCents: 10_000_00 - 20_000,
          longMarketValueCents: 20_000,
          tradingDay: "2026-01-05",
          asOf: "2026-01-05T21:00:00.000Z",
        },
      },
    ];
    const events = chain(bodies);
    const a = reduceEvents(events);
    const b = reduceEvents(events);

    expect(a.cashCents).toBe(b.cashCents);
    expect(a.lastHash).toBe(b.lastHash);
    expect(a.positions.get("asset-1")?.qtyMicros).toBe(sharesToMicros(1));
    expect(a.positions.get("asset-1")?.qtyMicros).toBe(
      b.positions.get("asset-1")?.qtyMicros,
    );
    // $10,000 − $200 fill = $9,800 → 980_000 cents
    expect(getCash(a)).toBe(980_000);
  });

  it("replay after partial reduce continues correctly", () => {
    const all = chain([
      genesis({ cashCents: 100_00 }),
      {
        kind: "INFERENCE_RECORDED",
        payload: {
          provider: "openai",
          model: "terra",
          inputTokens: 1000,
          outputTokens: 200,
          costCents: 1,
          purpose: "decision",
          monthKey: "2026-01",
        },
      },
    ]);
    const mid = reduceEvents(all.slice(0, 1));
    const full = reduceEvents(all);
    const resumed = reduceEvents(all.slice(1), mid);
    expect(resumed.spendByMonth.get("2026-01")).toBe(1);
    expect(resumed.lastHash).toBe(full.lastHash);
    expect(resumed.eventCount).toBe(full.eventCount);
  });
});

describe("orders & positions", () => {
  it("rejects oversell", () => {
    const events = chain([
      genesis({ cashCents: 10_000_00 }),
      {
        kind: "ORDER_SUBMITTED",
        payload: {
          clientOrderId: "s1",
          assetId: "asset-1",
          ticker: "AAPL",
          side: "sell",
          qtyMicros: sharesToMicros(1),
          limitPriceMicros: dollarsToPriceMicros(200),
          timeInForce: "day",
          tradingDay: "2026-01-05",
        },
      },
    ]);
    expect(() => reduceEvents(events)).toThrow(/oversell/);
  });

  it("tracks fill → position → sellable qty", () => {
    const events = chain([
      genesis({ cashCents: 50_000_00 }),
      {
        kind: "ORDER_SUBMITTED",
        payload: {
          clientOrderId: "b1",
          assetId: "asset-1",
          ticker: "AAPL",
          side: "buy",
          qtyMicros: sharesToMicros(10),
          limitPriceMicros: dollarsToPriceMicros(100),
          timeInForce: "day",
          tradingDay: "2026-01-05",
        },
      },
      {
        kind: "ORDER_FILLED",
        payload: {
          clientOrderId: "b1",
          fillId: "f1",
          assetId: "asset-1",
          side: "buy",
          qtyMicros: sharesToMicros(10),
          priceMicros: dollarsToPriceMicros(100),
          cashDeltaCents: -100_000, // $1000
          filledAt: "2026-01-05T15:00:00.000Z",
          partial: false,
        },
      },
    ]);
    const state = reduceEvents(events);
    expect(getPosition(state, "asset-1")?.qtyMicros).toBe(sharesToMicros(10));
    expect(getSellableQty(state, "asset-1")).toBe(sharesToMicros(10));
    expect(getCash(state)).toBe(50_000_00 - 100_000);
  });

  it("sellable qty subtracts open sells", () => {
    const events = chain([
      genesis({ cashCents: 50_000_00 }),
      {
        kind: "BROKER_CORRECTION",
        payload: {
          reason: "seed position",
          positions: [
            {
              assetId: "asset-1",
              ticker: "AAPL",
              qtyMicros: sharesToMicros(10),
              avgCostMicros: dollarsToPriceMicros(100),
            },
          ],
        },
      },
      {
        kind: "ORDER_SUBMITTED",
        payload: {
          clientOrderId: "s1",
          assetId: "asset-1",
          ticker: "AAPL",
          side: "sell",
          qtyMicros: sharesToMicros(3),
          limitPriceMicros: dollarsToPriceMicros(110),
          timeInForce: "day",
          tradingDay: "2026-01-05",
        },
      },
    ]);
    const state = reduceEvents(events);
    expect(getSellableQty(state, "asset-1")).toBe(sharesToMicros(7));
  });
});

describe("corp actions", () => {
  it("2:1 split doubles qty and halves avg cost (no phantom loss)", () => {
    const events = chain([
      genesis(),
      {
        kind: "BROKER_CORRECTION",
        payload: {
          reason: "seed",
          positions: [
            {
              assetId: "asset-1",
              ticker: "AAPL",
              qtyMicros: sharesToMicros(10),
              avgCostMicros: dollarsToPriceMicros(200),
            },
          ],
        },
      },
      {
        kind: "CORP_ACTION_APPLIED",
        payload: {
          assetId: "asset-1",
          action: "split",
          numerator: 2,
          denominator: 1,
          cashDeltaCents: 0,
          effectiveDate: "2026-01-06",
        },
      },
    ]);
    const state = reduceEvents(events);
    const pos = getPosition(state, "asset-1")!;
    expect(pos.qtyMicros).toBe(sharesToMicros(20));
    expect(pos.avgCostMicros).toBe(dollarsToPriceMicros(100));
  });
});

describe("mandate concurrency", () => {
  it("rejects MANDATE_CHANGED with stale basedOnVersion", () => {
    const m1 = sampleMandate([sampleEntry(1)]);
    const m2 = { ...sampleMandate([sampleEntry(1), sampleEntry(2)]), version: 2 };
    const events = chain([
      genesis(),
      { kind: "MANDATE_SET", payload: { mandate: m1, mandateHash: "h1" } },
      {
        kind: "MANDATE_CHANGED",
        payload: {
          mandate: m2,
          mandateHash: "h2",
          basedOnVersion: 99,
          effectiveAt: null,
        },
      },
    ]);
    expect(() => reduceEvents(events)).toThrow(/mandate concurrency/);
  });
});

describe("risk & budget halts", () => {
  it("drawdown trips risk halt on EQUITY_MARKED", () => {
    const events = chain([
      genesis({ cashCents: 10_000_00, risk: { drawdownHaltPctBps: 1000 } }),
      {
        kind: "EQUITY_MARKED",
        payload: {
          equityCents: 10_000_00,
          cashCents: 10_000_00,
          longMarketValueCents: 0,
          tradingDay: "2026-01-05",
          asOf: "2026-01-05T21:00:00.000Z",
        },
      },
      {
        kind: "EQUITY_MARKED",
        payload: {
          equityCents: 8_500_00, // −15% from peak
          cashCents: 8_500_00,
          longMarketValueCents: 0,
          tradingDay: "2026-01-06",
          asOf: "2026-01-06T21:00:00.000Z",
        },
      },
    ]);
    const state = reduceEvents(events);
    expect(state.riskHalted).toBe(true);
    expect(state.riskHaltReason).toBe("drawdown");
    expect(getDrawdownBps(state)).toBeGreaterThanOrEqual(1000);
  });

  it("spend cap trips budget halt", () => {
    const events = chain([
      genesis({ risk: { monthlySpendCapCents: 10 } }),
      {
        kind: "INFERENCE_RECORDED",
        payload: {
          provider: "openai",
          model: "terra",
          inputTokens: 1,
          outputTokens: 1,
          costCents: 10,
          purpose: "decision",
          monthKey: "2026-01",
        },
      },
    ]);
    const state = reduceEvents(events);
    expect(state.budgetHalted).toBe(true);
  });

  it("RISK_RESUMED clears halt", () => {
    const events = chain([
      genesis(),
      { kind: "RISK_HALTED", payload: { reason: "manual" } },
      { kind: "RISK_RESUMED", payload: { note: "ok" } },
    ]);
    const state = reduceEvents(events);
    expect(state.riskHalted).toBe(false);
  });
});

describe("empty initial state", () => {
  it("EMPTY_STATE has null tip", () => {
    expect(EMPTY_STATE.lastHash).toBeNull();
    expect(EMPTY_STATE.initialized).toBe(false);
  });
});
