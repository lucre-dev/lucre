import { DecisionSchema, type Decision } from "@lucre/types";
import {
  createBedrockClient,
  DEFAULT_BEDROCK_MODEL,
  textFromContent,
  toolUsesFromContent,
  type BedrockToolSpec,
} from "./bedrock.js";
import { estimateBedrockCostCents } from "../tui/sessionUsage.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { parseDecisionJson } from "./parseDecision.js";
import type { Brain, DecideContext, DecideResult } from "./types.js";

const SUBMIT_DECISION: BedrockToolSpec = {
  toolSpec: {
    name: "submit_decision",
    description:
      "Submit the final portfolio decision. moveId MUST be from the legalMoves menu.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          moveId: { type: "string" },
          qtyMicros: { type: "integer" },
          limitPriceMicros: { type: "integer" },
          confidence: { type: "number" },
          thesis: { type: "string" },
          noteToFutureSelf: { type: "string" },
        },
        required: ["moveId", "thesis"],
      },
    },
  },
};

/**
 * Decision brain on AWS Bedrock (Sonnet by default).
 * Uses a single tool call for structured Decision output.
 */
export function createBedrockDecideBrain(opts?: {
  modelId?: string;
}): Brain {
  const client = createBedrockClient({
    modelId: opts?.modelId || DEFAULT_BEDROCK_MODEL,
  });

  return {
    name: "bedrock",

    async decide(ctx: DecideContext): Promise<DecideResult> {
      const model = opts?.modelId || ctx.model || DEFAULT_BEDROCK_MODEL;
      const result = await client.converse({
        modelId: model,
        system: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            content: [
              {
                text:
                  buildUserPrompt(ctx) +
                  "\n\nCall submit_decision with your choice. Do not invent moveIds.",
              },
            ],
          },
        ],
        tools: [SUBMIT_DECISION],
        maxTokens: 2048,
        temperature: 0.2,
      });

      const uses = toolUsesFromContent(result.message.content);
      let decision: Decision;

      if (uses.length && uses[0]!.name === "submit_decision") {
        const input = uses[0]!.input;
        decision = DecisionSchema.parse({
          moveId: String(input.moveId ?? ""),
          qtyMicros:
            input.qtyMicros === undefined || input.qtyMicros === null
              ? undefined
              : Number(input.qtyMicros),
          limitPriceMicros:
            input.limitPriceMicros === undefined ||
            input.limitPriceMicros === null
              ? undefined
              : Number(input.limitPriceMicros),
          confidence:
            input.confidence === undefined || input.confidence === null
              ? undefined
              : Number(input.confidence),
          thesis: String(input.thesis ?? ""),
          noteToFutureSelf:
            input.noteToFutureSelf == null
              ? undefined
              : String(input.noteToFutureSelf).slice(0, 2000),
        });
      } else {
        // Fallback: model returned raw JSON text
        const text = textFromContent(result.message.content);
        decision = parseDecisionJson(text);
      }

      const costCents = estimateBedrockCostCents({
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      return {
        decision,
        raw: JSON.stringify(decision),
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costCents,
        provider: "bedrock",
      };
    },
  };
}
