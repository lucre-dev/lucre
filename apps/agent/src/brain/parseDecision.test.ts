import { describe, expect, it } from "vitest";
import { parseDecisionJson } from "./parseDecision.js";

describe("parseDecisionJson", () => {
  it("parses strict schema shape with nulls", () => {
    const d = parseDecisionJson(
      JSON.stringify({
        moveId: "wait:2026-01-05",
        qtyMicros: null,
        limitPriceMicros: null,
        confidence: 0.7,
        thesis: "Nothing compelling; hold cash.",
        noteToFutureSelf: "watch NVDA earnings",
      }),
    );
    expect(d.moveId).toBe("wait:2026-01-05");
    expect(d.qtyMicros).toBeUndefined();
    expect(d.confidence).toBe(0.7);
    expect(d.thesis).toMatch(/hold cash/i);
  });

  it("parses buy with qty", () => {
    const d = parseDecisionJson(
      JSON.stringify({
        moveId: "buy:asset-1:2026-01-05",
        qtyMicros: 1_000_000,
        limitPriceMicros: 200_000_000,
        confidence: 0.6,
        thesis: "Use Apple daily; pullback into range.",
        noteToFutureSelf: null,
      }),
    );
    expect(d.qtyMicros).toBe(1_000_000);
    expect(d.limitPriceMicros).toBe(200_000_000);
  });

  it("rejects missing thesis", () => {
    expect(() =>
      parseDecisionJson(
        JSON.stringify({
          moveId: "wait:x",
          thesis: "",
        }),
      ),
    ).toThrow();
  });

  it("strips markdown fences", () => {
    const d = parseDecisionJson(
      "```json\n" +
        JSON.stringify({
          moveId: "wait:1",
          thesis: "wait",
          qtyMicros: null,
          limitPriceMicros: null,
          confidence: null,
          noteToFutureSelf: null,
        }) +
        "\n```",
    );
    expect(d.moveId).toBe("wait:1");
  });
});
