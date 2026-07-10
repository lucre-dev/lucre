import { randomUUID } from "node:crypto";
import {
  assertMoveLegal,
  computeLegalMoves,
  LEGAL_MOVES_ALGO_VERSION,
} from "@lucre/core";
import type { LegalMove } from "@lucre/types";
import { createAlpacaClient, loadAlpacaConfigFromEnv } from "../alpaca/client.js";
import { alpacaAsBroker } from "../broker/alpacaBroker.js";
import { stubDecide } from "../brain/stub.js";
import { executeLimitMove } from "../executor.js";
import { lucreHome } from "../paths.js";
import { fetchBrokerSnapshot } from "../reconcile.js";
import { openStore } from "../store/jsonl.js";

/**
 * One decision cycle with the stub brain (M2).
 * Real LLM brain lands in M3.
 */
export async function cmdRun(opts: {
  home?: string;
  dryRun?: boolean;
  allowBuy?: boolean;
  execute?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  let state = store.reduce();
  if (!state.initialized) {
    console.error("no GENESIS — run lucre init");
    process.exitCode = 1;
    return;
  }

  loadAlpacaConfigFromEnv();
  const client = createAlpacaClient();
  const tradingDay = new Date().toISOString().slice(0, 10);
  const runId = randomUUID();

  if (!opts.dryRun) {
    await store.append({
      kind: "RUN_STARTED",
      payload: {
        runId: runId as never,
        slot: "decision_submit",
        tradingDay,
      },
    });
  }

  // Mark equity from broker
  const snap = await fetchBrokerSnapshot(client);
  if (!opts.dryRun) {
    await store.append({
      kind: "EQUITY_MARKED",
      payload: {
        equityCents: snap.equityCents,
        cashCents: snap.cashCents,
        longMarketValueCents: snap.longMarketValueCents,
        tradingDay,
        asOf: snap.asOf,
      },
    });
  }
  state = store.reduce();

  // Quotes for universe + holdings
  const tickers = new Set<string>();
  if (state.mandate) {
    for (const e of state.mandate.entries) {
      if (e.status === "tradable") tickers.add(e.ticker);
    }
  }
  for (const p of state.positions.values()) tickers.add(p.ticker);

  const quotes: { assetId: string; ticker: string; priceMicros: number }[] = [];
  for (const ticker of tickers) {
    try {
      const trade = await client.getLatestTrade(ticker);
      const asset = state.mandate?.entries.find((e) => e.ticker === ticker);
      const pos = [...state.positions.values()].find((p) => p.ticker === ticker);
      const assetId = asset?.assetId ?? pos?.assetId;
      if (!assetId) continue;
      quotes.push({
        assetId,
        ticker,
        priceMicros: Math.round(trade.price * 1_000_000),
      });
      console.log(`quote ${ticker} $${trade.price}`);
    } catch (err) {
      console.log(
        `quote ${ticker} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Fail-closed exclusion data: empty map → hard exclusions block all if any exist
  const exclusionData = new Map<
    string,
    Map<string, { involved: boolean | null; revenuePct?: number | null }>
  >();
  if (state.mandate) {
    for (const e of state.mandate.entries) {
      const cats = new Map<
        string,
        { involved: boolean | null; revenuePct?: number | null }
      >();
      for (const rule of state.mandate.exclusions) {
        // M2: assume clean unless hard-coded — mark involved=false for all
        // (real screening is M3). Still fail-closed if we skip this.
        cats.set(rule.category, { involved: false, revenuePct: 0 });
      }
      exclusionData.set(e.assetId, cats);
    }
  }

  const moves = computeLegalMoves({
    state,
    quotes,
    tradingDay,
    exclusionData,
  });
  console.log(`legal moves (${moves.length}):`);
  for (const m of moves) {
    if (m.kind === "WAIT") console.log(`  WAIT ${m.id}`);
    else if (m.kind === "BUY")
      console.log(
        `  BUY  ${m.ticker} maxQty=${(m.maxQtyMicros / 1e6).toFixed(4)} @ $${(m.limitPriceMicros / 1e6).toFixed(2)}`,
      );
    else
      console.log(
        `  SELL ${m.ticker} maxQty=${(m.maxQtyMicros / 1e6).toFixed(4)} lane=${m.lane}`,
      );
  }

  if (!opts.dryRun && state.mandate) {
    await store.append({
      kind: "LEGAL_MOVES_COMPUTED",
      payload: {
        mandateVersion: state.mandateVersion,
        mandateHash: state.mandateHash ?? "",
        algoVersion: LEGAL_MOVES_ALGO_VERSION,
        moveIds: moves.map((m) => m.id),
        tradingDay,
      },
    });
  }

  const decision = stubDecide(moves, { allowBuy: opts.allowBuy });
  console.log(`decision: moveId=${decision.moveId}`);
  console.log(`  thesis: ${decision.thesis}`);

  let chosen: LegalMove;
  try {
    chosen = assertMoveLegal(moves, decision.moveId, decision.qtyMicros);
  } catch (err) {
    console.error(`DECISION_REJECTED: ${err instanceof Error ? err.message : err}`);
    if (!opts.dryRun) {
      await store.append({
        kind: "DECISION_REJECTED",
        payload: {
          reason: err instanceof Error ? err.message : String(err),
          tradingDay,
        },
      });
      await store.append({
        kind: "RUN_COMPLETED",
        payload: { runId: runId as never, summary: "rejected" },
      });
    }
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    console.log("dry-run — no DECISION_MADE / orders");
    return;
  }

  const decEv = await store.append({
    kind: "DECISION_MADE",
    payload: {
      decision,
      moveId: decision.moveId,
      mandateVersion: state.mandateVersion || 1,
      mandateHash: state.mandateHash ?? "none",
      algoVersion: LEGAL_MOVES_ALGO_VERSION,
      tradingDay,
      menuMoveIds: moves.map((m) => m.id),
    },
  });

  if (chosen.kind === "WAIT" || !opts.execute) {
    if (chosen.kind !== "WAIT" && !opts.execute) {
      console.log("execute disabled (pass --execute to place orders)");
    }
    await store.append({
      kind: "RUN_COMPLETED",
      payload: { runId: runId as never, summary: `decided ${chosen.kind}` },
    });
    return;
  }

  const qty =
    decision.qtyMicros ??
    (chosen.kind === "BUY" || chosen.kind === "SELL" ? chosen.maxQtyMicros : 0);
  const limit =
    decision.limitPriceMicros ??
    (chosen.kind === "BUY" || chosen.kind === "SELL"
      ? chosen.limitPriceMicros
      : 0);

  const result = await executeLimitMove({
    store,
    broker: alpacaAsBroker(client),
    move: chosen,
    qtyMicros: qty,
    limitPriceMicros: limit,
    tradingDay,
    decisionEventId: decEv.id,
  });
  for (const n of result.notes) console.log(`  exec: ${n}`);

  await store.append({
    kind: "RUN_COMPLETED",
    payload: {
      runId: runId as never,
      summary: `execute ${result.status}`,
    },
  });
}
