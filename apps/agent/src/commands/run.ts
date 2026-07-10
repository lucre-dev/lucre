import { randomUUID } from "node:crypto";
import {
  assertMoveLegal,
  computeLegalMoves,
  getMonthSpend,
  isAnalysisHalted,
  LEGAL_MOVES_ALGO_VERSION,
} from "@lucre/core";
import type { LegalMove } from "@lucre/types";
import { createAlpacaClient, loadAlpacaConfigFromEnv } from "../alpaca/client.js";
import {
  createBrain,
  type BrainKind,
} from "../brain/index.js";
import { alpacaAsBroker } from "../broker/alpacaBroker.js";
import { executeLimitMove } from "../executor.js";
import { lucreHome } from "../paths.js";
import { fetchBrokerSnapshot } from "../reconcile.js";
import { openStore } from "../store/jsonl.js";

/**
 * One decision cycle.
 * --brain bedrock|stub|openai|terra  (default bedrock)
 * Real LLM records INFERENCE_RECORDED and respects monthly spend cap.
 */
export async function cmdRun(opts: {
  home?: string;
  dryRun?: boolean;
  allowBuy?: boolean;
  execute?: boolean;
  brain?: BrainKind;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  let state = store.reduce();
  if (!state.initialized) {
    console.error("no GENESIS — run lucre init");
    process.exitCode = 1;
    return;
  }

  const brainKind: BrainKind = opts.brain ?? "bedrock";
  loadAlpacaConfigFromEnv();
  const client = createAlpacaClient();
  const tradingDay = new Date().toISOString().slice(0, 10);
  const monthKey = tradingDay.slice(0, 7);
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

  if (isAnalysisHalted(state) && brainKind !== "stub") {
    console.error(
      `analysis halted (risk=${state.riskHalted}/${state.riskHaltReason} budget=${state.budgetHalted}) — skipping brain`,
    );
    if (!opts.dryRun) {
      await store.append({
        kind: "RUN_COMPLETED",
        payload: { runId: runId as never, summary: "halted" },
      });
    }
    process.exitCode = 1;
    return;
  }

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

  // M3 still marks universe clean for hard exclusions (screening job later)
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

  const modelHint =
    process.env.LUCRE_BEDROCK_MODEL?.trim() ||
    (brainKind === "bedrock"
      ? "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
      : state.decisionModel || "gpt-4.1");

  console.log(`brain: ${brainKind} model=${modelHint}`);
  console.log(
    `spend ${monthKey}: ${getMonthSpend(state, monthKey)}¢ / cap ${state.risk.monthlySpendCapCents}¢`,
  );

  let brain;
  try {
    brain = createBrain(brainKind, {
      allowBuy: opts.allowBuy,
      model: brainKind === "stub" ? undefined : modelHint,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  let decision;
  let decisionMeta: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    provider: string;
    raw: string;
  } | null = null;

  try {
    const result = await brain.decide({
      tradingDay,
      state,
      moves,
      quotes,
      memoryNotes: [],
      model: modelHint,
    });
    decision = result.decision;
    decisionMeta = {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costCents: result.costCents,
      provider: result.provider,
      raw: result.raw,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`brain failed: ${msg}`);
    if (!opts.dryRun) {
      await store.append({
        kind: "DECISION_REJECTED",
        payload: { reason: `brain: ${msg}`, tradingDay },
      });
      await store.append({
        kind: "RUN_FAILED",
        payload: { runId: runId as never, error: msg },
      });
    }
    process.exitCode = 1;
    return;
  }

  console.log(`decision: moveId=${decision.moveId}`);
  console.log(`  thesis: ${decision.thesis}`);
  if (decisionMeta && decisionMeta.provider !== "stub") {
    console.log(
      `  tokens in/out ${decisionMeta.inputTokens}/${decisionMeta.outputTokens} · ~${decisionMeta.costCents}¢ · ${decisionMeta.model}`,
    );
  }

  if (!opts.dryRun && decisionMeta && decisionMeta.provider !== "stub") {
    await store.append({
      kind: "INFERENCE_RECORDED",
      payload: {
        provider: decisionMeta.provider,
        model: decisionMeta.model,
        inputTokens: decisionMeta.inputTokens,
        outputTokens: decisionMeta.outputTokens,
        costCents: decisionMeta.costCents,
        purpose: "decision",
        monthKey,
      },
    });
  }

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
          raw: decisionMeta?.raw?.slice(0, 2000),
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

  // Memory note from model
  if (decision.noteToFutureSelf) {
    await store.append({
      kind: "MEMORY_WRITTEN",
      payload: {
        path: `memory/${tradingDay}.note`,
        sha256: "inline", // full file store in later revision
        tradingDay,
      },
    });
  }

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
