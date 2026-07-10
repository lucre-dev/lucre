#!/usr/bin/env node
import { cmdInit } from "./commands/init.js";
import { cmdMandateImport } from "./commands/mandateImport.js";
import { cmdMandateSeedDemo } from "./commands/mandateSeedDemo.js";
import { cmdRun } from "./commands/run.js";
import { cmdStatus } from "./commands/status.js";
import { cmdSync } from "./commands/sync.js";
import { cmdVerify } from "./commands/verify.js";
import { loadTokenStore } from "./tokens.js";
import { startTui } from "./tui/app.js";

function usage(): never {
  console.log(`lucre — personal autonomous trading agent

Interactive (Grok-style CLI):
  lucre                         open the TUI
  lucre tui                     same
  lucre chat                    same

Headless:
  lucre init [--dry-run]              GENESIS from Alpaca paper cash
  lucre sync [--dry-run] [--no-seed]  orphan sweep + reconcile vs Alpaca
  lucre verify                        re-check hash chain + reduce
  lucre status                        human summary of ledger state
  lucre mandate seed-demo             install demo Lynch universe
  lucre mandate import <file.json>    MANDATE_SET / CHANGED from JSON
  lucre run [--brain stub|openai|terra] [--execute]
                                      one decision cycle

In the TUI:
  chat freely (Bedrock agent + tools)
  /status /sync /verify /run /bash /model /help /quit

Env (~/.tokens auto-loaded):
  ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY
  AWS_BEARER_TOKEN_BEDROCK / AWS_REGION
  LUCRE_BEDROCK_MODEL   (default us.anthropic.claude-sonnet-4-5-…)
  LUCRE_HOME            (default ~/.lucre)
`);
  process.exit(1);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  await loadTokenStore();

  // No args → interactive TUI (the product surface)
  if (cmd === undefined || cmd === "tui" || cmd === "chat" || cmd === "i") {
    const model = argValue(argv, "--model") || argValue(rest, "--model");
    await startTui({ model });
    return;
  }

  switch (cmd) {
    case "init":
      await cmdInit({
        dryRun: hasFlag(rest, "--dry-run"),
        force: hasFlag(rest, "--force"),
      });
      break;
    case "sync":
      await cmdSync({
        dryRun: hasFlag(rest, "--dry-run"),
        seed: !hasFlag(rest, "--no-seed"),
      });
      break;
    case "verify":
      await cmdVerify({});
      break;
    case "status":
      await cmdStatus({});
      break;
    case "mandate": {
      const sub = rest[0];
      if (sub === "seed-demo") {
        await cmdMandateSeedDemo({ dryRun: hasFlag(rest, "--dry-run") });
      } else if (sub === "import") {
        const file = rest[1] ?? argValue(rest, "--file");
        if (!file) {
          console.error("usage: lucre mandate import <file.json>");
          process.exitCode = 1;
          break;
        }
        await cmdMandateImport({
          file,
          dryRun: hasFlag(rest, "--dry-run"),
        });
      } else {
        console.error("usage: lucre mandate seed-demo | import <file>");
        process.exitCode = 1;
      }
      break;
    }
    case "run": {
      const brainRaw = argValue(rest, "--brain") ?? "stub";
      const brain =
        brainRaw === "openai" || brainRaw === "terra" || brainRaw === "stub"
          ? brainRaw
          : null;
      if (!brain) {
        console.error("--brain must be stub | openai | terra");
        process.exitCode = 1;
        break;
      }
      await cmdRun({
        dryRun: hasFlag(rest, "--dry-run"),
        allowBuy: hasFlag(rest, "--allow-buy"),
        execute: hasFlag(rest, "--execute"),
        brain,
      });
      break;
    }
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "--version":
    case "-V":
      console.log("lucre 0.1.0");
      break;
    default:
      // Unknown subcommand: treat as a one-shot chat prompt? Or error.
      // Prefer error with hint to open TUI.
      console.error(`unknown command: ${cmd}`);
      console.error("run `lucre` for the interactive CLI, or `lucre --help`");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
