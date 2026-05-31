import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/model/prompt-builder.js";
import type { HistoryEntry } from "../src/model/prompt-builder.js";
import type { TerminalObservation } from "../src/terminal/types.js";

function terminalObservation(
  overrides: Partial<TerminalObservation> = {},
): TerminalObservation {
  return {
    currentSession: "default",
    observedSession: "default",
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
      foregroundProcess: null,
    },
    request: "terminal_write",
    result: "ok",
    returnedToPrompt: true,
    screen: {
      text: "pwd\n/repo\n",
      rows: 24,
      cols: 80,
      truncated: false,
      logRef: { path: "managed-pty://default" },
    },
    ...overrides,
  };
}

describe("PromptBuilder", () => {
  it("buildInitialPrompt creates only the current terminal/session system message", () => {
    const prompt = new PromptBuilder().buildInitialPrompt("fix tests");

    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("terminal/session tools"),
    });
    expect(prompt.messages[0]!.content).toContain("terminal_write");
    expect(prompt.messages[0]!.content).toContain("terminal_key");
    expect(prompt.messages[0]!.content).toContain("session_observe");
    expect(prompt.messages[0]!.content).toContain("session_list");
    expect(prompt.messages[0]!.content).toContain("session_focus");
    expect(prompt.messages[0]!.content).toContain("session_interrupt");
    expect(prompt.messages[0]!.content).toContain("session_restart");
    expect(prompt.messages[0]!.content).toContain("session_terminate");
    expect(prompt.messages[0]!.content).toContain("terminal.inputSeq");
    expect(prompt.messages[0]!.content).toContain("screen.text");
    expect(prompt.messages[0]!.content).toContain("screen.logRef.path");
    expect(prompt.messages[0]!.content).toContain("im send --channel");
    expect(prompt.messages[0]!.content).toContain("--text-stdin");
    expect(prompt.messages[0]!.content).toContain("io_wait");
    expect(prompt.messages[0]!.content).toContain("Thinking is reasoning-only");
    expect(prompt.messages[0]!.content).toContain("no special User main message");
    expect(prompt.messages[0]!.content).toContain("role=user for chat-template compatibility");

    expect(prompt.messages[0]!.content).not.toContain("PTY action kinds");
    expect(prompt.messages[0]!.content).not.toContain(
      `${["write", "_text"].join("")}, key, poll`,
    );
    expect(prompt.messages[0]!.content).not.toContain(["stash", "_file"].join(""));
    expect(prompt.messages[0]!.content).not.toContain("tiny-agent file");
    expect(prompt.messages[0]!.content).not.toContain("subcommands: im, file, skill");
    expect(prompt.messages[0]!.content).not.toContain("file materialize");
    expect(prompt.messages[0]!.content).not.toContain(["output", "Tail"].join(""));
    expect(prompt.messages[0]!.content).not.toContain("last 2K characters");
    expect(prompt.messages[0]!.content).not.toContain("DSML");
  });

  it("buildNextPrompt serializes tool call and observation history in order", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "terminal_write",
        arguments: { expectedInputSeq: 0, text: "pwd\n" },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: terminalObservation(),
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
        name: "terminal_write",
        arguments: JSON.stringify({
          expectedInputSeq: 0,
          text: "pwd\n",
        }),
      },
    });

    const toolMsg = prompt.messages[2]! as Record<string, unknown>;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe(JSON.stringify(terminalObservation()));
  });

  it("buildNextPrompt includes agent observations from validation failures", () => {
    const history: HistoryEntry[] = [
      {
        role: "tool_result",
        toolCallId: "bad-call",
        observation: {
          kind: "tool_validation",
          message: "Invalid terminal_write arguments",
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
        message: "Invalid terminal_write arguments",
        recoverable: true,
      }),
    });
  });

  it("buildNextPrompt renders environment_reminder entries as user-role environment messages in chronological position", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "terminal_write",
        arguments: {
          expectedInputSeq: 0,
          text: "pwd\n",
        },
      },
      {
        role: "tool_result",
        toolCallId: "call-1",
        observation: terminalObservation(),
      },
      {
        role: "environment_reminder",
        content: "Environment reminder:\n- [env-im-001] [user@default] hello",
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
      "Environment reminder:\n- [env-im-001] [user@default] hello",
    );
  });

  it("preserves historical terminal_write tool-call arguments exactly", () => {
    const largeBase64 = `${"A".repeat(512)}\n`;
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "terminal_write",
        arguments: {
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
      expectedInputSeq: 5,
      text: largeBase64,
      unexpectedFromModel: "keep-for-debugging",
    });
    expect(fn.arguments).not.toContain("omitted terminal_write payload");
  });

  it("preserves historical session_focus tool-call arguments exactly", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "call-1",
        name: "session_focus",
        arguments: {
          session: "build",
          create: true,
          cwd: "/repo",
          unexpectedFromModel: "keep-for-debugging",
        },
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("switch session", history);
    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    const args = JSON.parse(fn.arguments as string) as Record<string, unknown>;
    expect(args).toEqual({
      session: "build",
      create: true,
      cwd: "/repo",
      unexpectedFromModel: "keep-for-debugging",
    });
  });

  it("serializes historical io_wait tool-call arguments exactly", () => {
    const history: HistoryEntry[] = [
      {
        role: "assistant_tool_call",
        toolCallId: "fim-call-run-001-3",
        name: "io_wait",
        arguments: {
          reason: "awaiting user",
          condition: { kind: "new_user_message", channel: "default" },
        },
        thinking: "I should wait for the next user message.",
      },
    ];

    const prompt = new PromptBuilder().buildNextPrompt("wait", history);
    const assistantMsg = prompt.messages[1]! as Record<string, unknown>;
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;

    expect(assistantMsg.reasoning).toBe(
      "I should wait for the next user message.",
    );
    expect(fn).toEqual({
      name: "io_wait",
      arguments: JSON.stringify({
        reason: "awaiting user",
        condition: { kind: "new_user_message", channel: "default" },
      }),
    });
  });
});
