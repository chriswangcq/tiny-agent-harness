import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";

describe("DeepSeek V4 prompt encoding", () => {
  it("encodes environment reminders through user role so generation starts at assistant thinking", () => {
    const history: HistoryEntry[] = [
      {
        role: "environment_reminder",
        content: "Environment reminder:\n[user@default] 你好",
      },
    ];
    const { messages } = new PromptBuilder().buildNextPrompt("你好", history);

    const encoded = execFileSync("python3", ["scripts/encode-prompt.py"], {
      input: JSON.stringify({ messages, thinking_mode: "thinking" }),
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(messages.at(-1)?.role).toBe("user");
    expect(encoded).toContain("<｜User｜>System-generated environment reminder.");
    expect(encoded).not.toContain("<｜latest_reminder｜>");
    expect(encoded.endsWith("<｜Assistant｜><think>")).toBe(true);
  });
});
