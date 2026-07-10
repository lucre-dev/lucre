import { createAlpacaClient, loadAlpacaConfigFromEnv } from "../alpaca/client.js";
import { lucreHome } from "../paths.js";
import { fetchBrokerSnapshot, orphanSweep, reconcile } from "../reconcile.js";
import { openStore } from "../store/jsonl.js";

export async function cmdSync(opts: {
  home?: string;
  seed?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const state = store.reduce();

  if (!state.initialized) {
    console.error("no GENESIS — run: lucre init");
    process.exitCode = 1;
    return;
  }

  loadAlpacaConfigFromEnv();
  const client = createAlpacaClient();

  // 1. Orphan sweep first (blocking)
  const sweep = await orphanSweep(state, client);
  if (sweep.notes.length) {
    console.log("orphan sweep:");
    for (const n of sweep.notes) console.log(`  · ${n}`);
  }
  if (sweep.events.length) {
    if (opts.dryRun) {
      console.log(`dry-run: would append ${sweep.events.length} orphan-sweep event(s)`);
    } else {
      await store.appendMany(sweep.events);
      console.log(`appended ${sweep.events.length} orphan-sweep event(s)`);
    }
  } else {
    console.log("orphan sweep: clean");
  }

  // 2. Re-reduce after sweep, then reconcile positions/cash
  const state2 = store.reduce();
  const snapshot = await fetchBrokerSnapshot(client);
  console.log(
    `broker ${snapshot.accountNumber} · cash $${(snapshot.cashCents / 100).toFixed(2)} · equity $${(snapshot.equityCents / 100).toFixed(2)} · positions ${snapshot.positions.length}`,
  );

  const result = reconcile(state2, snapshot, {
    autoSeed: opts.seed ?? true,
  });

  if (result.diffs.length && result.seedEvents.length) {
    console.log("ledger≠broker — seeding from broker (first sync):");
    for (const d of result.diffs) console.log(`  · ${d.kind}: ${d.detail}`);
  } else if (result.diffs.length) {
    console.error("RECONCILIATION DIVERGED:");
    for (const d of result.diffs) console.error(`  · ${d.kind}: ${d.detail}`);
  } else {
    console.log("ledger matches broker");
  }

  const toAppend = [
    ...result.seedEvents,
    ...(result.reconcileEvent ? [result.reconcileEvent] : []),
    ...(result.divergeEvent ? [result.divergeEvent] : []),
  ];

  // Avoid duplicate POSITIONS_RECONCILED spam: if already matched and last
  // event was a clean reconcile same day with same cash, skip.
  if (
    result.matched &&
    result.reconcileEvent &&
    !result.seedEvents.length
  ) {
    const events = store.load();
    const last = events[events.length - 1];
    if (
      last?.kind === "POSITIONS_RECONCILED" &&
      last.payload.cashCents === snapshot.cashCents
    ) {
      console.log("already reconciled at tip — no append");
      return;
    }
  }

  if (toAppend.length === 0) {
    console.log("nothing to append");
    process.exitCode = result.matched ? 0 : 1;
    return;
  }

  if (opts.dryRun) {
    console.log("dry-run append:");
    for (const b of toAppend) console.log(`  · ${b.kind}`);
    process.exitCode = result.matched ? 0 : 1;
    return;
  }

  const written = await store.appendMany(toAppend);
  for (const e of written) {
    console.log(`append ${e.kind} seq=${e.seq} hash=${e.hash.slice(0, 12)}…`);
  }

  process.exitCode = result.matched ? 0 : 1;
}
