import type { Decision, LegalMove } from "@lucre/types";

/**
 * Deterministic rule brain for M2 — no LLM.
 * Prefer WAIT unless a high-conviction BUY is under a tiny notional test size,
 * or a SELL is forced by exclusion/stop lanes.
 */
export function stubDecide(
  moves: readonly LegalMove[],
  opts?: { allowBuy?: boolean },
): Decision {
  // Forced sells first
  const forcedSell = moves.find(
    (m) =>
      m.kind === "SELL" &&
      (m.lane === "exclusion" || m.lane === "stop" || m.lane === "risk"),
  );
  if (forcedSell && forcedSell.kind === "SELL") {
    return {
      moveId: forcedSell.id,
      qtyMicros: forcedSell.maxQtyMicros,
      thesis: `stub: forced ${forcedSell.lane} sell ${forcedSell.ticker}`,
      confidence: 1,
      noteToFutureSelf: "rule brain exit",
    };
  }

  if (opts?.allowBuy) {
    const buy = moves.find(
      (m) => m.kind === "BUY" && (m.conviction ?? 0) >= 4,
    );
    if (buy && buy.kind === "BUY") {
      // Small test clip: min(1 share, max)
      const oneShare = 1_000_000;
      const qty = Math.min(oneShare, buy.maxQtyMicros);
      if (qty > 0) {
        return {
          moveId: buy.id,
          qtyMicros: qty,
          thesis: `stub: test buy ${buy.ticker} (conviction ${buy.conviction})`,
          confidence: 0.3,
          noteToFutureSelf: "M2 stub clip — replace with real brain",
        };
      }
    }
  }

  const wait = moves.find((m) => m.kind === "WAIT");
  if (!wait) throw new Error("legal moves missing WAIT");
  return {
    moveId: wait.id,
    thesis: "stub: default WAIT — no forced action",
    confidence: 0.5,
    noteToFutureSelf: "patient",
  };
}
