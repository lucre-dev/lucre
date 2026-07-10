/**
 * Best-effort $/MTok → cents for a call.
 * Override with env LUCRE_PRICE_* if rates move.
 *
 * Defaults approximate post-intro OpenAI batch-ish rates; live chat is higher.
 * We meter for the monthly cap, not accounting precision.
 */
export function estimateCostCents(opts: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const rates = ratesFor(opts.model);
  if (opts.inputTokens + opts.outputTokens <= 0) return 0;
  const dollars =
    (opts.inputTokens / 1_000_000) * rates.inPerMTok +
    (opts.outputTokens / 1_000_000) * rates.outPerMTok;
  return Math.max(1, Math.ceil(dollars * 100)); // at least 1¢ when any tokens
}

function ratesFor(model: string): { inPerMTok: number; outPerMTok: number } {
  const m = model.toLowerCase();
  // Env overrides: LUCRE_PRICE_IN / LUCRE_PRICE_OUT as $/MTok
  const envIn = Number(process.env.LUCRE_PRICE_IN);
  const envOut = Number(process.env.LUCRE_PRICE_OUT);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) {
    return { inPerMTok: envIn, outPerMTok: envOut };
  }

  if (m.includes("terra") || m.includes("gpt-5.6") || m.includes("gpt-5")) {
    // Terra-class default from plan (~$2.86/mo batched ≈ mid rates)
    return { inPerMTok: 1.25, outPerMTok: 10 };
  }
  if (m.includes("sol") || m.includes("gpt-4.1") || m.includes("gpt-4o")) {
    return { inPerMTok: 2.5, outPerMTok: 10 };
  }
  if (m.includes("mini") || m.includes("nano") || m.includes("haiku")) {
    return { inPerMTok: 0.15, outPerMTok: 0.6 };
  }
  // conservative default
  return { inPerMTok: 5, outPerMTok: 15 };
}
