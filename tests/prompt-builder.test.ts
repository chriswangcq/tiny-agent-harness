import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";

describe("PromptBuilder", () => {
  it("buildInitialPrompt creates system and user messages in order", () => {
    const prompt = new PromptBuilder().buildInitialPrompt("fix tests");

    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("two tools: bash and io_wait"),
    });
    expect(prompt.messages[1]).toEqual({ role: "user", content: "fix tests" });
  });

  it("buildNextPrompt serializes tool call and observation history in order", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: { session: "default", command: "pwd" },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: {
          session: "default",
          returnCode: 0,
          output: "/repo\n",
          outputTruncated: false,
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("inspect repo", history);

    expect(prompt.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "observation",
    ]);

    expect(JSON.parse(prompt.messages[2]!.content)).toEqual({
      type: "tool_call",
      id: "call-1",
      name: "bash",
      arguments: { session: "default", command: "pwd" },
    });
    expect(JSON.parse(prompt.messages[3]!.content)).toEqual({
      session: "default",
      returnCode: 0,
      output: "/repo\n",
      outputTruncated: false,
    });
  });

  it("buildNextPrompt includes agent observations from validation failures", () => {
    const history: HistoryEntry[] = [
      {
        role: "tool_result",
        toolCallId: "bad-call",
        observation: {
          kind: "tool_validation",
          message: "Invalid bash tool arguments",
          recoverable: true,
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("try again", history);

    expect(prompt.messages[2]).toEqual({
      role: "observation",
      content: JSON.stringify({
        kind: "tool_validation",
        message: "Invalid bash tool arguments",
        recoverable: true,
      }),
    });
  });

  it("buildNextPrompt renders environment_reminder entries as system role messages in chronological position", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: { session: "default", command: "pwd" },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: {
          session: "default",
          returnCode: 0,
          output: "/repo\n",
          outputTruncated: false,
        },
      },
      {
        role: "environment_reminder",
        content: "Environment reminder:\n- [env-im-001] user_message_received",
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("do stuff", history);

    expect(prompt.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "observation",
      "system",
    ]);
    expect(prompt.messages[4]!.content).toBe(
      "Environment reminder:\n- [env-im-001] user_message_received",
    );
  });
});
