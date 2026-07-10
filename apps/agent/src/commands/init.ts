import { DEFAULT_RISK_CONFIG } from "@lucre/types";
import {
  createAlpacaClient,
  dollarsToCents,
  loadAlpacaConfigFromEnv,
} from "../alpaca/client.js";
import { openStore } from "../store/jsonl.js";
import { lucreHome } from "../paths.js";

export async function cmdInit(opts: {
  home?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const existing = store.load();

  if (existing.length > 0 && !opts.force) {
    console.error(
      `ledger already exists at ${store.path} (${existing.length} events). pass --force to refuse (we never overwrite).`,
    );
    console.error("use: lucre status | lucre verify | lucre sync");
    process.exitCode = 1;
    return;
  }
  if (existing.length > 0 && opts.force) {
    console.error("refusing --force overwrite of an existing ledger (append-only).");
    process.exitCode = 1;
    return;
  }

  // Pull paper account so GENESIS cash matches broker from day one.
  loadAlpacaConfigFromEnv();
  const client = createAlpacaClient();
  const account = await client.getAccount();
  const cashCents = dollarsToCents(account.cash);

  const body = {
    kind: "GENESIS" as const,
    payload: {
      ownerLabel: "syedos",
      paper: true,
      risk: DEFAULT_RISK_CONFIG,
      startingCashCents: cashCents,
      decisionModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      screenModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      reviewModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    },
  };

  if (opts.dryRun) {
    console.log("dry-run GENESIS:");
    console.log(JSON.stringify(body, null, 2));
    console.log(`account ${account.account_number} cash=$${account.cash}`);
    return;
  }

  const ev = await store.append(body);
  console.log(`GENESIS seq=${ev.seq} hash=${ev.hash.slice(0, 12)}…`);
  console.log(`ledger: ${store.path}`);
  console.log(
    `paper account ${account.account_number} · cash $${account.cash} · equity $${account.equity}`,
  );
  console.log("next: lucre sync");
}
