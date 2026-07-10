import { describe, expect, it } from "vitest";
import {
  textFromContent,
  toolUsesFromContent,
  type BedrockContentBlock,
} from "./bedrock.js";

describe("bedrock content helpers", () => {
  it("extracts text blocks", () => {
    const content: BedrockContentBlock[] = [
      { text: "hello " },
      { text: "world" },
      {
        toolUse: {
          toolUseId: "1",
          name: "bash",
          input: { command: "echo hi" },
        },
      },
    ];
    expect(textFromContent(content)).toBe("hello world");
  });

  it("extracts tool uses", () => {
    const content: BedrockContentBlock[] = [
      {
        toolUse: {
          toolUseId: "t1",
          name: "ledger_status",
          input: {},
        },
      },
    ];
    const uses = toolUsesFromContent(content);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.name).toBe("ledger_status");
  });
});
