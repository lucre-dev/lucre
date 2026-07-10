import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";
import { cmdOnboard } from "../commands/onboard.js";
import { bedrockAuthPresent } from "../tokens.js";

export type DeskReadiness =
  | { ready: true; reason: "ok" }
  | { ready: false; reason: "no_genesis" | "no_mandate" };

/**
 * Ledger-driven first-run gate.
 * ready = GENESIS + MANDATE_SET. No cloud accounts — just local book state.
 */
export function getDeskReadiness(home = lucreHome()): DeskReadiness {
  const store = openStore(home);
  const events = store.load();
  if (!events.length) return { ready: false, reason: "no_genesis" };
  const state = store.reduce();
  if (!state.initialized) return { ready: false, reason: "no_genesis" };
  if (!state.mandate) return { ready: false, reason: "no_mandate" };
  return { ready: true, reason: "ok" };
}

export function printTokenHints(): void {
  const alpaca =
    process.env.ALPACA_PAPER_KEY_ID?.trim() &&
    process.env.ALPACA_PAPER_SECRET_KEY?.trim();
  if (!alpaca) {
    console.log(
      "⚠  Alpaca paper keys missing — add ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY to ~/.tokens",
    );
  }
  if (!bedrockAuthPresent()) {
    console.log(
      "⚠  Bedrock token missing — add AWS_BEARER_TOKEN_BEDROCK to ~/.tokens (desk chat / decide)",
    );
  }
  if (alpaca && bedrockAuthPresent()) {
    console.log("✓  keys loaded from ~/.tokens");
  }
  console.log("");
}

/**
 * One-time setup ceremony: genesis (inside onboard) + mandate interview.
 * Returns true if the book is ready for the desk afterward.
 */
export async function runFirstRunSetup(opts?: {
  home?: string;
}): Promise<boolean> {
  const home = opts?.home ?? lucreHome();
  const gate = getDeskReadiness(home);

  console.log("");
  console.log("lucre  ·  first run");
  console.log("──────────────────");
  console.log("No sign-in. This machine's ledger is the account.");
  console.log(`data: ${home}`);
  console.log("");

  if (gate.reason === "no_genesis") {
    console.log("step 1/2  open paper book (GENESIS from Alpaca)");
    console.log("step 2/2  mandate interview — type RATIFY at the end\n");
  } else if (gate.reason === "no_mandate") {
    console.log("book exists — still need a mandate (invest-in-what-you-know)\n");
  }

  printTokenHints();

  // Soft block: Alpaca is required for genesis; warn and continue into onboard
  // which will fail loudly if keys missing.
  if (
    !process.env.ALPACA_PAPER_KEY_ID?.trim() ||
    !process.env.ALPACA_PAPER_SECRET_KEY?.trim()
  ) {
    console.error(
      "cannot finish setup without Alpaca paper keys in ~/.tokens\n" +
        "add them, then run: lucre\n",
    );
    return false;
  }

  await cmdOnboard({ home });

  const after = getDeskReadiness(home);
  if (!after.ready) {
    console.log("");
    console.log("setup incomplete (no RATIFY or aborted).");
    console.log("run  lucre           to resume setup");
    console.log("or   lucre --desk    to open the shell anyway");
    console.log("");
    return false;
  }

  console.log("");
  console.log("setup complete — opening desk\n");
  return true;
}
