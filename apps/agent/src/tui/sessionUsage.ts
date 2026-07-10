/** In-process session meter for the interactive desk (reset on process exit). */

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Best-effort USD cents for this TUI session. */
  costCents: number;
  turns: number;
  modelLast: string | null;
}

const session: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costCents: 0,
  turns: 0,
  modelLast: null,
};

export function getSessionUsage(): SessionUsage {
  return { ...session };
}

export function recordSessionUsage(opts: {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model: string;
}): void {
  session.inputTokens += opts.inputTokens;
  session.outputTokens += opts.outputTokens;
  session.costCents += opts.costCents;
  session.turns += 1;
  session.modelLast = opts.model;
}

export function resetSessionUsage(): void {
  session.inputTokens = 0;
  session.outputTokens = 0;
  session.costCents = 0;
  session.turns = 0;
  session.modelLast = null;
}

/** Rough Bedrock $ → cents (env-overridable). */
export function estimateBedrockCostCents(opts: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  if (opts.inputTokens + opts.outputTokens <= 0) return 0;
  const m = opts.model.toLowerCase();
  // $/MTok — approximate public list; override with LUCRE_PRICE_IN / OUT
  let inPerM = Number(process.env.LUCRE_PRICE_IN);
  let outPerM = Number(process.env.LUCRE_PRICE_OUT);
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) {
    if (m.includes("haiku")) {
      inPerM = 0.8;
      outPerM = 4;
    } else if (m.includes("sonnet")) {
      inPerM = 3;
      outPerM = 15;
    } else if (m.includes("opus") || m.includes("fable")) {
      inPerM = 15;
      outPerM = 75;
    } else {
      inPerM = 1;
      outPerM = 5;
    }
  }
  const dollars =
    (opts.inputTokens / 1_000_000) * inPerM +
    (opts.outputTokens / 1_000_000) * outPerM;
  return Math.max(1, Math.ceil(dollars * 100));
}
