import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";

describe("PromptBuilder", () => {
  it("buildInitialPrompt creates only the system message", () => {
    const prompt = new PromptBuilder().buildInitialPrompt("fix tests");

    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("inputSeq-guarded actions"),
    });
    expect(prompt.messages[0]!.content).toContain("PTY action kinds");
    expect(prompt.messages[0]!.content).toContain("write_text, key, poll");
    expect(prompt.messages[0]!.content).not.toContain(["input", "_frame"].join(""));
    expect(prompt.messages[0]!.content).not.toContain(["end", "_input"].join(""));
    expect(prompt.messages[0]!.content).not.toContain(["rece", "iver"].join(""));
    expect(prompt.messages[0]!.content).toContain("im send --channel");
    expect(prompt.messages[0]!.content).toContain("--text-stdin");
    expect(prompt.messages[0]!.content).toContain("quoted heredoc");
    expect(prompt.messages[0]!.content).toContain("<<'IM'");
    expect(prompt.messages[0]!.content).toContain("normal text replies");
    expect(prompt.messages[0]!.content).toContain("< reply.md");
    expect(prompt.messages[0]!.content).toContain("protected pacing");
    expect(prompt.messages[0]!.content).toContain("producer | cmd");
    expect(prompt.messages[0]!.content).toContain("cmd < <(producer)");
    expect(prompt.messages[0]!.content).toContain('cmd <<< "$text"');
    expect(prompt.messages[0]!.content).toContain("Do not use `im send --text`");
    expect(prompt.messages[0]!.content).toContain("Large write_text payloads are allowed");
    expect(prompt.messages[0]!.content).toContain("stash_file");
    expect(prompt.messages[0]!.content).toContain("file materialize");
    expect(prompt.messages[0]!.content).toContain("file cat");
    expect(prompt.messages[0]!.content).toContain("ordinary textual heredocs");
    expect(prompt.messages[0]!.content).not.toContain("<<'EOF'");
    expect(prompt.messages[0]!.content).toContain("cat > path");
    expect(prompt.messages[0]!.content).toContain(
      "interactive foreground stdin programs",
    );
    expect(prompt.messages[0]!.content).toContain("one ctrl-d may only flush the current line");
    expect(prompt.messages[0]!.content).toContain("do not send any further shell command until a prompt returns");
    expect(prompt.messages[0]!.content).toContain("terminal.inputSeq");
    expect(prompt.messages[0]!.content).toContain("outputTail");
    expect(prompt.messages[0]!.content).toContain("last 2K characters");
    expect(prompt.messages[0]!.content).toContain("does not infer whether");
    expect(prompt.messages[0]!.content).toContain("side-channel payload protocols");
    expect(prompt.messages[0]!.content).not.toContain("small/simple generated text files");
    expect(prompt.messages[0]!.content).not.toContain("Do not put long Markdown");
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
        arguments: { kind: "write_text", expectedInputSeq: 0, text: "pwd" },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: {
          session: "default",
          terminal: {
            inputSeq: 1,
            alive: true,
            syncStatus: { kind: "trusted" },
            lastShellPrompt: {
              cwd: "/repo",
              promptSeq: 1,
              lastReturnCode: 0,
            },
            lastContinuationPrompt: null,
            termination: null,
          },
          action: { kind: "write_text", preview: "pwd" },
          result: "ok",
          eventCount: 1,
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
          expectedInputSeq: 0,
          text: "pwd",
        }),
      },
    });

    const toolMsg = prompt.messages[2]! as Record<string, unknown>;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe(JSON.stringify({
      session: "default",
      terminal: {
        inputSeq: 1,
        alive: true,
        syncStatus: { kind: "trusted" },
        lastShellPrompt: {
          cwd: "/repo",
          promptSeq: 1,
          lastReturnCode: 0,
        },
        lastContinuationPrompt: null,
        termination: null,
      },
      action: { kind: "write_text", preview: "pwd" },
      result: "ok",
      eventCount: 1,
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
          expectedInputSeq: 0,
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

  it("preserves historical write_text tool-call arguments exactly", () => {
    const largeBase64 = `${"A".repeat(512)}\n`;
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "bash",
        arguments: {
          kind: "write_text",
          expectedInputSeq: 5,
          text: largeBase64,
          unexpectedFromModel: "keep-for-debugging",
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("send frame", history);
    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    const args = JSON.parse(fn.arguments as string) as Record<string, unknown>;
    expect(args).toEqual({
      kind: "write_text",
      expectedInputSeq: 5,
      text: largeBase64,
      unexpectedFromModel: "keep-for-debugging",
    });
    expect(fn.arguments).not.toContain("omitted write_text payload");
  });

  it("preserves historical stash_file tool-call arguments exactly", () => {
    const content = "x".repeat(1024);
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "stash_file",
        arguments: {
          name: "snake.html",
          content,
          encoding: "utf8",
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("write file", history);
    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    const args = JSON.parse(fn.arguments as string) as Record<string, unknown>;
    expect(args).toEqual({
      name: "snake.html",
      content,
      encoding: "utf8",
    });
    expect(fn.arguments).not.toContain("omitted stash_file content");
  });
});
