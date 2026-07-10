/**
 * Conversational mandate onboarding (MANDATE.md simplified into a terminal flow).
 * Uses Bedrock for ticker mapping + compilation; owner types RATIFY to commit.
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { sha256Hex } from "@lucre/core";
import type { Mandate, UniverseEntry } from "@lucre/types";
import {
  createAlpacaClient,
  loadAlpacaConfigFromEnv,
  type AlpacaClient,
} from "../alpaca/client.js";
import {
  createBedrockClient,
  DEFAULT_BEDROCK_MODEL,
  textFromContent,
} from "../brain/bedrock.js";
import { cmdInit } from "./init.js";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";

export async function cmdOnboard(opts: {
  home?: string;
  dryRun?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  let events = store.load();

  if (!events.length) {
    console.log("no ledger — running GENESIS first…\n");
    await cmdInit({ home, dryRun: opts.dryRun });
    if (opts.dryRun) return;
    events = store.load();
  }

  const state = store.reduce();
  if (state.mandate) {
    console.log(
      `mandate already set (v${state.mandateVersion}, ${state.mandate.entries.length} names).`,
    );
    console.log("re-run after MANDATE_CHANGED support, or wipe LUCRE_HOME for a fresh book.");
    process.exitCode = 1;
    return;
  }

  loadAlpacaConfigFromEnv();
  const alpaca = createAlpacaClient();
  const rl = readline.createInterface({ input, output });
  const transcript: string[] = [];

  const ask = async (q: string): Promise<string> => {
    const a = (await rl.question(q)).trim();
    transcript.push(`Q: ${q}\nA: ${a}`);
    return a;
  };

  console.log(`
lucre onboarding — invest in what you know
──────────────────────────────────────────
Chat freely. Nothing hits the ledger until you type RATIFY.
Phases: universe → exclusions → tilt → strategy → risk → ratify
`);

  // ── 1. Universe ────────────────────────────────────────────────────
  console.log("\n▸ Universe (Lynch)\n");
  const day = await ask(
    "Walk me through yesterday — waking to sleeping. What products/apps did you actually touch?\n› ",
  );
  const subs = await ask(
    "Monthly subscriptions you pay for out of pocket (comma-separated)?\n› ",
  );
  const churn = await ask(
    "Anything you recently adopted or churned from?\n› ",
  );

  console.log("\nmapping products → tickers via Bedrock + Alpaca…");
  const rawNames = await mapProductsToTickers(
    [day, subs, churn].join("\n"),
    alpaca,
  );

  const entries: UniverseEntry[] = [];
  const now = new Date().toISOString();
  console.log("\nconfirm each name (conviction 1–5, or skip):\n");
  for (const r of rawNames) {
    const line = await ask(
      `  ${r.ticker}  ${r.companyName}  [${r.exchange}]  (products: ${r.products.join(", ")})\n  conviction 1-5, or s to skip › `,
    );
    if (line.toLowerCase() === "s" || line === "") continue;
    const conv = Math.min(5, Math.max(1, parseInt(line, 10) || 3));
    const pay = await ask(
      `  pay for ${r.ticker} out of pocket? (paid / bundled / free / ads) › `,
    );
    entries.push({
      assetId: r.assetId,
      cik: null,
      ticker: r.ticker,
      companyName: r.companyName,
      exchange: r.exchange,
      productsUsed: r.products,
      usageEvidence: r.evidence,
      paymentRelation: parsePay(pay),
      conviction: conv,
      forcedRank: null,
      status: "tradable",
      sector: r.sector ?? "tech",
      addedAt: now,
      lastAffirmedAt: now,
    });
  }

  if (entries.length >= 3) {
    const top = await ask(
      `\nIf you could only keep 3 tickers, which? (${entries.map((e) => e.ticker).join(", ")})\n› `,
    );
    const rank = top
      .split(/[,\s]+/)
      .map((t) => t.toUpperCase())
      .filter(Boolean);
    rank.forEach((t, i) => {
      const e = entries.find((x) => x.ticker === t);
      if (e) e.forcedRank = i + 1;
    });
  }

  if (!entries.length) {
    console.error("no tradable names — aborting without writing mandate.");
    rl.close();
    process.exitCode = 1;
    return;
  }

  // ── 2. Exclusions ──────────────────────────────────────────────────
  console.log("\n▸ Exclusions\n");
  const exRaw = await ask(
    "Businesses you won't own? (alcohol, pork, gambling, tobacco, weapons, adult, interest_finance — or none)\n› ",
  );
  const threshold = await ask(
    "Incidental exposure (e.g. Costco ~5% alcohol): (a) zero (b) under 5% ok (c) core-business test only\n› ",
  );
  const mode =
    threshold.startsWith("a") ? "hard" : threshold.startsWith("c") ? "soft" : "soft";
  const thr = threshold.startsWith("a") ? 0 : 5;
  const exclusions = parseExclusions(exRaw, mode, thr);

  // ── 3. Tilt ────────────────────────────────────────────────────────
  console.log("\n▸ Tilt\n");
  const tech = await ask("Tech stance? (overweight / neutral / zero) › ");
  const tiltStance =
    tech.startsWith("z") ? "zero" : tech.startsWith("n") ? "neutral" : "overweight";

  // ── 4. Strategy ────────────────────────────────────────────────────
  console.log("\n▸ Strategy\n");
  const strat = await ask(
    "Enable: buy-and-hold growth? (y/n) › ",
  );
  const swing = await ask("Enable swing momentum? (y/n) › ");
  const dip = await ask("Enable buy-the-dip? (y/n) › ");

  // ── 5. Risk ────────────────────────────────────────────────────────
  console.log("\n▸ Risk (behavioral)\n");
  await ask(
    "Account down 30% in a month — what should the agent have already done?\n› ",
  );
  await ask("One position down 50% — cut, hold, or add?\n› ");
  const trim = await ask(
    "A winner is 40% of the book — trim or let ride?\n› ",
  );
  const twoAm = await ask(
    "What's the 2am number — max dollar loss that ruins your week?\n› ",
  );
  const risk = deriveRisk(twoAm, trim, entries.length);

  // ── Compile ────────────────────────────────────────────────────────
  const mandate: Mandate = {
    version: 1,
    schemaVersion: 1,
    entries,
    watchlist: [],
    exclusions,
    adjudications: [],
    tilt: {
      tilts: [{ sector: "tech", stance: tiltStance, targetPctBps: null }],
      tolerancePctBps: 1000,
    },
    strategy: {
      buyAndHoldGrowth: !strat.toLowerCase().startsWith("n"),
      swingMomentum: swing.toLowerCase().startsWith("y"),
      buyTheDip: dip.toLowerCase().startsWith("y"),
      dipTriggerPctBps: dip.toLowerCase().startsWith("y") ? 1000 : null,
      catalystEarnings: false,
      earningsBlackoutDays: 2,
      ranking: ["buyAndHoldGrowth"],
      capitalWeightsBps: { buyAndHoldGrowth: 10000 },
    },
    risk,
    interviewTranscriptHash: sha256Hex(transcript.join("\n\n")),
  };

  console.log("\n▸ Mandate preview\n");
  console.log(
    entries
      .map(
        (e) =>
          `  ${e.ticker.padEnd(6)} conv=${e.conviction}${e.forcedRank ? ` rank=${e.forcedRank}` : ""}  ${e.companyName}`,
      )
      .join("\n"),
  );
  console.log(
    `\n  exclusions: ${exclusions.map((x) => `${x.category}@${x.mode}`).join(", ") || "none"}`,
  );
  console.log(
    `  risk: maxPos ${risk.maxPositionPctBps / 100}%  cashFloor ${risk.cashFloorPctBps / 100}%  ddHalt ${risk.drawdownHaltPctBps / 100}%  ${risk.aggressiveness}`,
  );

  const ratify = await ask(
    "\nType RATIFY to write MANDATE_SET to the ledger (or anything else to abort):\n› ",
  );
  rl.close();

  if (ratify !== "RATIFY") {
    console.log("aborted — ledger unchanged.");
    return;
  }

  if (opts.dryRun) {
    console.log("dry-run — would append MANDATE_SET");
    console.log(JSON.stringify(mandate, null, 2));
    return;
  }

  const mandateHash = sha256Hex(JSON.stringify(mandate));
  const ev = await store.append({
    kind: "MANDATE_SET",
    payload: { mandate, mandateHash },
  });
  await store.append({
    kind: "INTERVIEW_ARCHIVED",
    payload: {
      transcriptHash: mandate.interviewTranscriptHash!,
      localPathHint: "~/.lucre/interview (not stored in v1)",
    },
  });

  console.log(
    `\nMANDATE_SET v1 seq=${ev.seq} · ${entries.length} names · hash ${mandateHash.slice(0, 12)}…`,
  );
  console.log("next: lucre decide   or   lucre  (desk)");
}

// ── helpers ──────────────────────────────────────────────────────────

function parsePay(
  s: string,
): "paid_direct" | "bundled" | "free_tier" | "ad_supported" {
  const t = s.toLowerCase();
  if (t.startsWith("b")) return "bundled";
  if (t.startsWith("f")) return "free_tier";
  if (t.startsWith("a")) return "ad_supported";
  return "paid_direct";
}

function parseExclusions(
  raw: string,
  mode: "hard" | "soft",
  thr: number,
): Mandate["exclusions"] {
  if (!raw || /^none$/i.test(raw.trim())) return [];
  const cats = [
    "alcohol",
    "pork",
    "gambling",
    "tobacco",
    "weapons",
    "adult",
    "interest_finance",
  ] as const;
  const found = cats.filter((c) => raw.toLowerCase().includes(c.replace("_", " ")) || raw.toLowerCase().includes(c));
  // also split commas
  const bits = raw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  for (const b of bits) {
    const hit = cats.find((c) => c.startsWith(b) || b.includes(c.split("_")[0]!));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found.map((category) => ({
    id: `ex-${category}`,
    category,
    customLabel: null,
    ownerDefinition: null,
    mode: category === "pork" || category === "alcohol" ? mode : "hard",
    revenueThresholdPct: category === "pork" ? 0 : thr,
    notes: null,
  }));
}

function deriveRisk(
  twoAm: string,
  trim: string,
  nNames: number,
): Mandate["risk"] {
  const dollars = parseFloat(twoAm.replace(/[^0-9.]/g, "")) || 5000;
  // Rough: larger 2am number → more aggressive
  const aggressiveness =
    dollars >= 25_000 ? "aggressive" : dollars >= 5_000 ? "moderate" : "conservative";
  const maxPositionPctBps =
    aggressiveness === "aggressive" ? 1500 : aggressiveness === "moderate" ? 1000 : 700;
  const drawdownHaltPctBps =
    aggressiveness === "aggressive" ? 1500 : aggressiveness === "moderate" ? 1000 : 700;
  const letRide = /ride|hold|let/i.test(trim);
  return {
    aggressiveness,
    maxPositionPctBps,
    maxSectorPctBps: letRide ? 5000 : 4000,
    cashFloorPctBps: aggressiveness === "conservative" ? 1000 : 500,
    drawdownHaltPctBps,
    maxSingleOrderPctBps: maxPositionPctBps,
    minHoldDays: 0,
    maxTradesPerWeek: Math.min(10, Math.max(3, nNames)),
  };
}

async function mapProductsToTickers(
  blob: string,
  alpaca: AlpacaClient,
): Promise<
  {
    ticker: string;
    assetId: string;
    companyName: string;
    exchange: string;
    products: string[];
    evidence: string;
    sector: string | null;
  }[]
> {
  const bedrock = createBedrockClient({ modelId: DEFAULT_BEDROCK_MODEL });
  const result = await bedrock.converse({
    system:
      "You map consumer products to public single-name equities (no ETFs). Return ONLY a JSON array of {product, ticker, companyHint}. Max 12. Prefer US large-caps the user likely uses.",
    messages: [
      {
        role: "user",
        content: [
          {
            text: `User usage notes:\n${blob}\n\nJSON array only.`,
          },
        ],
      },
    ],
    maxTokens: 1024,
    temperature: 0.1,
  });

  const text = textFromContent(result.message.content);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  let proposed: { product?: string; ticker?: string; companyHint?: string }[] =
    [];
  try {
    proposed = JSON.parse(jsonMatch[0]!) as typeof proposed;
  } catch {
    return [];
  }

  const out: {
    ticker: string;
    assetId: string;
    companyName: string;
    exchange: string;
    products: string[];
    evidence: string;
    sector: string | null;
  }[] = [];
  const seen = new Set<string>();

  for (const p of proposed) {
    const ticker = (p.ticker ?? "").toUpperCase().trim();
    if (!ticker || seen.has(ticker)) continue;
    try {
      const asset = await alpaca.getAsset(ticker);
      if (!asset.tradable || asset.status !== "active") continue;
      // no ETFs if class says so
      if (asset.class && asset.class !== "us_equity") continue;
      seen.add(ticker);
      out.push({
        ticker: asset.symbol,
        assetId: asset.id,
        companyName: asset.name,
        exchange: asset.exchange,
        products: p.product ? [p.product] : [ticker],
        evidence: p.product ?? ticker,
        sector: "tech",
      });
    } catch {
      // skip unmapped
    }
  }
  return out;
}

