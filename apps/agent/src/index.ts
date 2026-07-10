#!/usr/bin/env node
import { cmdInit } from "./commands/init.js";
import { cmdMandateImport } from "./commands/mandateImport.js";
import { cmdMandateSeedDemo } from "./commands/mandateSeedDemo.js";
import { cmdRun } from "./commands/run.js";
import { cmdStatus } from "./commands/status.js";
import { cmdSync } from "./commands/sync.js";
import { cmdVerify } from "./commands/verify.js";

function usage(): never {
  console.log(`lucre — personal autonomous trading agent

Usage:
  lucre init [--dry-run]              GENESIS from Alpaca paper cash
  lucre sync [--dry-run] [--no-seed]  orphan sweep + reconcile vs Alpaca
  lucre verify                        re-check hash chain + reduce
  lucre status                        human summary of ledger state
  lucre mandate seed-demo             install demo Lynch universe (AAPL…)
  lucre mandate import <file.json>    MANDATE_SET / CHANGED from JSON
  lucre run [--brain stub|openai|terra] [--dry-run] [--allow-buy] [--execute]
                                      one decision cycle (default brain=stub)

Env:
  ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY   (from ~/.tokens)
  OPENAI_API_KEY                                (for --brain openai|terra)
  LUCRE_DECISION_MODEL                          (default: ledger / gpt-4.1)
  LUCRE_HOME   override data dir (default ~/.lucre)
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

  // Load ~/.tokens if present (non-destructive)
  await maybeSourceTokens();

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
    case undefined:
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
  }
}

async function maybeSourceTokens(): Promise<void> {
  // Keys should already be in the environment if the user sourced ~/.tokens.
  // As a convenience, parse export lines from ~/.tokens without executing shell.
  if (process.env.ALPACA_PAPER_KEY_ID && process.env.ALPACA_PAPER_SECRET_KEY) {
    return;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const text = await readFile(join(homedir(), ".tokens"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^export\s+([A-Z0-9_]+)=(['"]?)(.*)\2\s*$/);
      if (!m) continue;
      const [, key, , val] = m;
      if (key && val && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // no tokens file — caller will error if keys required
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
