import { sha256Hex } from "@lucre/core";
import type { Mandate, UniverseEntry } from "@lucre/types";
import {
  createAlpacaClient,
  loadAlpacaConfigFromEnv,
} from "../alpaca/client.js";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";

/** Demo universe: names you almost certainly "use" — unblocks paper soak. */
const DEMO: { ticker: string; products: string[]; conviction: number }[] = [
  { ticker: "AAPL", products: ["iPhone", "MacBook"], conviction: 5 },
  { ticker: "MSFT", products: ["GitHub", "VS Code", "Azure"], conviction: 5 },
  { ticker: "GOOGL", products: ["Search", "Gmail", "Android"], conviction: 4 },
  { ticker: "AMZN", products: ["Amazon.com", "AWS"], conviction: 4 },
  { ticker: "NVDA", products: ["CUDA", "GPUs"], conviction: 4 },
  { ticker: "META", products: ["Instagram", "WhatsApp"], conviction: 3 },
  { ticker: "TSLA", products: ["Tesla app / cars"], conviction: 3 },
];

export async function cmdMandateSeedDemo(opts: {
  home?: string;
  dryRun?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const state = store.reduce();
  if (!state.initialized) {
    console.error("no GENESIS — run lucre init");
    process.exitCode = 1;
    return;
  }
  if (state.mandate) {
    console.error("mandate already set — use lucre mandate import to change");
    process.exitCode = 1;
    return;
  }

  loadAlpacaConfigFromEnv();
  const client = createAlpacaClient();
  const now = new Date().toISOString();
  const entries: UniverseEntry[] = [];

  for (const d of DEMO) {
    try {
      const asset = await client.getAsset(d.ticker);
      if (!asset.tradable || asset.status !== "active") {
        console.log(`skip ${d.ticker}: not tradable`);
        continue;
      }
      entries.push({
        assetId: asset.id,
        cik: null,
        ticker: asset.symbol,
        companyName: asset.name,
        exchange: asset.exchange,
        productsUsed: d.products,
        usageEvidence: `demo seed: ${d.products.join(", ")}`,
        paymentRelation: "paid_direct",
        conviction: d.conviction,
        forcedRank: null,
        status: "tradable",
        sector: "tech",
        addedAt: now,
        lastAffirmedAt: now,
      });
      console.log(`+ ${asset.symbol} ${asset.id.slice(0, 8)}…`);
    } catch (err) {
      console.log(
        `skip ${d.ticker}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (entries.length === 0) {
    console.error("no assets resolved");
    process.exitCode = 1;
    return;
  }

  const mandate: Mandate = {
    version: 1,
    schemaVersion: 1,
    entries,
    watchlist: [],
    exclusions: [
      {
        id: "ex-alcohol",
        category: "alcohol",
        customLabel: null,
        ownerDefinition: null,
        mode: "hard",
        revenueThresholdPct: 0,
        notes: "demo hard exclusion",
      },
      {
        id: "ex-pork",
        category: "pork",
        customLabel: null,
        ownerDefinition: null,
        mode: "hard",
        revenueThresholdPct: 0,
        notes: null,
      },
    ],
    adjudications: [],
    tilt: {
      tilts: [{ sector: "tech", stance: "overweight", targetPctBps: 8000 }],
      tolerancePctBps: 1000,
    },
    strategy: {
      buyAndHoldGrowth: true,
      swingMomentum: false,
      buyTheDip: false,
      dipTriggerPctBps: null,
      catalystEarnings: false,
      earningsBlackoutDays: 2,
      ranking: ["buyAndHoldGrowth"],
      capitalWeightsBps: { buyAndHoldGrowth: 10000 },
    },
    risk: {
      aggressiveness: "moderate",
      maxPositionPctBps: 1000,
      maxSectorPctBps: 5000,
      cashFloorPctBps: 500,
      drawdownHaltPctBps: 1000,
      maxSingleOrderPctBps: 1000,
      minHoldDays: 0,
      maxTradesPerWeek: 5,
    },
    interviewTranscriptHash: null,
  };

  const mandateHash = sha256Hex(JSON.stringify(mandate));
  if (opts.dryRun) {
    console.log("dry-run MANDATE_SET", entries.map((e) => e.ticker));
    return;
  }

  const ev = await store.append({
    kind: "MANDATE_SET",
    payload: { mandate, mandateHash },
  });
  console.log(
    `MANDATE_SET v1 seq=${ev.seq} · ${entries.length} names · hash ${mandateHash.slice(0, 12)}…`,
  );
}
