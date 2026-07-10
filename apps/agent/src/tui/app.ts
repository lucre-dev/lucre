import * as readline from "node:readline";
import type { BedrockMessage } from "../brain/bedrock.js";
import {
  DEFAULT_BEDROCK_MODEL,
  STRONG_BEDROCK_MODEL,
} from "../brain/bedrock.js";
import { bedrockAuthPresent } from "../tokens.js";
import { runAgentTurn } from "./agent.js";
import {
  expandSlashPrefix,
  formatSlashHints,
  handleSlash,
  slashCompleter,
  SLASH_COMMANDS,
} from "./slash.js";
import { readStatus } from "./status.js";
import { bold, c, dim, paint } from "./theme.js";

/**
 * Minimalist interactive CLI — Grok-inspired:
 * status strip · scrollback · › prompt · slash commands (tab + live hints)
 */
export async function startTui(opts?: { model?: string }): Promise<void> {
  let modelId =
    opts?.model || process.env.LUCRE_BEDROCK_MODEL || DEFAULT_BEDROCK_MODEL;
  const history: BedrockMessage[] = [];
  let busy = false;
  let closed = false;
  /** Avoid spamming slash menu on every keystroke */
  let lastHintKey = "";

  printBanner(modelId);

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    historySize: 200,
    completer: slashCompleter,
  });

  // Live slash menu: when line starts with /, show matching commands
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.on("keypress", (_str, key) => {
      if (closed || busy || !key) return;
      // After keypress, readline updates line on next tick
      setImmediate(() => {
        if (closed || busy) return;
        const line = rl.line ?? "";
        if (!line.startsWith("/")) {
          lastHintKey = "";
          return;
        }
        const hintKey = line.split(/\s+/)[0] ?? line;
        if (hintKey === lastHintKey) return;
        lastHintKey = hintKey;
        // Clear-ish: print hints on their own line under the prompt
        process.stdout.write("\n" + formatSlashHints(hintKey) + "\n");
        rl.prompt(true);
      });
    });
  }

  const prompt = () => {
    if (closed) return;
    const st = readStatus();
    process.stdout.write("\n" + dim(st.line) + "\n");
    process.stdout.write(
      dim(
        "  " +
          SLASH_COMMANDS.map((c) => `/${c.name}`).join("  ") +
          "   · tab to complete",
      ) + "\n",
    );
    rl.setPrompt(paint(c.orange, "›") + " ");
    rl.prompt();
    lastHintKey = "";
  };

  const queue: string[] = [];

  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !closed) {
        let line = queue.shift()!;
        if (!line) continue;

        // Unique prefix expand: /ba → /balance
        if (line.startsWith("/")) {
          const expanded = expandSlashPrefix(line);
          if (expanded && expanded !== line) {
            println(dim(`→ ${expanded}`));
            line = expanded;
          } else if (line === "/") {
            line = "/help";
          } else {
            const head = line.split(/\s+/)[0] ?? line;
            const hits = slashCompleter(head)[0];
            const known = SLASH_COMMANDS.some((c) => `/${c.name}` === head);
            if (!known && hits.length > 1) {
              println(dim("ambiguous — pick one:"));
              println(formatSlashHints(head));
              continue;
            }
            if (!known && hits.length === 0) {
              println(dim(`unknown ${head} — /help`));
              continue;
            }
          }
        }

        try {
          if (line.startsWith("/")) {
            const res = await handleSlash(line);
            if (res.lines?.length) {
              for (const l of res.lines) println(l);
            }
            if (res.model) {
              modelId = res.model;
              println(dim(`using ${modelId}`));
            }
            if (res.quit) {
              println(dim("bye"));
              closed = true;
              rl.close();
              return;
            }
            if (res.agentPrompt) {
              await agentChat(res.agentPrompt, history, modelId);
            }
          } else if (!bedrockAuthPresent()) {
            println(
              paint(
                c.red,
                "no AWS Bedrock token — set AWS_BEARER_TOKEN_BEDROCK in ~/.tokens",
              ),
            );
          } else {
            await agentChat(line, history, modelId);
          }
        } catch (err) {
          println(
            paint(c.red, err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } finally {
      busy = false;
      if (!closed) prompt();
    }
  };

  prompt();

  rl.on("line", (input) => {
    queue.push(input.trim());
    void drain();
  });

  rl.on("close", () => {
    closed = true;
    process.stdout.write("\n");
    process.exit(0);
  });

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (busy) {
      println(dim("\n(interrupt noted — wait for tool to finish)"));
      return;
    }
    if (now - lastSigint < 800) {
      println(dim("\nbye"));
      rl.close();
      return;
    }
    lastSigint = now;
    println(dim("\n(press Ctrl+C again to exit)"));
    prompt();
  });
}

async function agentChat(
  text: string,
  history: BedrockMessage[],
  modelId: string,
): Promise<void> {
  println(dim(`◌ ${shortModel(modelId)}`));
  let streamedHeader = false;

  for await (const ev of runAgentTurn(text, history, { modelId })) {
    switch (ev.type) {
      case "status":
        process.stdout.write(dim(`  ${ev.text ?? ""}\r`));
        break;
      case "text":
        if (!streamedHeader) {
          process.stdout.write("\n");
          streamedHeader = true;
        }
        println(ev.text ?? "");
        break;
      case "tool_start":
        println(
          paint(c.blue, "●") +
            " " +
            bold(ev.tool ?? "tool") +
            (ev.text ? dim(`  ${ev.text}`) : ""),
        );
        break;
      case "tool_end":
        println(
          (ev.ok ? paint(c.green, "✓") : paint(c.red, "✗")) +
            dim(` ${ev.tool}`) +
            (ev.text ? dim(`  ${ev.text}`) : ""),
        );
        break;
      case "error":
        println(paint(c.red, `error: ${ev.text}`));
        break;
      case "usage":
        println(
          dim(
            `  ${ev.inputTokens ?? 0}→${ev.outputTokens ?? 0} tok · ${shortModel(ev.model ?? "")}`,
          ),
        );
        break;
      case "done":
        break;
    }
  }
}

function printBanner(modelId: string): void {
  const st = readStatus();
  println("");
  println(bold("lucre") + dim("  install a hedge fund"));
  println(dim(st.line));
  println(
    dim(
      `bedrock ${shortModel(modelId)} · type / for commands · tab completes`,
    ),
  );
  if (!bedrockAuthPresent()) {
    println(paint(c.yellow, "⚠ AWS_BEARER_TOKEN_BEDROCK not loaded"));
  }
  println("");
}

function shortModel(id: string): string {
  if (!id) return "?";
  if (id.includes("haiku")) return "haiku";
  if (id === DEFAULT_BEDROCK_MODEL || id.includes("sonnet")) return "sonnet";
  if (id === STRONG_BEDROCK_MODEL) return "sonnet";
  const parts = id.split(/[./]/);
  return parts[parts.length - 1]?.slice(0, 28) || id.slice(0, 28);
}

function println(s: string): void {
  process.stdout.write(s + "\n");
}
