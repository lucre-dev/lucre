import {
  getCash,
  getEquity,
  getMonthSpend,
  getOpenOrders,
  getPositions,
} from "@lucre/core";
import {
  DEFAULT_BEDROCK_MODEL,
  STRONG_BEDROCK_MODEL,
} from "../brain/bedrock.js";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";
import { getSessionUsage } from "./sessionUsage.js";
import { readStatus } from "./status.js";

export interface SlashResult {
  agentPrompt?: string;
  lines?: string[];
  quit?: boolean;
  model?: string;
}

/** Core desk commands only — no aliases. */
export const SLASH_COMMANDS: { name: string; desc: string }[] = [
  { name: "status", desc: "system health" },
  { name: "balance", desc: "cash & equity" },
  { name: "profit", desc: "gain or loss" },
  { name: "positions", desc: "what we hold" },
  { name: "trades", desc: "what traded" },
  { name: "usage", desc: "inference spend" },
  { name: "model", desc: "show or set the brain" },
  { name: "help", desc: "list commands" },
  { name: "quit", desc: "exit" },
];

export async function handleSlash(line: string): Promise<SlashResult> {
  const raw = line.slice(1).trim();
  if (!raw) return { lines: ["type /help"] };

  const [cmd, ...rest] = raw.split(/\s+/);
  const name = (cmd ?? "").toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
      return {
        lines: [
          "commands",
          ...SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.desc}`),
          "",
          "talk for strategy, decide, sync — the agent has tools.",
          "headless: lucre decide [--execute]",
        ],
      };

    case "status":
      return { lines: [readStatus().line] };

    case "balance":
      return { lines: [formatBalance()] };

    case "profit":
      return { lines: [formatProfit()] };

    case "positions":
      return { lines: [formatPositions()] };

    case "trades":
      return { lines: [formatTrades(Number(args) || 20)] };

    case "usage":
      return { lines: [formatUsage()] };

    case "model": {
      if (!args) {
        return {
          lines: [
            `default (desk): ${DEFAULT_BEDROCK_MODEL}`,
            `stronger:       ${STRONG_BEDROCK_MODEL}`,
            `env:            LUCRE_BEDROCK_MODEL`,
            "set:            /model <bedrock-model-id>",
          ],
        };
      }
      return { lines: [`model → ${args}`], model: args };
    }

    case "quit":
      return { quit: true };

    default:
      return { lines: [`unknown /${name} — /help`] };
  }
}

export function autocompleteSlash(partial: string): string[] {
  const p = partial.replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p)).map(
    (c) => "/" + c.name,
  );
}

function formatBalance(): string {
  const store = openStore(lucreHome());
  if (!store.load().length) return "no ledger yet";
  const state = store.reduce();
  const cash = getCash(state) / 100;
  const equity = getEquity(state) / 100;
  const peak = state.peakEquityCents / 100;
  const lmv = state.lastMark
    ? state.lastMark.longMarketValueCents / 100
    : null;
  const lines = [
    `cash     $${fmt(cash)}`,
    `equity   $${fmt(equity)}`,
    `peak     $${fmt(peak)}`,
  ];
  if (lmv !== null) lines.push(`long MV  $${fmt(lmv)}`);
  lines.push(`open     ${getOpenOrders(state).length} order(s)`);
  return lines.join("\n");
}

function formatProfit(): string {
  const store = openStore(lucreHome());
  const events = store.load();
  if (!events.length) return "no ledger yet";
  const state = store.reduce();
  let startCash = 0;
  for (const e of events) {
    if (e.kind === "GENESIS") {
      startCash = e.payload.startingCashCents / 100;
      break;
    }
  }
  const equity = getEquity(state) / 100;
  const total = equity - startCash;
  const totalPct = startCash > 0 ? (total / startCash) * 100 : 0;
  let day: number | null = null;
  let dayPct: number | null = null;
  if (state.dayStartEquityCents && state.dayStartEquityCents > 0) {
    day = equity - state.dayStartEquityCents / 100;
    dayPct = (day / (state.dayStartEquityCents / 100)) * 100;
  }
  const sign = (n: number) => (n > 0 ? "+" : "") + fmt(n);
  const lines = [
    `start    $${fmt(startCash)}`,
    `equity   $${fmt(equity)}`,
    `total    ${sign(total)}  (${sign(totalPct)}%)`,
  ];
  if (day !== null && dayPct !== null) {
    lines.push(`today    ${sign(day)}  (${sign(dayPct)}%)`);
  }
  return lines.join("\n");
}

function formatPositions(): string {
  const store = openStore(lucreHome());
  if (!store.load().length) return "no ledger yet";
  const positions = getPositions(store.reduce());
  if (!positions.length) return "no positions";
  return positions
    .map(
      (p) =>
        `${p.ticker.padEnd(6)}  qty ${(p.qtyMicros / 1e6).toFixed(4)}  avg $${(p.avgCostMicros / 1e6).toFixed(2)}`,
    )
    .join("\n");
}

function formatTrades(n: number): string {
  const store = openStore(lucreHome());
  const fills = store
    .load()
    .filter((e) => e.kind === "ORDER_FILLED")
    .slice(-n);
  if (!fills.length) return "no trades yet";
  return fills
    .map((e) => {
      if (e.kind !== "ORDER_FILLED") return "";
      const p = e.payload;
      const qty = p.qtyMicros / 1e6;
      const px = p.priceMicros / 1e6;
      const notional = Math.abs(p.cashDeltaCents) / 100;
      return `${e.createdAt.slice(0, 19)}  ${p.side.toUpperCase().padEnd(4)}  qty ${qty.toFixed(4)}  @ $${px.toFixed(2)}  ($${fmt(notional)})`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatUsage(): string {
  const store = openStore(lucreHome());
  const events = store.load();
  const monthKey = new Date().toISOString().slice(0, 7);
  let cap = 1000; // default $10
  let spent = 0;
  let halted = false;
  if (events.length) {
    const state = store.reduce();
    cap = state.risk.monthlySpendCapCents;
    spent = getMonthSpend(state, monthKey);
    halted = state.budgetHalted;
  }
  const sess = getSessionUsage();
  const remain = Math.max(0, cap - spent);
  const lines = [
    `session  ${sess.turns} turn(s)  ${sess.inputTokens}→${sess.outputTokens} tok  ~${sess.costCents}¢`,
    sess.modelLast ? `         last model ${sess.modelLast}` : null,
    `month    ${monthKey}  ${spent}¢ spent  /  ${cap}¢ cap  (${remain}¢ left)`,
    halted ? `halted   budget cap reached — analysis paused` : `halted   no`,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
