import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import { conservativePromptTokenCount } from "../src/model/prompt-token-counter.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";

describe("prompt token counting helpers", () => {
  it("counts mixed English, Chinese, emoji, whitespace, and punctuation", () => {
    expect(conservativePromptTokenCount("hello world")).toBeGreaterThan(0);
    expect(conservativePromptTokenCount("中文✅")).toBeGreaterThanOrEqual(3);
  });

  it("can render history-only messages so system prompt stays outside compaction", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "session_observe",
        arguments: {},
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: {
          kind: "tool_validation",
          message: "ok",
          recoverable: false,
        },
      },
    ];

    const builder = new PromptBuilder();
    const historyOnly = builder.buildHistoryMessages(history);
    const full = builder.buildNextPrompt("task", history).messages;

    expect(historyOnly.some((message) => message.role === "system")).toBe(false);
    expect(full[0]?.role).toBe("system");
    expect(full.slice(1)).toEqual(historyOnly);
  });
});
