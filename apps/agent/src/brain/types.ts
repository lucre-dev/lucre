import type { Decision, LegalMove } from "@lucre/types";
import type { LedgerState } from "@lucre/core";

export interface QuoteView {
  assetId: string;
  ticker: string;
  priceMicros: number;
}

export interface DecideContext {
  tradingDay: string;
  state: LedgerState;
  moves: readonly LegalMove[];
  quotes: readonly QuoteView[];
  /** Recent run notes / memory snippets (size-capped). */
  memoryNotes?: string[];
  model: string;
}

export interface DecideResult {
  decision: Decision;
  raw: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD cents (best-effort). */
  costCents: number;
  provider: string;
}

export interface Brain {
  readonly name: string;
  decide(ctx: DecideContext): Promise<DecideResult>;
}
