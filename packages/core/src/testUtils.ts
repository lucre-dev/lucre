import type {
  LucreEvent,
  LucreEventBody,
  Mandate,
  RiskConfig,
  UniverseEntry,
} from "@lucre/types";
import { DEFAULT_RISK_CONFIG, SCHEMA_VERSION } from "@lucre/types";
import { hashEvent } from "./hash.js";

const TS0 = "2026-01-05T12:00:00.000Z";

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Build a properly hash-chained, seq-linked event list from bodies.
 * Uses real sha256 so chain verification tests are meaningful.
 */
export function chain(
  bodies: LucreEventBody[],
  opts?: { startSeq?: number; startPrevHash?: string | null; createdAt?: string },
): LucreEvent[] {
  let prevHash: string | null = opts?.startPrevHash ?? null;
  let seq = opts?.startSeq ?? 1;
  const createdAt = opts?.createdAt ?? TS0;

  return bodies.map((body, i) => {
    const id = uuid(1000 + seq);
    const envelope = {
      id,
      seq,
      createdAt,
      schemaVersion: SCHEMA_VERSION,
      kind: body.kind,
      payload: body.payload,
    };
    const hash = hashEvent(prevHash, envelope as never);
    const ev = {
      ...envelope,
      prevHash,
      hash,
    } as LucreEvent;
    prevHash = hash;
    seq += 1;
    void i;
    return ev;
  });
}

export function genesis(overrides?: {
  cashCents?: number;
  risk?: Partial<RiskConfig>;
  paper?: boolean;
}): LucreEventBody {
  return {
    kind: "GENESIS",
    payload: {
      ownerLabel: "syedos",
      paper: overrides?.paper ?? true,
      risk: { ...DEFAULT_RISK_CONFIG, ...overrides?.risk },
      startingCashCents: overrides?.cashCents ?? 100_000_00, // $100k paper
      decisionModel: "gpt-5.6-terra",
      screenModel: "gpt-5.4-mini",
      reviewModel: "gpt-5.6-sol",
    },
  };
}

export function sampleEntry(
  n: number,
  opts?: Partial<UniverseEntry>,
): UniverseEntry {
  return {
    assetId: `asset-${n}`,
    cik: null,
    ticker: opts?.ticker ?? `T${n}`,
    companyName: opts?.companyName ?? `Company ${n}`,
    exchange: "NASDAQ",
    productsUsed: ["app"],
    usageEvidence: "use daily",
    paymentRelation: "paid_direct",
    conviction: 4,
    forcedRank: null,
    status: "tradable",
    sector: "tech",
    addedAt: TS0,
    lastAffirmedAt: TS0,
    ...opts,
  };
}

export function sampleMandate(entries: UniverseEntry[]): Mandate {
  return {
    version: 1,
    schemaVersion: 1,
    entries,
    watchlist: [],
    exclusions: [],
    adjudications: [],
    tilt: { tilts: [], tolerancePctBps: 500 },
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
      maxSectorPctBps: 4000,
      cashFloorPctBps: 500,
      drawdownHaltPctBps: 1000,
      maxSingleOrderPctBps: 1000,
      minHoldDays: 0,
      maxTradesPerWeek: 5,
    },
    interviewTranscriptHash: "deadbeef",
  };
}
