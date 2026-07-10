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

Interactive desk:
  lucre                         open the CLI
  lucre tui | chat              same

Desk slash (in TUI):
  /status /balance /profit /positions /trades
  /usage /model /help /quit

Headless:
  lucre init
  lucre decide [--execute] [--brain stub|openai|terra] [--dry-run]
  lucre sync [--dry-run] [--no-seed]
  lucre verify
  lucre status
  lucre mandate seed-demo | import <file.json>
  lucre run …                   alias of decide (legacy)

Env (~/.tokens auto-loaded):
  ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY
  AWS_BEARER_TOKEN_BEDROCK / AWS_REGION
  LUCRE_BEDROCK_MODEL           (default: Haiku profile)
  LUCRE_HOME                    (default ~/.lucre)
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
    case "decide":
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
      console.error(`unknown command: ${cmd}`);
      console.error("run `lucre` for the desk, or `lucre --help`");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
