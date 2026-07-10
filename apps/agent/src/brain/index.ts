import { createBedrockDecideBrain } from "./bedrockDecide.js";
import { DEFAULT_BEDROCK_MODEL } from "./bedrock.js";
import { createOpenAIBrain } from "./openai.js";
import { resolveDecisionModel } from "./resolveModel.js";
import { stubDecide } from "./stub.js";
import type { Brain, DecideContext, DecideResult } from "./types.js";

export type { Brain, DecideContext, DecideResult } from "./types.js";
export { parseDecisionJson } from "./parseDecision.js";
export { stubDecide } from "./stub.js";
export { createOpenAIBrain } from "./openai.js";
export { createBedrockDecideBrain } from "./bedrockDecide.js";
export { resolveDecisionModel } from "./resolveModel.js";

export function createStubBrain(opts?: { allowBuy?: boolean }): Brain {
  return {
    name: "stub",
    async decide(ctx: DecideContext): Promise<DecideResult> {
      const decision = stubDecide(ctx.moves, { allowBuy: opts?.allowBuy });
      return {
        decision,
        raw: JSON.stringify(decision),
        model: "stub",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        provider: "stub",
      };
    },
  };
}

export type BrainKind = "stub" | "openai" | "terra" | "bedrock";

export function createBrain(
  kind: BrainKind,
  opts?: { allowBuy?: boolean; model?: string },
): Brain {
  if (kind === "stub") return createStubBrain({ allowBuy: opts?.allowBuy });
  if (kind === "bedrock") {
    return createBedrockDecideBrain({
      modelId: opts?.model || DEFAULT_BEDROCK_MODEL,
    });
  }
  // openai | terra
  return createOpenAIBrain({
    model: resolveDecisionModel(opts?.model),
  });
}
