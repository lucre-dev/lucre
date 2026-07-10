import { getCash, getEquity, getPositions } from "@lucre/core";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";

export async function cmdVerify(opts: { home?: string }): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const result = store.verifyChain();

  if (!result.ok) {
    console.error(`VERIFY FAIL: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const state = store.reduce();
  console.log(`VERIFY OK · ${result.count} events · tip ${result.tip?.slice(0, 16) ?? "null"}…`);
  console.log(`initialized=${state.initialized} paper=${state.paper}`);
  console.log(
    `cash=$${(getCash(state) / 100).toFixed(2)} equity=$${(getEquity(state) / 100).toFixed(2)}`,
  );
  console.log(
    `positions=${getPositions(state).length} riskHalted=${state.riskHalted} budgetHalted=${state.budgetHalted}`,
  );
  console.log(
    `mandate v${state.mandateVersion || "—"} · spend months=${state.spendByMonth.size}`,
  );
}
