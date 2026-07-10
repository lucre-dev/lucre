import { DEFAULT_BEDROCK_MODEL, FAST_BEDROCK_MODEL } from "../brain/bedrock.js";
import { runInit, runTool, runVerifyCmd } from "./tools.js";
import { readStatus } from "./status.js";

export interface SlashResult {
  /** If set, feed this to the agent as a user message instead. */
  agentPrompt?: string;
  /** Print lines to scrollback. */
  lines?: string[];
  /** Quit TUI */
  quit?: boolean;
  /** Clear history */
  clear?: boolean;
  /** Switch model id */
  model?: string;
}

export const SLASH_COMMANDS: {
  name: string;
  desc: string;
  aliases?: string[];
}[] = [
  { name: "help", desc: "Show commands" },
  { name: "status", desc: "Portfolio + chain status" },
  { name: "sync", desc: "Reconcile with Alpaca paper" },
  { name: "verify", desc: "Verify hash chain" },
  { name: "init", desc: "GENESIS from Alpaca cash" },
  { name: "run", desc: "Stub decision cycle (add --execute to trade)" },
  { name: "mandate", desc: "seed-demo universe" },
  { name: "positions", desc: "Alias for status positions" },
  { name: "broker", desc: "Live Alpaca snapshot" },
  { name: "tail", desc: "Last ledger events" },
  { name: "bash", desc: "Run shell: /bash <cmd>" },
  { name: "model", desc: "Show or set Bedrock model" },
  { name: "clear", desc: "Clear conversation", aliases: ["new"] },
  { name: "quit", desc: "Exit", aliases: ["exit", "q"] },
];

export async function handleSlash(line: string): Promise<SlashResult> {
  const raw = line.slice(1).trim();
  if (!raw) return { lines: ["type /help"] };

  const [cmd, ...rest] = raw.split(/\s+/);
  const name = (cmd ?? "").toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "h":
    case "?":
      return {
        lines: [
          "slash commands",
          ...SLASH_COMMANDS.map(
            (c) =>
              `  /${c.name.padEnd(10)} ${c.desc}${c.aliases ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : ""}`,
          ),
          "",
          "chat freely for the agent (Bedrock + tools).",
          "tools: bash, ledger_*, broker_*, decision_run, mandate_seed_demo",
        ],
      };

    case "status":
    case "positions": {
      const st = readStatus();
      const tr = await runTool("ledger_status", {});
      return { lines: [st.line, "", tr.output] };
    }

    case "sync": {
      const tr = await runTool("broker_sync", {
        dry_run: args.includes("--dry-run"),
      });
      return { lines: [tr.output] };
    }

    case "verify": {
      const out = await runVerifyCmd();
      return { lines: [out] };
    }

    case "init": {
      const out = await runInit();
      return { lines: [out] };
    }

    case "run": {
      const execute = args.includes("--execute");
      const tr = await runTool("decision_run", {
        brain: "stub",
        execute,
        dry_run: args.includes("--dry-run"),
      });
      return { lines: [tr.output] };
    }

    case "mandate": {
      if (args === "seed-demo" || args === "" || args === "seed") {
        const tr = await runTool("mandate_seed_demo", {});
        return { lines: [tr.output] };
      }
      return { lines: ["usage: /mandate seed-demo"] };
    }

    case "broker": {
      const tr = await runTool("broker_snapshot", {});
      return { lines: [tr.output] };
    }

    case "tail": {
      const n = Number(args) || 12;
      const tr = await runTool("ledger_tail", { n });
      return { lines: [tr.output] };
    }

    case "bash":
    case "!": {
      if (!args) return { lines: ["usage: /bash <command>"] };
      const tr = await runTool("bash", { command: args });
      return { lines: [tr.ok ? tr.output : `error: ${tr.output}`] };
    }

    case "model":
    case "m": {
      if (!args) {
        return {
          lines: [
            `default: ${DEFAULT_BEDROCK_MODEL}`,
            `fast:    ${FAST_BEDROCK_MODEL}`,
            `env:     LUCRE_BEDROCK_MODEL`,
            "set:     /model us.anthropic.claude-haiku-4-5-20251001-v1:0",
          ],
        };
      }
      return {
        lines: [`model → ${args}`],
        model: args,
      };
    }

    case "clear":
    case "new":
      return { clear: true, lines: ["(session cleared)"] };

    case "quit":
    case "exit":
    case "q":
      return { quit: true };

    default:
      return {
        lines: [`unknown /${name} — /help`],
      };
  }
}

export function autocompleteSlash(partial: string): string[] {
  const p = partial.replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter(
    (c) =>
      c.name.startsWith(p) || c.aliases?.some((a) => a.startsWith(p)),
  ).map((c) => "/" + c.name);
}
