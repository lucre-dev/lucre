import * as readline from "node:readline";
import type { BedrockMessage } from "../brain/bedrock.js";
import { DEFAULT_BEDROCK_MODEL, FAST_BEDROCK_MODEL } from "../brain/bedrock.js";
import { bedrockAuthPresent } from "../tokens.js";
import { runAgentTurn } from "./agent.js";
import { autocompleteSlash, handleSlash } from "./slash.js";
import { readStatus } from "./status.js";
import { bold, c, dim, paint } from "./theme.js";

/**
 * Minimalist interactive CLI — Grok-inspired:
 * status strip · scrollback stream · › prompt · slash commands · agent tools
 */
export async function startTui(opts?: { model?: string }): Promise<void> {
  let modelId = opts?.model || process.env.LUCRE_BEDROCK_MODEL || DEFAULT_BEDROCK_MODEL;
  const history: BedrockMessage[] = [];
  let busy = false;
  let closed = false;

  // Don't enter full alternate screen — stream like Claude Code / Grok chat.
  // Feels native in tmux/iTerm without fighting scrollback.
  printBanner(modelId);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    completer: (line: string) => {
      if (!line.startsWith("/")) return [[], line] as [string[], string];
      const hits = autocompleteSlash(line);
      return [hits.length ? hits : autocompleteSlash(""), line] as [
        string[],
        string,
      ];
    },
  });

  const prompt = () => {
    const st = readStatus();
    process.stdout.write("\n" + dim(st.line) + "\n");
    rl.setPrompt(paint(c.orange, "›") + " ");
    rl.prompt();
  };

  prompt();

  rl.on("line", async (input) => {
    const line = input.trim();
    if (!line) {
      prompt();
      return;
    }
    if (busy) {
      println(dim("still working — wait or Ctrl+C"));
      return;
    }

    busy = true;
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
        if (res.clear) {
          history.length = 0;
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
      } else {
        if (!bedrockAuthPresent()) {
          println(
            paint(
              c.red,
              "no AWS Bedrock token — set AWS_BEARER_TOKEN_BEDROCK in ~/.tokens",
            ),
          );
        } else {
          await agentChat(line, history, modelId);
        }
      }
    } catch (err) {
      println(paint(c.red, err instanceof Error ? err.message : String(err)));
    } finally {
      busy = false;
      if (!closed) prompt();
    }
  });

  rl.on("close", () => {
    closed = true;
    process.stdout.write("\n");
    process.exit(0);
  });

  // Ctrl+C: if busy, message; else exit on double
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
        // soft status, overwrite-ish
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
      `bedrock ${shortModel(modelId)} · /help · chat to agent · /bash for shell`,
    ),
  );
  if (!bedrockAuthPresent()) {
    println(paint(c.yellow, "⚠ AWS_BEARER_TOKEN_BEDROCK not loaded"));
  }
  println("");
}

function shortModel(id: string): string {
  if (!id) return "?";
  if (id === DEFAULT_BEDROCK_MODEL) return "sonnet-4.5";
  if (id === FAST_BEDROCK_MODEL) return "haiku-4.5";
  const parts = id.split(/[./]/);
  return parts[parts.length - 1]?.slice(0, 28) || id.slice(0, 28);
}

function println(s: string): void {
  process.stdout.write(s + "\n");
}
