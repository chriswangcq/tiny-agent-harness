import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";

describe("PromptBuilder", () => {
  it("buildInitialPrompt creates only the system message", () => {
    const prompt = new PromptBuilder().buildInitialPrompt("fix tests");

    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("owner/revision guarded actions"),
    });
    expect(prompt.messages[0]!.content).toContain("PTY action kinds");
    expect(prompt.messages[0]!.content).toContain("write_text, key, poll");
    expect(prompt.messages[0]!.content).not.toContain(["input", "_frame"].join(""));
    expect(prompt.messages[0]!.content).not.toContain(["end", "_input"].join(""));
    expect(prompt.messages[0]!.content).not.toContain(["rece", "iver"].join(""));
    expect(prompt.messages[0]!.content).toContain("im send --channel");
    expect(prompt.messages[0]!.content).toContain("Large write_text payloads are allowed");
    expect(prompt.messages[0]!.content).toContain("cat > path");
    expect(prompt.messages[0]!.content).toContain("inputPolicy is writable or unknown");
    expect(prompt.messages[0]!.content).toContain("no file staging protocol");
    expect(prompt.messages[0]!.content).not.toContain("bash command fields");
    expect(prompt.messages[0]!.content).not.toContain("UnsupportedControlPayload");
    expect(prompt.messages[0]!.content).not.toContain("artifact write");
    expect(prompt.messages[0]!.content).toContain("Thinking is reasoning-only");
    expect(prompt.messages[0]!.content).not.toContain("DSML");
    expect(prompt.messages[0]!.content).toContain("no special User main message");
    expect(prompt.messages[0]!.content).toContain("role=user for chat-template compatibility");
  });

  it("buildNextPrompt serializes tool call and observation history in order", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: { kind: "write_text", expectedOwnerRevision: 0, text: "pwd" },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: {
          session: "default",
          owner: {
            kind: "shell",
            revision: 1,
            cwd: "/repo",
            promptSeq: 1,
            lastReturnCode: 0,
            promptNonce: "nonce",
          },
          action: { kind: "write_text", preview: "pwd" },
          result: "ok",
          events: [{ kind: "prompt" }],
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("inspect repo", history);

    expect(prompt.messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
    ]);

    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("");
    expect(assistantMsg.reasoning).toBe("");
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({
          kind: "write_text",
          expectedOwnerRevision: 0,
          text: "pwd",
        }),
      },
    });

    const toolMsg = prompt.messages[2]! as Record<string, unknown>;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe(JSON.stringify({
      session: "default",
      owner: {
        kind: "shell",
        revision: 1,
        cwd: "/repo",
        promptSeq: 1,
        lastReturnCode: 0,
        promptNonce: "nonce",
      },
      action: { kind: "write_text", preview: "pwd" },
      result: "ok",
      events: [{ kind: "prompt" }],
    }));
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

    expect(prompt.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "bad-call",
      content: JSON.stringify({
        kind: "tool_validation",
        message: "Invalid bash tool arguments",
        recoverable: true,
      }),
    });
  });

  it("buildNextPrompt renders environment_reminder entries as user-role environment messages in chronological position", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: {
          kind: "write_text",
          session: "default",
          expectedOwnerRevision: 0,
          text: "pwd\n",
        },
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
      "assistant",
      "tool",
      "user",
    ]);
    expect(prompt.messages[3]!.content).toContain(
      "System-generated environment reminder.",
    );
    expect(prompt.messages[3]!.content).toContain(
      "Environment reminder:\n- [env-im-001] user_message_received",
    );
  });

  it("omits large write_text payloads from serialized tool-call history", () => {
    const largeBase64 = `${"A".repeat(512)}\n`;
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: {
          kind: "write_text",
          expectedOwnerRevision: 5,
          text: largeBase64,
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("send frame", history);
    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    const args = JSON.parse(fn.arguments as string) as Record<string, unknown>;
    expect(args.text).toBeUndefined();
    expect(args.textOmittedFromHistory).toMatchObject({
      kind: "redacted_write_text_payload",
      bytes: Buffer.byteLength(largeBase64, "utf8"),
    });
    expect(fn.arguments).not.toContain(largeBase64.trim());
    expect(fn.arguments).not.toContain("[redacted write_text payload");
  });
});
