import {
  createBedrockClient,
  textFromContent,
  toolUsesFromContent,
  type BedrockContentBlock,
  type BedrockMessage,
  DEFAULT_BEDROCK_MODEL,
} from "../brain/bedrock.js";
import { getCash, getEquity } from "@lucre/core";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";
import {
  estimateBedrockCostCents,
  recordSessionUsage,
} from "./sessionUsage.js";
import { runTool, TOOL_SPECS } from "./tools.js";

export interface AgentEvent {
  type:
    | "status"
    | "text"
    | "tool_start"
    | "tool_end"
    | "error"
    | "done"
    | "usage";
  text?: string;
  tool?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

const SYSTEM = `You are lucre — a personal autonomous trading agent CLI.
You manage a paper (or later live) Alpaca portfolio via an append-only event ledger.

Personality: calm, precise, slightly wicked about money (the name means profit). Short answers by default.
You have tools. Prefer tools over guessing portfolio state.

Invariants you must respect:
- Never invent balances; call ledger_status or broker_snapshot.
- Orders are limit-only; market orders do not exist.
- The model picks trades from a precomputed legal-moves menu (decision_run).
- Keys live in ~/.tokens — never print secrets.
- Paper until proven.

When the user chats casually, answer. When they ask about the book, use tools.
For multi-step work, call tools then summarize results cleanly.`;

export async function* runAgentTurn(
  userText: string,
  history: BedrockMessage[],
  opts?: { modelId?: string; maxRounds?: number },
): AsyncGenerator<AgentEvent> {
  const client = createBedrockClient({
    modelId: opts?.modelId || DEFAULT_BEDROCK_MODEL,
  });
  const maxRounds = opts?.maxRounds ?? 8;

  // Fresh portfolio context for the system (short)
  let portfolioHint = "ledger: unknown";
  try {
    const store = openStore(lucreHome());
    const events = store.load();
    if (events.length) {
      const s = store.reduce();
      portfolioHint = `paper=${s.paper} cash=$${(getCash(s) / 100).toFixed(0)} equity=$${(getEquity(s) / 100).toFixed(0)} events=${events.length} mandate=${s.mandateVersion || "none"}`;
    } else {
      portfolioHint = "ledger empty — suggest /init";
    }
  } catch {
    /* ignore */
  }

  const system = `${SYSTEM}\n\nCurrent portfolio snapshot: ${portfolioHint}`;

  const messages: BedrockMessage[] = [
    ...history,
    { role: "user", content: [{ text: userText }] },
  ];

  let totalIn = 0;
  let totalOut = 0;

  for (let round = 0; round < maxRounds; round++) {
    yield { type: "status", text: round === 0 ? "thinking…" : "continuing…" };

    let result;
    try {
      result = await client.converse({
        messages,
        system,
        tools: TOOL_SPECS,
        modelId: opts?.modelId,
        maxTokens: 4096,
        temperature: 0.2,
      });
    } catch (err) {
      yield {
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    totalIn += result.inputTokens;
    totalOut += result.outputTokens;
    messages.push(result.message);

    const text = textFromContent(result.message.content);
    if (text.trim()) {
      yield { type: "text", text };
    }

    const uses = toolUsesFromContent(result.message.content);
    if (uses.length === 0 || result.stopReason === "end_turn") {
      await meterInference(totalIn, totalOut, result.model);
      yield {
        type: "usage",
        inputTokens: totalIn,
        outputTokens: totalOut,
        model: result.model,
      };
      yield { type: "done" };
      history.length = 0;
      history.push(...messages);
      return;
    }

    // Execute tools
    const toolResults: BedrockContentBlock[] = [];
    for (const u of uses) {
      yield { type: "tool_start", tool: u.name, text: summarizeInput(u.input) };
      const tr = await runTool(u.name, u.input);
      yield {
        type: "tool_end",
        tool: u.name,
        ok: tr.ok,
        text: truncate(tr.output, 400),
      };
      toolResults.push({
        toolResult: {
          toolUseId: u.toolUseId,
          content: [{ text: tr.output.slice(0, 12_000) }],
          status: tr.ok ? "success" : "error",
        },
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  await meterInference(totalIn, totalOut, opts?.modelId || DEFAULT_BEDROCK_MODEL);
  yield { type: "error", text: "max tool rounds reached" };
  history.length = 0;
  history.push(...messages);
  yield { type: "done" };
}

async function meterInference(
  inputTokens: number,
  outputTokens: number,
  model: string,
): Promise<void> {
  const costCents = estimateBedrockCostCents({
    model,
    inputTokens,
    outputTokens,
  });
  recordSessionUsage({ inputTokens, outputTokens, costCents, model });

  // Persist to ledger when a book exists (feeds /usage month + budget halt)
  try {
    const store = openStore(lucreHome());
    if (!store.load().length) return;
    const monthKey = new Date().toISOString().slice(0, 7);
    await store.append({
      kind: "INFERENCE_RECORDED",
      payload: {
        provider: "bedrock",
        model,
        inputTokens,
        outputTokens,
        costCents,
        purpose: "other",
        monthKey,
      },
    });
  } catch {
    // metering must never break the chat
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
