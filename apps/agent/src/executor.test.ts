import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RISK_CONFIG } from "@lucre/types";
import { SimBroker } from "./broker/sim.js";
import { executeLimitMove } from "./executor.js";
import { openStore } from "./store/jsonl.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function seededStore() {
  const home = mkdtempSync(join(tmpdir(), "lucre-exec-"));
  dirs.push(home);
  const store = openStore(home);
  await store.append({
    kind: "GENESIS",
    payload: {
      ownerLabel: "t",
      paper: true,
      risk: DEFAULT_RISK_CONFIG,
      startingCashCents: 100_000_00,
      decisionModel: "stub",
      screenModel: "stub",
      reviewModel: "stub",
    },
  });
  return store;
}

const buyMove = {
  id: "buy:asset-aapl:2026-01-05",
  kind: "BUY" as const,
  assetId: "asset-aapl",
  ticker: "AAPL",
  maxQtyMicros: 5_000_000,
  maxNotionalCents: 100_000,
  limitPriceMicros: 200_000_000, // $200
  conviction: 5,
};

describe("executeLimitMove", () => {
  it("appends ORDER_SUBMITTED before broker fill", async () => {
    const store = await seededStore();
    const broker = new SimBroker({ autoFill: true });
    const order: string[] = [];
    broker.failSubmitOn = undefined;

    const result = await executeLimitMove({
      store,
      broker,
      move: buyMove,
      qtyMicros: 1_000_000,
      limitPriceMicros: 200_000_000,
      tradingDay: "2026-01-05",
      hooks: {
        afterOrderSubmitted: () => order.push("submitted"),
        afterBrokerPost: () => order.push("posted"),
      },
    });

    expect(order).toEqual(["submitted", "posted"]);
    expect(result.status).toBe("filled");
    const kinds = store.load().map((e) => e.kind);
    expect(kinds).toContain("ORDER_SUBMITTED");
    expect(kinds).toContain("ORDER_PLACED");
    expect(kinds).toContain("ORDER_FILLED");
    // SUBMITTED before PLACED
    expect(kinds.indexOf("ORDER_SUBMITTED")).toBeLessThan(
      kinds.indexOf("ORDER_PLACED"),
    );

    const state = store.reduce();
    expect(state.positions.get("asset-aapl")?.qtyMicros).toBe(1_000_000);
  });

  it("does not duplicate order when resuming after crash post-SUBMITTED", async () => {
    const store = await seededStore();
    const broker = new SimBroker({ autoFill: true });

    // First attempt crashes after ledger append, before we'd consider it done
    try {
      await executeLimitMove({
        store,
        broker,
        move: buyMove,
        qtyMicros: 1_000_000,
        limitPriceMicros: 200_000_000,
        tradingDay: "2026-01-05",
        hooks: {
          afterOrderSubmitted: () => {
            throw new Error("chaos kill after submit");
          },
        },
      });
    } catch {
      /* expected */
    }

    // Exactly one ORDER_SUBMITTED
    expect(
      store.load().filter((e) => e.kind === "ORDER_SUBMITTED"),
    ).toHaveLength(1);

    // Resume — must not create a second ORDER_SUBMITTED; sim is idempotent on client id
    const result = await executeLimitMove({
      store,
      broker,
      move: buyMove,
      qtyMicros: 1_000_000,
      limitPriceMicros: 200_000_000,
      tradingDay: "2026-01-05",
    });

    expect(
      store.load().filter((e) => e.kind === "ORDER_SUBMITTED"),
    ).toHaveLength(1);
    expect(result.status === "filled" || result.status === "placed" || result.status === "ambiguous").toBe(
      true,
    );
    // Sim already has the order from first submit attempt... wait, first crashed BEFORE post
    // So first call threw after submitted hook, before broker post. So broker empty.
    // Second call resumes: existing ORDER_SUBMITTED, then posts. Good.
  });

  it("never blind-retries a second broker order for same client id", async () => {
    const store = await seededStore();
    const broker = new SimBroker({ autoFill: false });
    await executeLimitMove({
      store,
      broker,
      move: buyMove,
      qtyMicros: 1_000_000,
      limitPriceMicros: 200_000_000,
      tradingDay: "2026-01-05",
    });
    await executeLimitMove({
      store,
      broker,
      move: buyMove,
      qtyMicros: 1_000_000,
      limitPriceMicros: 200_000_000,
      tradingDay: "2026-01-05",
    });
    expect(broker.all()).toHaveLength(1);
  });
});
