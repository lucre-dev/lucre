import { describe, expect, it } from "vitest";
import { dollarsToPriceMicros, sharesToMicros } from "@lucre/types";
import { reduceEvents } from "./reducer.js";
import {
  assertMoveLegal,
  computeLegalMoves,
  LEGAL_MOVES_ALGO_VERSION,
} from "./legalMoves.js";
import { chain, genesis, sampleEntry, sampleMandate } from "./testUtils.js";

const DAY = "2026-01-05";
const AAPL = "asset-1";
const TSLA = "asset-2";
const BUD = "asset-beer";

function baseState(opts?: {
  cashCents?: number;
  entries?: ReturnType<typeof sampleEntry>[];
  exclusions?: {
    id: string;
    category: "alcohol" | "pork" | "gambling" | "tobacco" | "weapons" | "adult" | "interest_finance" | "custom";
    mode: "hard" | "soft";
    revenueThresholdPct: number;
  }[];
}) {
  const entries = opts?.entries ?? [
    sampleEntry(1, { ticker: "AAPL", assetId: AAPL, sector: "tech" }),
    sampleEntry(2, { ticker: "TSLA", assetId: TSLA, sector: "auto" }),
  ];
  const mandate = sampleMandate(entries);
  if (opts?.exclusions) {
    mandate.exclusions = opts.exclusions.map((e) => ({
      ...e,
      customLabel: null,
      ownerDefinition: null,
      notes: null,
    }));
  }
  return reduceEvents(
    chain([
      genesis({ cashCents: opts?.cashCents ?? 100_000_00 }),
      {
        kind: "MANDATE_SET",
        payload: { mandate, mandateHash: "mhash1" },
      },
      {
        kind: "EQUITY_MARKED",
        payload: {
          equityCents: opts?.cashCents ?? 100_000_00,
          cashCents: opts?.cashCents ?? 100_000_00,
          longMarketValueCents: 0,
          tradingDay: DAY,
          asOf: "2026-01-05T14:00:00.000Z",
        },
      },
    ]),
  );
}

const quotes = [
  { assetId: AAPL, ticker: "AAPL", priceMicros: dollarsToPriceMicros(200) },
  { assetId: TSLA, ticker: "TSLA", priceMicros: dollarsToPriceMicros(250) },
  { assetId: BUD, ticker: "BUD", priceMicros: dollarsToPriceMicros(60) },
];

describe("computeLegalMoves", () => {
  it("always includes WAIT", () => {
    const moves = computeLegalMoves({
      state: baseState(),
      quotes,
      tradingDay: DAY,
    });
    expect(moves.some((m) => m.kind === "WAIT")).toBe(true);
    expect(LEGAL_MOVES_ALGO_VERSION).toMatch(/^legal-moves-/);
  });

  it("offers BUY only for mandate universe names", () => {
    const moves = computeLegalMoves({
      state: baseState(),
      quotes,
      tradingDay: DAY,
    });
    const buys = moves.filter((m) => m.kind === "BUY");
    expect(buys.map((b) => b.kind === "BUY" && b.ticker)).toEqual(
      expect.arrayContaining(["AAPL", "TSLA"]),
    );
    expect(buys.every((b) => b.kind === "BUY" && b.ticker !== "BUD")).toBe(true);
  });

  it("hard exclusion fail-closed when data missing", () => {
    const state = baseState({
      entries: [
        sampleEntry(1, { ticker: "AAPL", assetId: AAPL }),
        sampleEntry(9, { ticker: "BUD", assetId: BUD, companyName: "AB InBev" }),
      ],
      exclusions: [
        {
          id: "ex-alc",
          category: "alcohol",
          mode: "hard",
          revenueThresholdPct: 0,
        },
      ],
    });
    // AAPL screened clean; BUD missing data → fail-closed (unbuyable)
    const exclusionData = new Map([
      [AAPL, new Map([["alcohol", { involved: false as boolean | null }]])],
      // BUD intentionally omitted → unknown → unbuyable
    ]);
    const moves = computeLegalMoves({
      state,
      quotes,
      tradingDay: DAY,
      exclusionData,
    });
    const buyTickers = moves
      .filter((m) => m.kind === "BUY")
      .map((m) => (m.kind === "BUY" ? m.ticker : ""));
    expect(buyTickers).toContain("AAPL");
    expect(buyTickers).not.toContain("BUD");
  });

  it("hard exclusion blocks involved issuer", () => {
    const state = baseState({
      entries: [sampleEntry(9, { ticker: "BUD", assetId: BUD })],
      exclusions: [
        {
          id: "ex-alc",
          category: "alcohol",
          mode: "hard",
          revenueThresholdPct: 0,
        },
      ],
    });
    const exclusionData = new Map([
      [
        BUD,
        new Map([["alcohol", { involved: true as boolean | null, revenuePct: 90 }]]),
      ],
    ]);
    const moves = computeLegalMoves({
      state,
      quotes,
      tradingDay: DAY,
      exclusionData,
    });
    expect(moves.filter((m) => m.kind === "BUY")).toHaveLength(0);
  });

  it("held position always has SELL even if excluded from buys", () => {
    let state = baseState({
      entries: [sampleEntry(9, { ticker: "BUD", assetId: BUD })],
      exclusions: [
        {
          id: "ex-alc",
          category: "alcohol",
          mode: "hard",
          revenueThresholdPct: 0,
        },
      ],
    });
    // Seed a held position via broker correction
    state = reduceEvents(
      chain(
        [
          {
            kind: "BROKER_CORRECTION",
            payload: {
              reason: "pre-exclusion hold",
              positions: [
                {
                  assetId: BUD,
                  ticker: "BUD",
                  qtyMicros: sharesToMicros(5),
                  avgCostMicros: dollarsToPriceMicros(60),
                },
              ],
            },
          },
        ],
        { startSeq: state.lastSeq + 1, startPrevHash: state.lastHash },
      ),
      state,
    );

    const exclusionData = new Map([
      [BUD, new Map([["alcohol", { involved: true as boolean | null }]])],
    ]);
    const moves = computeLegalMoves({
      state,
      quotes,
      tradingDay: DAY,
      exclusionData,
    });
    expect(moves.some((m) => m.kind === "BUY")).toBe(false);
    const sell = moves.find((m) => m.kind === "SELL");
    expect(sell).toBeDefined();
    if (sell?.kind === "SELL") {
      expect(sell.assetId).toBe(BUD);
      expect(sell.maxQtyMicros).toBe(sharesToMicros(5));
    }
  });

  it("risk halt suppresses BUY but keeps SELL", () => {
    let state = baseState();
    state = reduceEvents(
      chain(
        [
          { kind: "RISK_HALTED", payload: { reason: "drawdown" } },
          {
            kind: "BROKER_CORRECTION",
            payload: {
              reason: "seed",
              positions: [
                {
                  assetId: AAPL,
                  ticker: "AAPL",
                  qtyMicros: sharesToMicros(2),
                  avgCostMicros: dollarsToPriceMicros(200),
                },
              ],
            },
          },
        ],
        { startSeq: state.lastSeq + 1, startPrevHash: state.lastHash },
      ),
      state,
    );
    const moves = computeLegalMoves({ state, quotes, tradingDay: DAY });
    expect(moves.filter((m) => m.kind === "BUY")).toHaveLength(0);
    expect(moves.some((m) => m.kind === "SELL")).toBe(true);
    expect(moves.some((m) => m.kind === "WAIT")).toBe(true);
  });

  it("respects max position sizing", () => {
    // $100k equity, 10% max position = $10k; AAPL @ $200 → max 50 shares
    const state = baseState({ cashCents: 100_000_00 });
    const moves = computeLegalMoves({ state, quotes, tradingDay: DAY });
    const aapl = moves.find((m) => m.kind === "BUY" && m.ticker === "AAPL");
    expect(aapl?.kind).toBe("BUY");
    if (aapl?.kind === "BUY") {
      expect(aapl.maxNotionalCents).toBeLessThanOrEqual(10_000_00);
      expect(aapl.maxQtyMicros).toBeLessThanOrEqual(sharesToMicros(50));
    }
  });

  it("assertMoveLegal rejects off-menu ids", () => {
    const moves = computeLegalMoves({
      state: baseState(),
      quotes,
      tradingDay: DAY,
    });
    expect(() => assertMoveLegal(moves, "buy:not-real:day")).toThrow(/not in legal menu/);
  });

  it("assertMoveLegal rejects oversized qty", () => {
    const moves = computeLegalMoves({
      state: baseState(),
      quotes,
      tradingDay: DAY,
    });
    const buy = moves.find((m) => m.kind === "BUY")!;
    expect(() =>
      assertMoveLegal(moves, buy.id, buy.kind === "BUY" ? buy.maxQtyMicros + 1 : 1),
    ).toThrow(/exceeds menu max/);
  });

  it("add_frozen names are not buyable", () => {
    const state = baseState({
      entries: [
        sampleEntry(1, {
          ticker: "AAPL",
          assetId: AAPL,
          status: "add_frozen",
        }),
      ],
    });
    const moves = computeLegalMoves({ state, quotes, tradingDay: DAY });
    expect(moves.filter((m) => m.kind === "BUY")).toHaveLength(0);
  });
});
