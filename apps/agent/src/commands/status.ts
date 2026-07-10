import { getCash, getEquity, getOpenOrders, getPositions } from "@lucre/core";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";

export async function cmdStatus(opts: { home?: string }): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const events = store.load();

  if (events.length === 0) {
    console.log("empty ledger — run: lucre init");
    return;
  }

  const state = store.reduce();
  const chain = store.verifyChain();

  console.log(`lucre · ${store.path}`);
  console.log(`events: ${events.length} · chain: ${chain.ok ? "ok" : "BROKEN"}`);
  if (!chain.ok) console.log(`  ${chain.error}`);
  console.log(`paper: ${state.paper} · owner: ${state.ownerLabel}`);
  console.log(
    `cash: $${(getCash(state) / 100).toFixed(2)} · equity: $${(getEquity(state) / 100).toFixed(2)} · peak: $${(state.peakEquityCents / 100).toFixed(2)}`,
  );
  console.log(
    `risk halt: ${state.riskHalted ? state.riskHaltReason : "no"} · budget halt: ${state.budgetHalted}`,
  );
  console.log(
    `models: decision=${state.decisionModel} screen=${state.screenModel} review=${state.reviewModel}`,
  );
  console.log(
    `mandate: ${state.mandate ? `v${state.mandateVersion} (${state.mandate.entries.length} names)` : "none — lucre init interview TBD"}`,
  );

  const positions = getPositions(state);
  if (positions.length) {
    console.log("positions:");
    for (const p of positions) {
      console.log(
        `  ${p.ticker}  qty=${(p.qtyMicros / 1e6).toFixed(6)}  avg=$${(p.avgCostMicros / 1e6).toFixed(4)}`,
      );
    }
  } else {
    console.log("positions: (none)");
  }

  const open = getOpenOrders(state);
  if (open.length) {
    console.log("open orders:");
    for (const o of open) {
      console.log(
        `  ${o.clientOrderId} ${o.side} ${o.ticker} qty=${(o.qtyMicros / 1e6).toFixed(4)} @ $${(o.limitPriceMicros / 1e6).toFixed(2)} [${o.status}]`,
      );
    }
  }

  const last = events[events.length - 1]!;
  console.log(`tip: seq=${last.seq} ${last.kind} ${last.createdAt}`);
}
