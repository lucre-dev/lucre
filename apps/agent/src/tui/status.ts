import { getCash, getEquity, getPositions } from "@lucre/core";
import { openStore } from "../store/jsonl.js";
import { lucreHome } from "../paths.js";
import { bold, c, dim, paint } from "./theme.js";

export interface StatusSnapshot {
  line: string;
  equity: number;
  cash: number;
  positions: number;
  chainOk: boolean;
  events: number;
  mandate: string;
  paper: boolean;
  riskHalted: boolean;
  budgetHalted: boolean;
}

export function readStatus(home = lucreHome()): StatusSnapshot {
  const store = openStore(home);
  const events = store.load();
  if (events.length === 0) {
    return {
      line: `${bold("lucre")} ${dim("·")} ${paint(c.yellow, "empty")} ${dim("— run /init")}`,
      equity: 0,
      cash: 0,
      positions: 0,
      chainOk: true,
      events: 0,
      mandate: "—",
      paper: true,
      riskHalted: false,
      budgetHalted: false,
    };
  }
  const chain = store.verifyChain();
  const state = store.reduce();
  const cash = getCash(state) / 100;
  const equity = getEquity(state) / 100;
  const positions = getPositions(state).length;
  const mandate = state.mandate
    ? `v${state.mandateVersion}·${state.mandate.entries.length}`
    : "none";
  const chainTag = chain.ok
    ? paint(c.green, "chain ok")
    : paint(c.red, "CHAIN BROKEN");
  const mode = state.paper ? paint(c.cyan, "paper") : paint(c.red, "LIVE");
  const halt =
    state.riskHalted || state.budgetHalted
      ? ` ${paint(c.red, "HALT")}`
      : "";

  const line = [
    bold("lucre"),
    dim("·"),
    mode,
    dim("·"),
    paint(c.fg, `$${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`),
    dim(`cash $${cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`),
    dim(`${positions} pos`),
    dim("·"),
    chainTag,
    dim(`· ${events.length} ev`),
    dim(`· mandate ${mandate}`),
    halt,
  ].join(" ");

  return {
    line,
    equity,
    cash,
    positions,
    chainOk: chain.ok,
    events: events.length,
    mandate,
    paper: state.paper,
    riskHalted: state.riskHalted,
    budgetHalted: state.budgetHalted,
  };
}
