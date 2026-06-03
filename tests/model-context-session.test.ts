import { describe, expect, it } from "vitest";
import {
  ModelContextSession,
  PromptBuilderContextRenderer,
  modelContextItemsToHistoryEntries,
  type ModelContextItem,
  type ModelContextRenderer,
} from "../src/model/context-session.js";
import { DeterministicModelContextCompactor } from "../src/model/context-window.js";
import type { TerminalObservation } from "../src/terminal/types.js";

function terminalObservation(
  overrides: Partial<TerminalObservation> = {},
): TerminalObservation {
  return {
    currentSession: "default",
    observedSession: "default",
    terminal: {
      inputSeq: 2,
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

describe("ModelContextSession", () => {
  it("appends incremental context items and renders them in order", () => {
    const session = ModelContextSession.create({
      task: "inspect repo",
      renderer: new PromptBuilderContextRenderer(),
    });

    session.append({
      type: "environment_reminder",
      content: "Environment reminder:\n- [env-1] [user@default] hello",
    });
    const appendResult = session.append([
      {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "terminal_write",
          arguments: { expectedInputSeq: 1, text: "pwd\n" },
        },
        thinking: { content: "Need current directory." },
      },
      {
        type: "observation",
        toolCallId: "call-1",
        observation: terminalObservation(),
      },
    ]);

    const turn = session.prepareModelTurn();

    expect(appendResult).toEqual({ appendedCount: 2, itemCount: 3 });
    expect(turn.itemCount).toBe(3);
    expect(turn.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(turn.messages[1]!.content).toContain("[user@default] hello");
    expect(turn.messages[2]).toMatchObject({
      role: "assistant",
      reasoning: "Need current directory.",
      tool_calls: [
        {
          type: "function",
          function: {
            name: "terminal_write",
            arguments: JSON.stringify({ expectedInputSeq: 1, text: "pwd\n" }),
          },
        },
      ],
    });
    expect(turn.messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify(terminalObservation()),
    });
  });

  it("renders transient reminders without mutating the durable session state", () => {
    const session = ModelContextSession.create({
      task: "continue",
      renderer: new PromptBuilderContextRenderer(),
      initialItems: [
        {
          type: "environment_reminder",
          content: "Environment reminder:\n- baseline",
        },
      ],
    });

    const turn = session.prepareModelTurn({
      transientReminders: ["Active skill run: code-edit-patch"],
    });
    const snapshot = session.snapshot();

    expect(turn.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(turn.messages[2]!.content).toContain("Active skill run");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toEqual({
      type: "environment_reminder",
      content: "Environment reminder:\n- baseline",
    });
  });

  it("restores from a snapshot deterministically", () => {
    const initialItems: ModelContextItem[] = [
      {
        type: "io_wait_call",
        toolCallId: "wait-1",
        wait: {
          condition: {
            kind: "new_user_message",
            channel: "default",
            cursor: "msg-1",
          },
        },
        thinking: { content: "Wait for user." },
      },
    ];

    const original = ModelContextSession.create({
      task: "wait",
      renderer: new PromptBuilderContextRenderer(),
      initialItems,
    });
    const restored = ModelContextSession.restore({
      snapshot: original.snapshot(),
      renderer: new PromptBuilderContextRenderer(),
    });

    expect(restored.snapshot()).toEqual(original.snapshot());
    expect(restored.prepareModelTurn()).toEqual(original.prepareModelTurn());
  });

  it("uses an explicit renderer dependency for deterministic unit tests", () => {
    const renderer: ModelContextRenderer = {
      render(input) {
        return [
          {
            role: "system",
            content: `${input.task}:${input.items.length}:${input.transientReminders?.join(",") ?? ""}`,
          },
        ];
      },
    };
    const session = ModelContextSession.create({
      task: "task",
      renderer,
      initialItems: [{ type: "environment_reminder", content: "x" }],
    });

    expect(
      session.prepareModelTurn({ transientReminders: ["a", "b"] }).messages,
    ).toEqual([{ role: "system", content: "task:1:a,b" }]);
  });

  it("compacts model context through an explicit context-window port", async () => {
    const session = ModelContextSession.create({
      task: "compact",
      renderer: new PromptBuilderContextRenderer(),
      initialItems: [
        {
          type: "environment_reminder",
          content: "Environment reminder:\n[user@default] old",
        },
        { type: "environment_reminder", content: "recent" },
      ],
    });

    const compaction = await session.compactIfNeeded({
      stepIndex: 4,
      contextWindow: new DeterministicModelContextCompactor({
        maxTokens: 1,
        recentItemCount: 1,
        now: () => "2026-06-01T00:00:00.000Z",
      }),
    });

    expect(compaction).toMatchObject({
      tokenCount: expect.any(Number),
      maxTokens: 1,
      originalItemCount: 2,
      retainedItemCount: 1,
      droppedItemCount: 1,
    });
    expect(compaction?.items).toHaveLength(2);
    expect(compaction?.items[0]).toMatchObject({
      type: "environment_reminder",
      content: expect.stringContaining(
        "Compression timestamp: 2026-06-01T00:00:00.000Z",
      ),
    });
    expect(session.snapshot().items).toEqual(compaction?.items);
  });

  it("does not compact below the context-window threshold", async () => {
    const session = ModelContextSession.create({
      task: "small",
      renderer: new PromptBuilderContextRenderer(),
      initialItems: [{ type: "environment_reminder", content: "small" }],
    });
    const before = session.snapshot();
    const compaction = await session.compactIfNeeded({
      stepIndex: 1,
      contextWindow: {
        maxTokens: 100,
        countTokens: () => 10,
        compact: () => {
          throw new Error("should not compact below threshold");
        },
      },
    });

    expect(compaction).toBeUndefined();
    expect(session.snapshot()).toEqual(before);
  });

  it("maps model-context items to legacy prompt history entries at the adapter boundary", () => {
    const entries = modelContextItemsToHistoryEntries([
      {
        type: "io_wait_call",
        toolCallId: "wait-1",
        wait: {
          reason: "done",
          condition: { kind: "new_user_message", channel: "default" },
        },
        thinking: { content: "Pause." },
      },
    ]);

    expect(entries).toEqual([
      {
        role: "assistant_tool_call",
        toolCallId: "wait-1",
        name: "io_wait",
        arguments: {
          reason: "done",
          condition: { kind: "new_user_message", channel: "default" },
        },
        thinking: "Pause.",
      },
    ]);
  });
});
