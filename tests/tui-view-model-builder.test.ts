import { describe, expect, it } from "vitest";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";
import type {
  AgentRunStateData,
  RunEvent,
} from "../src/types/run.js";
import type {
  FimStepOutput,
  InternalToolCall,
  ModelTurn,
} from "../src/types/model.js";
import type {
  AgentObservation,
  ToolName,
  ToolRequest,
  ToolReviewDecision,
} from "../src/types/tools.js";
import type {
  EnvironmentEvent,
  IoWaitRequest,
  UserMessage,
  AgentMessage,
} from "../src/types/environment.js";
import type {
  SessionListObservation,
  TerminalObservation,
  TerminalState,
  TerminalToolRequest,
} from "../src/terminal/types.js";

const NOW = "2026-01-01T00:00:00Z";
const LATER = "2026-01-01T00:00:01Z";

function builderWithRunStarted(): ViewModelBuilder {
  const builder = new ViewModelBuilder();
  builder.applyEvent({
    type: "run_started",
    runId: "run-1",
    task: "test task",
    cwd: "/repo",
    timestamp: NOW,
  });
  return builder;
}

function terminal(
  inputSeq: number,
  overrides: Partial<TerminalState> = {},
): TerminalState {
  return {
    inputSeq,
    alive: true,
    syncStatus: { kind: "trusted" },
    lastShellPrompt: {
      cwd: "/repo",
      promptSeq: 2,
      lastReturnCode: 0,
    },
    lastContinuationPrompt: null,
    termination: null,
    foregroundProcess: null,
    ...overrides,
  };
}

function toolCall(
  name: ToolName = "terminal_write",
  args: InternalToolCall["arguments"] = {
    expectedInputSeq: 2,
    text: "echo hi\n",
  },
): InternalToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: args,
  };
}

function thinking() {
  return { content: "thinking about it", raw: "raw thinking" };
}

function toolCallTurn(call = toolCall()): ModelTurn {
  return {
    kind: "tool_call",
    toolCall: call,
    thinking: thinking(),
    rawDecision: "tool decision",
    raw: { raw: true },
  };
}

function toolCallOutput(call = toolCall()): FimStepOutput {
  const turn = toolCallTurn(call);
  return {
    thinking: thinking(),
    rawDecision: "tool decision",
    turn,
    usage: { total_tokens: 12 },
  };
}

function invalidOutput(): FimStepOutput {
  return {
    thinking: thinking(),
    rawDecision: "not a valid tool decision",
    turn: {
      kind: "invalid_output",
      message: "bad output",
      diagnostic: {
        code: "expected_v4_dsml",
        severity: "error",
        message: "bad output",
        recoverable: true,
      },
      thinking: thinking(),
      rawDecision: "not a valid tool decision",
      raw: "<raw>",
    },
  };
}

function ioWait(): IoWaitRequest {
  return {
    reason: "need input",
    condition: { kind: "new_user_message", channel: "cli" },
  };
}

function ioWaitOutput(): FimStepOutput {
  const turn: ModelTurn = {
    kind: "io_wait",
    wait: ioWait(),
    thinking: thinking(),
    rawDecision: "wait decision",
  };
  return {
    thinking: thinking(),
    rawDecision: "wait decision",
    turn,
  };
}

function request(
  toolName: ToolName = "terminal_write",
  terminalRequest: TerminalToolRequest = {
    kind: "terminal_write",
    expectedInputSeq: 2,
    text: "pwd\n",
  },
): ToolRequest {
  return {
    kind: "terminal_tool",
    toolName,
    toolCallId: `request-${toolName}`,
    request: terminalRequest,
  };
}

function terminalObservation(
  overrides: Partial<TerminalObservation> = {},
): TerminalObservation {
  return {
    currentSession: "default",
    observedSession: "default",
    terminal: terminal(3),
    request: "terminal_write",
    result: "ok",
    returnedToPrompt: true,
    screen: {
      text: "pwd\n/repo\n",
      rows: 24,
      cols: 80,
      truncated: false,
      logRef: { path: "terminal-log://default" },
    },
    ...overrides,
  };
}

function sessionListObservation(): SessionListObservation {
  return {
    currentSession: "build",
    sessions: [
      {
        session: "default",
        terminal: terminal(5),
        outputLog: { kind: "log", ref: "terminal-log://default" },
      },
      {
        session: "build",
        terminal: terminal(8, { foregroundProcess: "npm test" }),
        outputLog: { kind: "log", ref: "terminal-log://build" },
      },
    ],
  };
}

function approval(): ToolReviewDecision {
  return { status: "approved", reason: "ok", reviewer: "test" };
}

function agentObservation(): AgentObservation {
  return {
    kind: "tool_validation",
    message: "validation error",
    recoverable: true,
  };
}

function userMessage(
  id = "msg-1",
  timestamp = NOW,
  text = "hello",
): UserMessage {
  return { id, channel: "cli", role: "user", text, createdAt: timestamp };
}

function agentMessage(
  kind: "status" | "error" = "status",
  timestamp = NOW,
): AgentMessage {
  return {
    channel: "cli",
    role: "agent",
    kind,
    text: "processing...",
    createdAt: timestamp,
  };
}

function environmentEvent(): EnvironmentEvent {
  return {
    id: "ev-1",
    kind: "user_message_received",
    source: "im",
    timestamp: NOW,
    message: userMessage(),
  };
}

function findFrame(builder: ViewModelBuilder, title: string) {
  return builder.getViewModel().loop.find((frame) => frame.title === title);
}

describe("ViewModelBuilder", () => {
  it("projects run lifecycle into header and loop frames", () => {
    const builder = builderWithRunStarted();

    builder.applyEvent({
      type: "run_resumed",
      runId: "run-1",
      previousStatus: "waiting_for_io",
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    expect(view.run).toMatchObject({
      runId: "run-1",
      status: "running",
      stepIndex: 0,
      cwd: "/repo",
      startedAt: NOW,
      updatedAt: LATER,
    });
    expect(view.loop.map((frame) => frame.title)).toEqual([
      "run started",
      "run resumed",
    ]);
    expect(view.loop[0]!.summary).toContain("test task");
  });

  it("applies persisted run state explicitly", () => {
    const builder = new ViewModelBuilder();
    const state: AgentRunStateData = {
      runId: "run-2",
      status: "waiting_for_io",
      task: "task",
      cwd: "/repo",
      createdAt: NOW,
      updatedAt: LATER,
      stepIndex: 7,
      transcriptPath: "/tmp/transcript.jsonl",
    };

    builder.applyState(state);

    expect(builder.getViewModel().run).toMatchObject({
      runId: "run-2",
      status: "waiting_for_io",
      stepIndex: 7,
      cwd: "/repo",
      startedAt: NOW,
      updatedAt: LATER,
    });
  });

  it("streams and completes model thinking detail", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "model_requested",
      stepIndex: 1,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "model_thinking_delta",
      stepIndex: 1,
      delta: "abc",
      sequence: 1,
      timestamp: LATER,
    });

    expect(findFrame(builder, "model thinking")).toMatchObject({
      phase: "model",
      status: "running",
      summary: "thinking... 3 chars",
    });
    expect(findFrame(builder, "model thinking")!.detail).toContain("abc");
    builder.applyEvent({
      type: "model_thinking_delta",
      stepIndex: 1,
      delta: "de",
      sequence: 2,
      timestamp: LATER,
    });
    expect(findFrame(builder, "model thinking")).toMatchObject({
      summary: "thinking... 5 chars",
    });
    expect(findFrame(builder, "model thinking")!.detail).toContain("abcde");

    builder.applyEvent({
      type: "model_output_received",
      stepIndex: 1,
      output: toolCallOutput(),
      turn: toolCallTurn(),
      timestamp: LATER,
    });

    const modelFrame = builder.getViewModel().loop.find(
      (frame) => frame.phase === "model" && frame.stepIndex === 1,
    );
    expect(modelFrame).toMatchObject({
      title: "model completed",
      status: "ok",
    });
    expect(modelFrame!.detail).toContain("## thinking");
    expect(modelFrame!.detail).toContain("## raw decision");
    expect(modelFrame!.detail).not.toContain("⬤");
  });

  it("renders final model thinking detail when no thinking deltas were recorded", () => {
    const builder = builderWithRunStarted();
    const call = toolCall();
    const finalThinking = {
      content: "final thinking from model output",
      raw: {
        traceRef: {
          path: "/repo/.tiny-agent/runs/run-1/debug/thinking/step-0002-thinking.trace.txt",
          relativePath: "debug/thinking/step-0002-thinking.trace.txt",
          bytes: 42,
          sha256: "abc123",
        },
      },
    };
    const turn: ModelTurn = {
      ...toolCallTurn(call),
      thinking: finalThinking,
    };
    const output: FimStepOutput = {
      thinking: finalThinking,
      rawDecision: "tool decision",
      turn,
      usage: { total_tokens: 12 },
    };

    builder.applyEvent({
      type: "model_requested",
      stepIndex: 2,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "model_output_received",
      stepIndex: 2,
      output,
      turn,
      timestamp: LATER,
    });

    const modelFrame = builder.getViewModel().loop.find(
      (frame) => frame.phase === "model" && frame.stepIndex === 2,
    );
    expect(modelFrame).toMatchObject({
      title: "model completed",
      status: "ok",
      summary: expect.stringContaining("decision=tool_call"),
    });
    expect(modelFrame!.detail).toContain("final thinking from model output");
    expect(modelFrame!.detail).toContain("traceRef");
    expect(modelFrame!.detail).toContain("step-0002-thinking.trace.txt");
  });

  it("summarizes current terminal/session tool calls", () => {
    const cases: Array<[ToolName, InternalToolCall["arguments"], string[]]> = [
      [
        "terminal_write",
        { expectedInputSeq: 2, text: "echo hi\n", waitForReturnMs: 30 },
        ["tool=terminal_write", "inputSeq=2", "bytes=8", "waitMs=30"],
      ],
      [
        "terminal_key",
        { expectedInputSeq: 3, key: "enter", waitForReturnMs: 10 },
        ["tool=terminal_key", "key=enter", "inputSeq=3", "waitMs=10"],
      ],
      [
        "session_observe",
        { session: "build" },
        ["tool=session_observe", "session=build"],
      ],
      ["session_list", {}, ["tool=session_list"]],
      [
        "session_focus",
        { session: "build", create: true, cwd: "/repo" },
        ["tool=session_focus", "session=build", "create=true", "cwd=/repo"],
      ],
      [
        "session_interrupt",
        { expectedInputSeq: 4, waitForReturnMs: 100 },
        ["tool=session_interrupt", "inputSeq=4", "waitMs=100"],
      ],
      [
        "session_restart",
        { session: "build", cwd: "/repo", reason: "recover" },
        ["tool=session_restart", "session=build", "cwd=/repo", "reason=recover"],
      ],
      [
        "session_terminate",
        { session: "build", reason: "done" },
        ["tool=session_terminate", "session=build", "reason=done"],
      ],
    ];

    for (const [name, args, expectedParts] of cases) {
      const builder = builderWithRunStarted();
      const call = toolCall(name, args);
      builder.applyEvent({
        type: "model_output_received",
        stepIndex: 1,
        output: toolCallOutput(call),
        turn: toolCallTurn(call),
        timestamp: NOW,
      });

      const decisionFrame = builder.getViewModel().loop.at(-1)!;
      expect(decisionFrame.title).toBe(`tool call: ${name}`);
      for (const part of expectedParts) {
        expect(decisionFrame.summary).toContain(part);
      }
      expect(decisionFrame.detail).toContain("## tool call");
    }
  });

  it("keeps invalid model output detail visible", () => {
    const builder = builderWithRunStarted();
    const output = invalidOutput();

    builder.applyEvent({
      type: "model_output_received",
      stepIndex: 2,
      output,
      turn: output.turn,
      timestamp: NOW,
    });

    const frames = builder.getViewModel().loop;
    const decisionFrame = frames.at(-1)!;
    expect(decisionFrame).toMatchObject({
      phase: "decision",
      status: "warn",
      title: "invalid model output",
      summary: "bad output",
    });
    expect(decisionFrame.detail).toContain("not a valid tool decision");
    expect(decisionFrame.detail).toContain("bad output");
    expect(decisionFrame.detail).toContain("expected_v4_dsml");
  });

  it("projects validation and review events with detail", () => {
    const builder = builderWithRunStarted();
    const call = toolCall();
    const toolRequest = request();

    builder.applyEvent({
      type: "tool_call_validated",
      stepIndex: 1,
      toolCall: call,
      result: { status: "invalid", observation: agentObservation() },
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_review_requested",
      stepIndex: 1,
      request: toolRequest,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_reviewed",
      stepIndex: 1,
      request: toolRequest,
      decision: approval(),
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    expect(view.loop.at(-3)).toMatchObject({
      phase: "validation",
      status: "warn",
      title: "tool validation failed",
      summary: "validation error",
    });
    expect(view.loop.at(-2)!.detail).toContain("terminal_write");
    expect(view.loop.at(-1)).toMatchObject({
      phase: "review",
      status: "ok",
      title: "approved",
      summary: "ok",
    });
  });

  it("projects terminal observation frames and session cards", () => {
    const builder = builderWithRunStarted();
    const toolRequest = request();
    const observation = terminalObservation();

    builder.applyEvent({
      type: "tool_execution_started",
      stepIndex: 1,
      request: toolRequest,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 1,
      request: toolRequest,
      observation,
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    const started = view.loop.at(-2)!;
    const finished = view.loop.at(-1)!;
    expect(started).toMatchObject({
      phase: "tool",
      status: "running",
      title: "terminal_write started",
    });
    expect(finished).toMatchObject({
      phase: "tool",
      status: "ok",
      title: "terminal_write ok",
      logPath: "terminal-log://default",
    });
    expect(finished.summary).toContain("request=terminal_write");
    expect(finished.summary).toContain("session=default");
    expect(finished.summary).toContain("inputSeq=3");
    expect(finished.summary).toContain("returnedToPrompt=true");
    expect(finished.detail).toContain("pwd\\n/repo\\n");
    expect(finished.detail).toContain("terminal-log://default");
    expect(view.sessions).toEqual([
      {
        session: "default",
        state: "idle",
        returnCode: 0,
        logPath: "terminal-log://default",
        tail: "pwd\n/repo\n",
        screenRows: 24,
        screenCols: 80,
        updatedAt: LATER,
      },
    ]);
  });

  it("applies live session log tail updates without changing runtime facts", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 1,
      request: request(),
      observation: terminalObservation({
        terminal: terminal(3, { foregroundProcess: "npm test" }),
      }),
      timestamp: NOW,
    });

    builder.applySessionLogTails([
      {
        session: "default",
        logPath: "terminal-log://default",
        tail: "latest live log output\n",
        tailOffset: 2048,
        updatedAt: LATER,
      },
    ]);

    expect(builder.getViewModel().sessions).toEqual([
      {
        session: "default",
        state: "running",
        currentCommand: "npm test",
        returnCode: 0,
        logPath: "terminal-log://default",
        tail: "latest live log output\n",
        tailOffset: 2048,
        screenRows: 24,
        screenCols: 80,
        updatedAt: LATER,
      },
    ]);
  });

  it("marks terminal timeout and rejected observations distinctly", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 1,
      request: request("terminal_key", {
        kind: "terminal_key",
        expectedInputSeq: 3,
        key: "enter",
      }),
      observation: terminalObservation({
        request: "terminal_key",
        result: "timeout",
        returnedToPrompt: false,
        screen: {
          text: "still running",
          rows: 24,
          cols: 80,
          truncated: true,
          logRef: { path: "terminal-log://default" },
        },
      }),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 2,
      request: request("session_interrupt", {
        kind: "session_interrupt",
        expectedInputSeq: 4,
      }),
      observation: terminalObservation({
        request: "session_interrupt",
        result: "rejected",
        errorCode: "TERMINAL_UNSYNCED",
        message: "Terminal state is unsynced.",
        terminal: terminal(4, {
          syncStatus: { kind: "unsynced", reason: "state_gap" },
        }),
      }),
      timestamp: LATER,
    });

    const timeoutFrame = builder.getViewModel().loop.at(-2)!;
    const rejectedFrame = builder.getViewModel().loop.at(-1)!;
    expect(timeoutFrame.status).toBe("waiting");
    expect(timeoutFrame.summary).toContain("screen=truncated");
    expect(rejectedFrame).toMatchObject({
      status: "warn",
      title: "session_interrupt rejected TERMINAL_UNSYNCED",
    });
    expect(rejectedFrame.summary).toContain("sync=unsynced:state_gap");
    expect(rejectedFrame.summary).toContain("Terminal state is unsynced.");
  });

  it("projects session list observations into session cards", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 1,
      request: request("session_list", { kind: "session_list" }),
      observation: sessionListObservation(),
      timestamp: NOW,
    });

    const view = builder.getViewModel();
    expect(view.loop.at(-1)).toMatchObject({
      phase: "tool",
      status: "ok",
      title: "session_list finished",
      summary: "currentSession=build sessions=2",
    });
    expect(view.sessions).toEqual([
      {
        session: "default",
        state: "idle",
        returnCode: 0,
        logPath: "terminal-log://default",
        tail: "",
        updatedAt: NOW,
      },
      {
        session: "build",
        state: "running",
        currentCommand: "npm test",
        returnCode: 0,
        logPath: "terminal-log://build",
        tail: "",
        updatedAt: NOW,
      },
    ]);
  });

  it("redacts large terminal_write text in frame details", () => {
    const builder = builderWithRunStarted();
    const largeText = `${"a".repeat(512)}\n`;
    const toolRequest = request("terminal_write", {
      kind: "terminal_write",
      expectedInputSeq: 5,
      text: largeText,
    });
    const call = toolCall("terminal_write", {
      expectedInputSeq: 5,
      text: largeText,
    });

    builder.applyEvent({
      type: "model_output_received",
      stepIndex: 1,
      output: toolCallOutput(call),
      turn: toolCallTurn(call),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_execution_started",
      stepIndex: 1,
      request: toolRequest,
      timestamp: LATER,
    });

    const decisionFrame = builder.getViewModel().loop.at(-2)!;
    const startedFrame = builder.getViewModel().loop.at(-1)!;
    expect(decisionFrame.detail).toContain(
      "[redacted terminal_write payload 513 bytes]",
    );
    expect(startedFrame.detail).toContain(
      "[redacted terminal_write payload 513 bytes]",
    );
    expect(`${decisionFrame.detail}\n${startedFrame.detail}`).not.toContain(
      "aaaaaaaaaa",
    );
  });

  it("projects generic agent observations without terminal assumptions", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 1,
      request: request(),
      observation: agentObservation(),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "observation_appended",
      stepIndex: 1,
      observation: agentObservation(),
      timestamp: LATER,
    });

    expect(builder.getViewModel().loop.at(-2)).toMatchObject({
      phase: "tool",
      status: "ok",
      title: "terminal_write finished",
      summary: "validation error",
    });
    expect(builder.getViewModel().loop.at(-1)).toMatchObject({
      phase: "observation",
      status: "ok",
      title: "observation appended",
    });
  });

  it("projects io wait and environment events", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "model_output_received",
      stepIndex: 1,
      output: ioWaitOutput(),
      turn: ioWaitOutput().turn,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "io_wait_started",
      stepIndex: 1,
      wait: ioWait(),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "io_wait_satisfied",
      stepIndex: 1,
      wait: ioWait(),
      event: environmentEvent(),
      timestamp: LATER,
    });
    builder.applyEvent({
      type: "environment_events_consumed",
      runId: "run-1",
      eventIds: ["ev-1", "ev-2"],
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    expect(view.loop.find((frame) => frame.title === "io wait requested")).toMatchObject({
      phase: "io_wait",
      status: "waiting",
      summary: "need input",
    });
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.summary)
      .toContain("[user@cli] hello");
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.detail)
      .toContain("## wake reason");
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.detail)
      .toContain('"eventLevel": 100');
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.detail)
      .toContain('"minLevel": 10');
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.detail)
      .toContain("## wait");
    expect(view.loop.find((frame) => frame.title === "IO wait satisfied")!.detail)
      .toContain("## event");
    expect(view.loop.at(-1)).toMatchObject({
      phase: "environment",
      title: "2 events consumed",
      summary: "ev-1, ev-2",
    });
  });

  it("keeps conversation sorted by timestamp and deduped by id", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "agent_message_sent",
      runId: "run-1",
      message: agentMessage("status", LATER),
      timestamp: LATER,
    });
    builder.applyEvent({
      type: "user_message_received",
      runId: "run-1",
      message: userMessage("msg-1", NOW, "first"),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "user_message_received",
      runId: "run-1",
      message: userMessage("msg-1", NOW, "first duplicate"),
      timestamp: NOW,
    });

    expect(builder.getViewModel().conversation).toEqual([
      {
        id: "user:msg-1",
        kind: "user",
        timestamp: NOW,
        channel: "cli",
        text: "first",
        sourceEventId: "msg-1",
      },
      {
        id: `agent:${LATER}:status:processing...`,
        kind: "agent",
        timestamp: LATER,
        text: "processing...",
        messageKind: "status",
      },
    ]);
  });

  it("applies conversation and loop limits after projection", () => {
    const builder = new ViewModelBuilder({
      maxConversationItems: 2,
      maxLoopFrames: 3,
    });
    builder.applyEvent({
      type: "run_started",
      runId: "run-1",
      task: "test task",
      cwd: "/repo",
      timestamp: NOW,
    });
    for (let i = 0; i < 5; i++) {
      builder.addImUserMessage(userMessage(`msg-${i}`, NOW, `m${i}`));
      builder.applyEvent({
        type: "model_requested",
        stepIndex: i,
        timestamp: NOW,
      });
    }

    const view = builder.getViewModel();
    expect(view.conversation.map((item) => item.id)).toEqual([
      "user:msg-3",
      "user:msg-4",
    ]);
    expect(view.loop).toHaveLength(3);
    expect(view.loop.map((frame) => frame.stepIndex)).toEqual([2, 3, 4]);
  });

  it("does not truncate conversation items by default", () => {
    const builder = builderWithRunStarted();
    for (let i = 0; i < 205; i++) {
      builder.addImUserMessage(userMessage(`msg-${i}`, NOW, `m${i}`));
    }

    const view = builder.getViewModel();

    expect(view.conversation).toHaveLength(205);
    expect(view.conversation[0]?.id).toBe("user:msg-0");
    expect(view.conversation.at(-1)?.id).toBe("user:msg-204");
  });

  it("projects history compaction and final run state", () => {
    const builder = builderWithRunStarted();
    builder.applyEvent({
      type: "history_compacted",
      stepIndex: 4,
      compaction: {
        tokenCount: 100,
        maxTokens: 80,
        summary: "compressed",
        originalItemCount: 10,
        retainedItemCount: 3,
        droppedItemCount: 7,
      },
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "run_finished",
      status: "failed",
      error: { message: "boom" },
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    expect(view.loop.at(-2)).toMatchObject({
      title: "history compacted",
      summary: "tokens=100/80 dropped=7 retained=3",
      detail: "compressed",
    });
    expect(view.loop.at(-1)).toMatchObject({
      title: "run finished",
      status: "error",
      summary: "failed",
    });
    expect(view.run.status).toBe("failed");
  });
  it("surfaces tool name in pending review summary", () => {
    const builder = builderWithRunStarted();
    const toolRequest = request("terminal_write", {
      kind: "terminal_write",
      expectedInputSeq: 2,
      text: "rm -rf /tmp/test\n",
    });

    builder.applyEvent({
      type: "tool_review_requested",
      stepIndex: 1,
      request: toolRequest,
      timestamp: NOW,
    });

    const reviewFrame = findFrame(builder, "review requested");
    expect(reviewFrame).toMatchObject({
      phase: "review",
      status: "running",
      summary: "tool=terminal_write",
    });
    expect(reviewFrame!.detail).toContain("terminal_write");
  });

  it("exposes reviewDecision on reviewed frames", () => {
    const builder = builderWithRunStarted();
    const toolRequest = request();
    const decision: ToolReviewDecision = {
      status: "rejected",
      reason: "Dangerous command blocked by policy",
      reviewer: "tool-policy",
      warnings: ["Recursive delete detected"],
    };

    builder.applyEvent({
      type: "tool_review_requested",
      stepIndex: 1,
      request: toolRequest,
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_reviewed",
      stepIndex: 1,
      request: toolRequest,
      decision,
      timestamp: LATER,
    });

    const view = builder.getViewModel();
    const reviewedFrame = view.loop.find(
      (frame) => frame.phase === "review" && frame.title === "rejected"
    );
    expect(reviewedFrame).toBeDefined();
    expect(reviewedFrame!.reviewDecision).toEqual(decision);
    expect(reviewedFrame!.reviewDecision!.status).toBe("rejected");
    expect(reviewedFrame!.reviewDecision!.warnings).toEqual(["Recursive delete detected"]);
  });

  it("surfaces warning count in review summary when policy emits warnings", () => {
    const builder = builderWithRunStarted();
    const decision: ToolReviewDecision = {
      status: "approved",
      reason: "Approved with warnings",
      reviewer: "tool-policy",
      warnings: ["Network transfer detected", "Git push detected"],
    };

    builder.applyEvent({
      type: "tool_review_requested",
      stepIndex: 1,
      request: request(),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_reviewed",
      stepIndex: 1,
      request: request(),
      decision,
      timestamp: LATER,
    });

    const reviewedFrame = builder
      .getViewModel()
      .loop.find((frame) => frame.phase === "review" && frame.status === "ok");
    expect(reviewedFrame).toBeDefined();
    expect(reviewedFrame!.summary).toContain("Approved with warnings");
    expect(reviewedFrame!.summary).toContain("warnings=2");
    expect(reviewedFrame!.reviewDecision!.warnings).toHaveLength(2);
  });

  it("omits warnings prefix when review has no warnings", () => {
    const builder = builderWithRunStarted();
    const decision: ToolReviewDecision = {
      status: "approved",
      reason: "Safe command",
      reviewer: "always-approve",
    };

    builder.applyEvent({
      type: "tool_review_requested",
      stepIndex: 1,
      request: request(),
      timestamp: NOW,
    });
    builder.applyEvent({
      type: "tool_reviewed",
      stepIndex: 1,
      request: request(),
      decision,
      timestamp: LATER,
    });

    const reviewedFrame = builder
      .getViewModel()
      .loop.find((frame) => frame.phase === "review" && frame.status === "ok");
    expect(reviewedFrame).toBeDefined();
    expect(reviewedFrame!.summary).toBe("Safe command");
    expect(reviewedFrame!.summary).not.toContain("warnings");
    expect(reviewedFrame!.reviewDecision!.warnings).toBeUndefined();
  });

});
