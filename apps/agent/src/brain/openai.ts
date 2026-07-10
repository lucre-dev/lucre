import { parseDecisionJson } from "./parseDecision.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  DECISION_JSON_SCHEMA,
} from "./prompt.js";
import { estimateCostCents } from "./pricing.js";
import { resolveDecisionModel } from "./resolveModel.js";
import type { Brain, DecideContext, DecideResult } from "./types.js";

export class OpenAIBrainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenAIBrainError";
  }
}

export interface OpenAIBrainOpts {
  apiKey?: string;
  baseUrl?: string;
  /** Override model; else ctx.model */
  model?: string;
}

/**
 * OpenAI Chat Completions brain with strict json_schema.
 * Model id comes from ledger GENESIS / env LUCRE_DECISION_MODEL.
 */
export function createOpenAIBrain(opts: OpenAIBrainOpts = {}): Brain {
  const apiKey =
    opts.apiKey?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_KEY?.trim();
  if (!apiKey) {
    throw new OpenAIBrainError(
      "missing OPENAI_API_KEY — add to ~/.tokens for real brain",
    );
  }
  const baseUrl = (
    opts.baseUrl ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  return {
    name: "openai",

    async decide(ctx: DecideContext): Promise<DecideResult> {
      const model = resolveDecisionModel(opts.model || ctx.model);

      const body = {
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(ctx) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: DECISION_JSON_SCHEMA,
        },
      };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 400);
        try {
          const errJson = JSON.parse(text) as {
            error?: { message?: string; code?: string; type?: string };
          };
          const e = errJson.error;
          if (e?.message) {
            detail = `${e.code ?? e.type ?? "error"}: ${e.message}`;
          }
        } catch {
          /* keep raw */
        }
        throw new OpenAIBrainError(
          `OpenAI chat/completions → ${res.status} (${detail})`,
          res.status,
          text.slice(0, 800),
        );
      }

      const json = JSON.parse(text) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };

      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new OpenAIBrainError("empty model content", res.status, text.slice(0, 400));
      }

      const decision = parseDecisionJson(content);
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const outputTokens = json.usage?.completion_tokens ?? 0;
      const usedModel = json.model ?? model;

      return {
        decision,
        raw: content,
        model: usedModel,
        inputTokens,
        outputTokens,
        costCents: estimateCostCents({
          model: usedModel,
          inputTokens,
          outputTokens,
        }),
        provider: "openai",
      };
    },
  };
}
