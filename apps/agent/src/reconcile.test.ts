import { describe, expect, it } from "vitest";
import { EMPTY_STATE, type LedgerState } from "@lucre/core";
import { DEFAULT_RISK_CONFIG } from "@lucre/types";
import { diffLedgerVsBroker, reconcile, type BrokerSnapshot } from "./reconcile.js";

function state(partial: Partial<LedgerState> = {}): LedgerState {
  return {
    ...EMPTY_STATE,
    initialized: true,
    paper: true,
    risk: DEFAULT_RISK_CONFIG,
    cashCents: 100_000_00,
    peakEquityCents: 100_000_00,
    ...partial,
  };
}

function snap(partial: Partial<BrokerSnapshot> = {}): BrokerSnapshot {
  return {
    cashCents: 100_000_00,
    equityCents: 100_000_00,
    longMarketValueCents: 0,
    positions: [],
    openOrders: [],
    accountNumber: "PA_TEST",
    asOf: "2026-01-05T12:00:00.000Z",
    ...partial,
  };
}

describe("reconcile", () => {
  it("matches identical cash and empty positions", () => {
    const r = reconcile(state(), snap());
    expect(r.matched).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.reconcileEvent?.kind).toBe("POSITIONS_RECONCILED");
  });

  it("detects cash drift", () => {
    const diffs = diffLedgerVsBroker(state({ cashCents: 99_000_00 }), snap());
    expect(diffs.some((d) => d.kind === "cash")).toBe(true);
  });

  it("auto-seeds cash-only drift", () => {
    const r = reconcile(state({ cashCents: 99_000_00 }), snap({ cashCents: 100_000_00 }), {
      autoSeed: true,
    });
    expect(r.matched).toBe(true);
    expect(r.seedEvents.map((e) => e.kind)).toEqual([
      "BROKER_CORRECTION",
      "POSITIONS_RECONCILED",
      "EQUITY_MARKED",
    ]);
  });

  it("diverges when positions disagree and cannot seed", () => {
    const st = state({
      positions: new Map([
        [
          "a1",
          {
            assetId: "a1",
            ticker: "AAPL",
            qtyMicros: 1_000_000,
            avgCostMicros: 200_000_000,
            openedAt: "2026-01-01T00:00:00.000Z",
            sector: null,
          },
        ],
      ]),
    });
    const r = reconcile(st, snap(), { autoSeed: true });
    expect(r.matched).toBe(false);
    expect(r.divergeEvent?.kind).toBe("RECONCILIATION_DIVERGED");
  });
});
