import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import {
  getCash,
  getEquity,
  getOpenOrders,
  getPositions,
} from "@lucre/core";
import { createAlpacaClient, loadAlpacaConfigFromEnv } from "../alpaca/client.js";
import { cmdInit } from "../commands/init.js";
import { cmdMandateSeedDemo } from "../commands/mandateSeedDemo.js";
import { cmdRun } from "../commands/run.js";
import { cmdSync } from "../commands/sync.js";
import { cmdVerify } from "../commands/verify.js";
import { lucreHome } from "../paths.js";
import { fetchBrokerSnapshot } from "../reconcile.js";
import { openStore } from "../store/jsonl.js";
import type { BedrockToolSpec } from "../brain/bedrock.js";

const exec = promisify(execCb);

export interface ToolResult {
  ok: boolean;
  output: string;
}

export const TOOL_SPECS: BedrockToolSpec[] = [
  {
    toolSpec: {
      name: "bash",
      description:
        "Run a shell command on the local machine. Prefer lucre_* tools for portfolio state. Timeout 30s. Do not exfiltrate secrets.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run" },
          },
          required: ["command"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "ledger_status",
      description:
        "Read lucre ledger status: cash, equity, positions, chain, mandate, halts.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "ledger_verify",
      description: "Verify hash chain integrity and print tip.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "broker_sync",
      description:
        "Orphan-sweep + reconcile lucre ledger against Alpaca paper account.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            dry_run: { type: "boolean" },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "broker_snapshot",
      description: "Fetch live Alpaca paper cash, equity, positions.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "decision_run",
      description:
        "Run one lucre decision cycle (mark → legal moves → decide). Default brain=bedrock (Sonnet). execute=true only when owner explicitly wants an order. Same as: lucre decide",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            brain: {
              type: "string",
              description: "bedrock | stub | openai | terra — default bedrock",
            },
            execute: {
              type: "boolean",
              description: "If true, place limit orders for non-WAIT",
            },
            dry_run: { type: "boolean" },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "mandate_seed_demo",
      description:
        "Install demo invest-in-what-you-know universe if none is set yet.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "ledger_tail",
      description: "Show last N ledger events (kind, seq, createdAt).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            n: { type: "integer", description: "default 10" },
          },
          required: [],
        },
      },
    },
  },
];

export async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "bash":
        return await toolBash(String(input.command ?? ""));
      case "ledger_status":
        return toolLedgerStatus();
      case "ledger_verify":
        return toolLedgerVerify();
      case "broker_sync":
        return await toolBrokerSync(Boolean(input.dry_run));
      case "broker_snapshot":
        return await toolBrokerSnapshot();
      case "decision_run":
        return await toolDecisionRun(input);
      case "mandate_seed_demo":
        return await toolMandateSeed();
      case "ledger_tail":
        return toolLedgerTail(Number(input.n ?? 10));
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

async function toolBash(command: string): Promise<ToolResult> {
  if (!command.trim()) return { ok: false, output: "empty command" };
  // soft deny obvious secret dumps
  if (/\b~\/\.tokens\b|\bcat\s+.*\.tokens\b/i.test(command)) {
    return { ok: false, output: "refused: do not read token store via bash" };
  }
  try {
    const { stdout, stderr } = await exec(command, {
      timeout: 30_000,
      maxBuffer: 512_000,
      env: process.env,
      cwd: process.cwd(),
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ok: true, output: out.slice(0, 12_000) || "(no output)" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return { ok: false, output: out.slice(0, 12_000) };
  }
}

function toolLedgerStatus(): ToolResult {
  const store = openStore(lucreHome());
  const events = store.load();
  if (!events.length) return { ok: true, output: "empty ledger — need /init" };
  const state = store.reduce();
  const chain = store.verifyChain();
  const positions = getPositions(state);
  const open = getOpenOrders(state);
  const lines = [
    `events=${events.length} chain=${chain.ok ? "ok" : "BROKEN"} paper=${state.paper}`,
    `cash=$${(getCash(state) / 100).toFixed(2)} equity=$${(getEquity(state) / 100).toFixed(2)} peak=$${(state.peakEquityCents / 100).toFixed(2)}`,
    `riskHalted=${state.riskHalted} (${state.riskHaltReason ?? "—"}) budgetHalted=${state.budgetHalted}`,
    `mandate=${state.mandate ? `v${state.mandateVersion} ${state.mandate.entries.length} names` : "none"}`,
    `models decision=${state.decisionModel} screen=${state.screenModel}`,
    "positions:",
    ...positions.map(
      (p) =>
        `  ${p.ticker} qty=${(p.qtyMicros / 1e6).toFixed(4)} avg=$${(p.avgCostMicros / 1e6).toFixed(2)}`,
    ),
    open.length ? "open orders:" : "open orders: none",
    ...open.map(
      (o) =>
        `  ${o.side} ${o.ticker} ${(o.qtyMicros / 1e6).toFixed(4)} @ $${(o.limitPriceMicros / 1e6).toFixed(2)} [${o.status}]`,
    ),
  ];
  return { ok: true, output: lines.join("\n") };
}

function toolLedgerVerify(): ToolResult {
  const store = openStore(lucreHome());
  const v = store.verifyChain();
  if (!v.ok) return { ok: false, output: `VERIFY FAIL: ${v.error}` };
  return {
    ok: true,
    output: `VERIFY OK · ${v.count} events · tip ${(v.tip ?? "").slice(0, 16)}…`,
  };
}

async function toolBrokerSync(dryRun: boolean): Promise<ToolResult> {
  const logs: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdSync({ dryRun, seed: true });
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return { ok: true, output: logs.join("\n") || "sync done" };
}

async function toolBrokerSnapshot(): Promise<ToolResult> {
  loadAlpacaConfigFromEnv();
  const snap = await fetchBrokerSnapshot(createAlpacaClient());
  const lines = [
    `account ${snap.accountNumber}`,
    `cash $${(snap.cashCents / 100).toFixed(2)} equity $${(snap.equityCents / 100).toFixed(2)}`,
    `positions ${snap.positions.length}:`,
    ...snap.positions.map(
      (p) => `  ${p.ticker} qty=${(p.qtyMicros / 1e6).toFixed(4)}`,
    ),
    `openOrders ${snap.openOrders.length}`,
  ];
  return { ok: true, output: lines.join("\n") };
}

async function toolDecisionRun(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const brainRaw = String(input.brain ?? "bedrock");
  const brain =
    brainRaw === "openai" ||
    brainRaw === "terra" ||
    brainRaw === "stub" ||
    brainRaw === "bedrock"
      ? brainRaw
      : "bedrock";
  const logs: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdRun({
      brain,
      execute: Boolean(input.execute),
      dryRun: Boolean(input.dry_run),
      allowBuy: false,
    });
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return { ok: true, output: logs.join("\n") || "run done" };
}

async function toolMandateSeed(): Promise<ToolResult> {
  const logs: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdMandateSeedDemo({});
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return { ok: true, output: logs.join("\n") || "seed done" };
}

function toolLedgerTail(n: number): ToolResult {
  const store = openStore(lucreHome());
  const events = store.load();
  const slice = events.slice(-Math.max(1, Math.min(n, 50)));
  const lines = slice.map(
    (e) => `seq=${e.seq} ${e.kind} ${e.createdAt} ${e.hash.slice(0, 10)}…`,
  );
  return { ok: true, output: lines.join("\n") || "(no events)" };
}

/** Expose init for slash, not as free tool by default (destructive-ish). */
export async function runInit(): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdInit({});
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return logs.join("\n");
}

export async function runVerifyCmd(): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdVerify({});
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return logs.join("\n");
}
