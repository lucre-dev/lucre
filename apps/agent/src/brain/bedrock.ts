/**
 * AWS Bedrock Converse API (Bearer token or later SigV4 via CLI-compatible endpoint).
 * Prefer AWS_BEARER_TOKEN_BEDROCK from ~/.tokens — same path GBrain uses.
 */

export interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

export type BedrockContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | {
      toolResult: {
        toolUseId: string;
        content: { text: string }[];
        status?: "success" | "error";
      };
    };

export interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface BedrockConverseResult {
  message: BedrockMessage;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  raw: unknown;
}

export class BedrockError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "BedrockError";
  }
}

export interface BedrockClientOpts {
  region?: string;
  modelId?: string;
  bearerToken?: string;
}

/** Default: Sonnet 4.5 via US inference profile (on-demand requires profile id). */
export const DEFAULT_BEDROCK_MODEL =
  process.env.LUCRE_BEDROCK_MODEL?.trim() ||
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export const FAST_BEDROCK_MODEL =
  process.env.LUCRE_BEDROCK_FAST_MODEL?.trim() ||
  "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export function createBedrockClient(opts: BedrockClientOpts = {}) {
  const region =
    opts.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const bearer =
    opts.bearerToken?.trim() ||
    process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (!bearer) {
    throw new BedrockError(
      "missing AWS_BEARER_TOKEN_BEDROCK — add Bedrock API key to ~/.tokens",
    );
  }

  const defaultModel = opts.modelId || DEFAULT_BEDROCK_MODEL;

  async function converse(args: {
    messages: BedrockMessage[];
    system?: string;
    tools?: BedrockToolSpec[];
    modelId?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<BedrockConverseResult> {
    const modelId = args.modelId || defaultModel;
    const encoded = encodeURIComponent(modelId);
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encoded}/converse`;

    const body: Record<string, unknown> = {
      messages: args.messages,
      inferenceConfig: {
        maxTokens: args.maxTokens ?? 4096,
        temperature: args.temperature ?? 0.2,
      },
    };
    if (args.system) {
      body.system = [{ text: args.system }];
    }
    if (args.tools?.length) {
      body.toolConfig = { tools: args.tools };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) detail = j.message;
      } catch {
        /* keep */
      }
      throw new BedrockError(
        `Bedrock converse → ${res.status}: ${detail}`,
        res.status,
        text.slice(0, 800),
      );
    }

    const json = JSON.parse(text) as {
      output?: { message?: { role?: string; content?: BedrockContentBlock[] } };
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };

    const msg = json.output?.message;
    if (!msg?.content) {
      throw new BedrockError("empty Bedrock output", res.status, text.slice(0, 400));
    }

    return {
      message: {
        role: (msg.role as "assistant") || "assistant",
        content: msg.content,
      },
      stopReason: json.stopReason ?? "end_turn",
      inputTokens: json.usage?.inputTokens ?? 0,
      outputTokens: json.usage?.outputTokens ?? 0,
      model: modelId,
      raw: json,
    };
  }

  return {
    region,
    defaultModel,
    converse,
  };
}

export type BedrockClient = ReturnType<typeof createBedrockClient>;

export function textFromContent(content: BedrockContentBlock[]): string {
  return content
    .map((b) => ("text" in b && b.text ? b.text : ""))
    .filter(Boolean)
    .join("");
}

export function toolUsesFromContent(
  content: BedrockContentBlock[],
): { toolUseId: string; name: string; input: Record<string, unknown> }[] {
  const out: { toolUseId: string; name: string; input: Record<string, unknown> }[] =
    [];
  for (const b of content) {
    if ("toolUse" in b && b.toolUse) {
      out.push({
        toolUseId: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input ?? {},
      });
    }
  }
  return out;
}
