import { describe, it, expect } from "vitest";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";
import type {
  RunEvent,
  AgentRunStateData,
} from "../src/types/run.js";
import type {
  InternalToolCall,
  FimStepOutput,
  ModelTurn,
} from "../src/types/model.js";
import type { ToolRequest, ToolReviewDecision, ToolCallValidation, AgentObservation } from "../src/types/tools.js";
import type { BashObservation } from "../src/types/bash.js";
import type { IoWaitRequest, UserMessage, AgentMessage, EnvironmentEvent } from "../src/types/environment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00Z";
const LATER = "2026-01-01T00:00:01Z";

function makeToolCall(id = "tc-1"): InternalToolCall {
  return { id, name: "bash", arguments: { session: "default", command: "echo hi" } };
}

function makeThinking() {
  return { content: "thinking about it" };
}

function makeToolCallTurn(tc?: InternalToolCall): ModelTurn {
  const toolCall = tc ?? makeToolCall();
  return { kind: "tool_call", toolCall, thinking: makeThinking(), rawDecision: "tool_call" };
}

function makeToolCallOutput(tc?: InternalToolCall): FimStepOutput {
  const turn = makeToolCallTurn(tc);
  return { thinking: makeThinking(), rawDecision: "tool_call", turn };
}

function makeIoWaitTurn(): ModelTurn {
  const wait: IoWaitRequest = { reason: "need input", condition: { kind: "new_user_message", channel: "cli" } };
  return { kind: "io_wait", wait, thinking: makeThinking(), rawDecision: "io_wait" };
}

function makeIoWaitOutput(): FimStepOutput {
  const turn = makeIoWaitTurn();
  return { thinking: makeThinking(), rawDecision: "io_wait", turn };
}

function makeInvalidTurn(): ModelTurn {
  return { kind: "invalid_output", message: "bad output" };
}

function makeInvalidOutput(): FimStepOutput {
  return { thinking: makeThinking(), rawDecision: "not json", turn: makeInvalidTurn() };
}

function makeCommandRequest(id = "tc-1"): ToolRequest {
  return { kind: "command", toolName: "bash", toolCallId: id, session: "default", command: "echo hi", timeoutMs: 30000 };
}

function makeApproval(): ToolReviewDecision {
  return { status: "approved", reason: "ok", reviewer: "test" };
}

function makeRejection(): ToolReviewDecision {
  return { status: "rejected", reason: "nope", reviewer: "test" };
}

function makeBashObservation(rc = 0): BashObservation {
  return { session: "default", state: "idle", returnCode: rc, output: "hi\n", outputTruncated: false, outputLogPath: "/tmp/log.txt" };
}

function makeTimedOutBashObservation(): BashObservation {
  return {
    session: "default",
    state: "running",
    returnCode: null,
    timedOut: true,
    focusReleased: true,
    output: "partial output\n",
    outputTruncated: false,
    outputLogPath: "/tmp/log.txt",
  };
}

function makeBusyBashObservation(): BashObservation {
  return {
    session: "default",
    state: "running",
    returnCode: null,
    output: "",
    outputTruncated: false,
    outputLogPath: "/tmp/log.txt",
    errorCode: "SESSION_BUSY",
    message:
      'Session "default" is already running a command; rejected the new command without writing to the PTY. Use poll, interrupt, terminate, or restart before sending another command.',
  };
}

function makeAgentObservation(): AgentObservation {
  return { kind: "tool_validation", message: "validation error", recoverable: true };
}

function makeUserMessage(): UserMessage {
  return { id: "msg-1", channel: "cli", role: "user", text: "hello", createdAt: NOW };
}

function makeAgentMessage(kind: "status" | "error" = "status"): AgentMessage {
  return { channel: "cli", role: "agent", kind, text: "processing...", createdAt: NOW };
}

function makeEnvironmentEvent(): EnvironmentEvent {
  return { id: "ev-1", kind: "user_message_received", source: "im", timestamp: NOW, message: makeUserMessage() };
}

function makeIoWait(): IoWaitRequest {
  return { reason: "need input", condition: { kind: "new_user_message", channel: "cli" } };
}

/** Create a fresh builder and apply run_started so header is initialized. */
function builderWithRunStarted(): ViewModelBuilder {
  const b = new ViewModelBuilder();
  b.applyEvent({
    type: "run_started",
    runId: "run-1",
    task: "test",
    cwd: "/tmp",
    maxSteps: 10,
    timestamp: NOW,
  });
  return b;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ViewModelBuilder", () => {
  // 1
  it("run_started sets header and creates environment LoopFrame", () => {
    const b = new ViewModelBuilder();
    b.applyEvent({
      type: "run_started",
      runId: "run-1",
      task: "test task",
      cwd: "/tmp",
      maxSteps: 10,
      timestamp: NOW,
    });
    const vm = b.getViewModel();
    expect(vm.run.runId).toBe("run-1");
    expect(vm.run.status).toBe("running");
    expect(vm.run.cwd).toBe("/tmp");
    expect(vm.run.maxSteps).toBe(10);
    expect(vm.run.startedAt).toBe(NOW);
    expect(vm.loop).toHaveLength(1);
    expect(vm.loop[0].phase).toBe("environment");
    expect(vm.loop[0].status).toBe("ok");
    expect(vm.loop[0].title).toBe("run started");
    expect(vm.loop[0].summary).toContain("test task");
  });

  // 2
  it("model_requested creates model LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({ type: "model_requested", stepIndex: 1, timestamp: LATER });
    const vm = b.getViewModel();
    expect(vm.run.stepIndex).toBe(1);
    expect(vm.run.status).toBe("waiting_for_model");
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("model");
    expect(frame.status).toBe("running");
    expect(frame.title).toBe("model requested");
  });

  // 3
  it("model_output_received tool_call creates decision LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(),
      turn: makeToolCallTurn(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("decision");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("tool call: bash");
    expect(frame.summary).toContain("session=default");
    expect(frame.summary).toContain("echo hi");
    expect(frame.detail).toContain("## tool call");
    expect(frame.detail).toContain('"command": "echo hi"');
    expect(frame.detail).toContain("## thinking");
  });

  it("model_output_received completes the matching model LoopFrame with thinking detail", () => {
    const b = builderWithRunStarted();
    b.applyEvent({ type: "model_requested", stepIndex: 0, timestamp: NOW });
    b.applyEvent({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(),
      turn: makeToolCallTurn(),
      timestamp: LATER,
    });

    const vm = b.getViewModel();
    const modelFrame = vm.loop.find(
      (frame) => frame.stepIndex === 0 && frame.phase === "model",
    );

    expect(modelFrame).toBeDefined();
    expect(modelFrame!.status).toBe("ok");
    expect(modelFrame!.title).toBe("model completed");
    expect(modelFrame!.summary).toContain("decision=tool_call");
    expect(modelFrame!.detail).toContain("## thinking");
    expect(modelFrame!.detail).toContain("thinking about it");
    expect(modelFrame!.detail).toContain("## raw decision");
    expect(modelFrame!.detail).toContain("## turn");
  });

  // 5
  it("model_output_received io_wait creates io_wait LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "model_output_received",
      stepIndex: 0,
      output: makeIoWaitOutput(),
      turn: makeIoWaitTurn(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("io_wait");
    expect(frame.status).toBe("waiting");
    expect(frame.title).toBe("io wait requested");
  });

  // 6
  it("model_output_received invalid_output creates warn decision LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "model_output_received",
      stepIndex: 0,
      output: makeInvalidOutput(),
      turn: makeInvalidTurn(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("decision");
    expect(frame.status).toBe("warn");
    expect(frame.title).toBe("invalid model output");
    expect(frame.summary).toBe("bad output");
  });

  it("model_output_received invalid_output compacts long diagnostic detail", () => {
    const b = builderWithRunStarted();
    const longRawDecision = `bash">\n${"x".repeat(5000)}`;
    const turn: ModelTurn = {
      kind: "invalid_output",
      message: "Malformed DSML tool call: unclosed DSML parameter tag.",
      rawDecision: longRawDecision,
      thinking: { content: "thinking" },
    };

    b.applyEvent({ type: "model_requested", stepIndex: 0, timestamp: NOW });
    b.applyEvent({
      type: "model_output_received",
      stepIndex: 0,
      output: {
        thinking: { content: "thinking" },
        rawDecision: longRawDecision,
        turn,
      },
      turn,
      timestamp: LATER,
    });

    const vm = b.getViewModel();
    const modelFrame = vm.loop.find(
      (frame) => frame.stepIndex === 0 && frame.phase === "model",
    );

    expect(modelFrame?.detail).toContain("unclosed DSML parameter tag");
    expect(modelFrame?.detail).toContain("<truncated");
    expect(modelFrame?.detail).not.toContain("thinking raw");
  });

  // 7
  it("tool_call_validated valid creates ok validation LoopFrame", () => {
    const b = builderWithRunStarted();
    const validResult: ToolCallValidation = { status: "valid", request: makeCommandRequest() };
    b.applyEvent({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: makeToolCall(),
      result: validResult,
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("validation");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("tool call validated");
    expect(frame.detail).toContain("## tool call");
    expect(frame.detail).toContain("## validation result");
    expect(frame.detail).toContain('"request"');
  });

  // 8
  it("tool_call_validated invalid creates warn validation LoopFrame", () => {
    const b = builderWithRunStarted();
    const invalidResult: ToolCallValidation = { status: "invalid", observation: makeAgentObservation() };
    b.applyEvent({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: makeToolCall(),
      result: invalidResult,
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("validation");
    expect(frame.status).toBe("warn");
    expect(frame.title).toBe("tool validation failed");
    expect(frame.summary).toBe("validation error");
    expect(frame.detail).toContain("## validation result");
    expect(frame.detail).toContain("validation error");
  });

  // 9
  it("tool_review_requested creates running review LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.run.status).toBe("waiting_for_review");
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("review");
    expect(frame.status).toBe("running");
    expect(frame.title).toBe("review requested");
    expect(frame.detail).toContain("## request");
    expect(frame.detail).toContain('"command": "echo hi"');
  });

  // 10
  it("tool_reviewed approved creates ok review LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("review");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("approved");
    expect(frame.summary).toBe("ok");
    expect(frame.detail).toContain("## request");
    expect(frame.detail).toContain("## decision");
    expect(frame.detail).toContain('"status": "approved"');
  });

  // 11
  it("tool_reviewed rejected creates warn review LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeRejection(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("review");
    expect(frame.status).toBe("warn");
    expect(frame.title).toBe("rejected");
    expect(frame.summary).toBe("nope");
    expect(frame.detail).toContain("## decision");
    expect(frame.detail).toContain('"status": "rejected"');
  });

  // 12
  it("tool_execution_started creates running tool LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_execution_started",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.run.status).toBe("waiting_for_tool");
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("tool");
    expect(frame.status).toBe("running");
    expect(frame.title).toBe("bash started");
    expect(frame.detail).toContain("## request");
    expect(frame.detail).toContain('"timeoutMs": 30000');
  });

  // 13
  it("tool_execution_finished rc=0 creates ok tool LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 0,
      request: makeCommandRequest(),
      observation: makeBashObservation(0),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("tool");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("bash finished rc=0");
    expect(frame.logPath).toBe("/tmp/log.txt");
    expect(frame.detail).toContain("## request");
    expect(frame.detail).toContain("## observation");
    expect(frame.detail).toContain('"returnCode": 0');
    expect(frame.detail).toContain('"outputLogPath": "/tmp/log.txt"');
  });

  // 14
  it("tool_execution_finished rc=1 creates error tool LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 0,
      request: makeCommandRequest(),
      observation: makeBashObservation(1),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("tool");
    expect(frame.status).toBe("error");
    expect(frame.title).toBe("bash finished rc=1");
  });

  it("tool_execution_finished timeout keeps the tool frame waiting instead of error", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 0,
      request: makeCommandRequest(),
      observation: makeTimedOutBashObservation(),
      timestamp: LATER,
    });

    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("tool");
    expect(frame.status).toBe("waiting");
    expect(frame.title).toBe("bash timed out, focus released");
    expect(frame.summary).toBe("session=default still running");
    expect(frame.logPath).toBe("/tmp/log.txt");
    expect(frame.detail).toContain('"timedOut": true');
    expect(frame.detail).toContain('"focusReleased": true');
    expect(frame.detail).toContain('"state": "running"');
  });

  it("tool_execution_finished with bash errorCode shows the actionable message", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "tool_execution_finished",
      stepIndex: 0,
      request: makeCommandRequest(),
      observation: makeBusyBashObservation(),
      timestamp: LATER,
    });

    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("tool");
    expect(frame.status).toBe("error");
    expect(frame.title).toBe("bash rejected SESSION_BUSY");
    expect(frame.summary).toContain("rejected the new command");
    expect(frame.detail).toContain('"errorCode": "SESSION_BUSY"');
  });

  // 15
  it("observation_appended creates observation LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "observation_appended",
      stepIndex: 0,
      observation: makeAgentObservation(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("observation");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("observation appended");
    expect(frame.detail).toContain("## observation");
    expect(frame.detail).toContain("validation error");
  });

  // 16
  it("io_wait_started creates waiting io_wait LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "io_wait_started",
      stepIndex: 0,
      wait: makeIoWait(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.run.status).toBe("waiting_for_io");
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("io_wait");
    expect(frame.status).toBe("waiting");
    expect(frame.title).toBe("waiting for IO");
    expect(frame.summary).toBe("need input");
    expect(frame.detail).toContain("## wait");
    expect(frame.detail).toContain('"new_user_message"');
  });

  // 17
  it("io_wait_satisfied creates ok io_wait LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "io_wait_satisfied",
      stepIndex: 0,
      wait: makeIoWait(),
      event: makeEnvironmentEvent(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("io_wait");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("IO wait satisfied");
    expect(frame.summary).toContain("event=ev-1");
    expect(frame.summary).toContain("[user@cli] hello");
    expect(frame.detail).toContain('"kind": "user_message_received"');
  });

  // 18
  it("environment_events_consumed creates environment LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "environment_events_consumed",
      runId: "run-1",
      eventIds: ["ev-1", "ev-2", "ev-3"],
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("environment");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("3 events consumed");
    expect(frame.summary).toBe("ev-1, ev-2, ev-3");
    expect(frame.detail).toContain("## event ids");
    expect(frame.detail).toContain("ev-2");
  });

  // 19
  it("agent_message_sent creates agent ConversationItem", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "agent_message_sent",
      runId: "run-1",
      message: makeAgentMessage("status"),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.conversation).toHaveLength(1);
    const item = vm.conversation[0];
    expect(item.kind).toBe("agent");
    if (item.kind === "agent") {
      expect(item.messageKind).toBe("status");
      expect(item.text).toBe("processing...");
    }
  });

  // 20
  it("user_message_received creates user ConversationItem", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "user_message_received",
      runId: "run-1",
      message: makeUserMessage(),
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.conversation).toHaveLength(1);
    const item = vm.conversation[0];
    expect(item.kind).toBe("user");
    if (item.kind === "user") {
      expect(item.channel).toBe("cli");
      expect(item.text).toBe("hello");
      expect(item.sourceEventId).toBe("msg-1");
    }
  });

  it("sorts conversation items by timestamp with stable insertion order for ties", () => {
    const b = builderWithRunStarted();
    b.addImUserMessage({
      id: "late-user",
      channel: "cli",
      role: "user",
      text: "late",
      createdAt: "2026-01-01T00:00:03Z",
    });
    b.addImAgentMessage({
      channel: "cli",
      role: "agent",
      kind: "status",
      text: "early agent",
      createdAt: "2026-01-01T00:00:01Z",
    });
    b.addImUserMessage({
      id: "early-user",
      channel: "cli",
      role: "user",
      text: "early user",
      createdAt: "2026-01-01T00:00:01Z",
    });

    expect(b.getViewModel().conversation.map((item) => item.text)).toEqual([
      "early agent",
      "early user",
      "late",
    ]);
  });

  it("deduplicates user and agent messages across transcript and IM sources", () => {
    const b = builderWithRunStarted();
    const user = makeUserMessage();
    const agent = makeAgentMessage();

    b.applyEvent({
      type: "user_message_received",
      runId: "run-1",
      message: user,
      timestamp: user.createdAt,
    });
    b.addImUserMessage(user);
    b.applyEvent({
      type: "agent_message_sent",
      runId: "run-1",
      message: agent,
      timestamp: agent.createdAt,
    });
    b.addImAgentMessage(agent);

    expect(b.getViewModel().conversation.map((item) => item.text)).toEqual([
      "hello",
      "processing...",
    ]);
  });

  // 21
  it("run_finished creates environment LoopFrame and updates header", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "run_finished",
      status: "cancelled",
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.run.status).toBe("cancelled");
    expect(vm.run.updatedAt).toBe(LATER);
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.phase).toBe("environment");
    expect(frame.status).toBe("ok");
    expect(frame.title).toBe("run finished");
    expect(frame.summary).toBe("cancelled");
  });

  // 21b - run_finished with failure
  it("run_finished failed creates error LoopFrame", () => {
    const b = builderWithRunStarted();
    b.applyEvent({
      type: "run_finished",
      status: "failed",
      error: { message: "boom" },
      timestamp: LATER,
    });
    const vm = b.getViewModel();
    expect(vm.run.status).toBe("failed");
    const frame = vm.loop[vm.loop.length - 1];
    expect(frame.status).toBe("error");
    expect(frame.summary).toBe("failed");
  });

  // 22
  it("enforces maxConversationItems limit", () => {
    const b = new ViewModelBuilder({ maxConversationItems: 3 });
    b.applyEvent({
      type: "run_started",
      runId: "run-1",
      task: "test",
      cwd: "/tmp",
      maxSteps: 10,
      timestamp: NOW,
    });
    for (let i = 0; i < 5; i++) {
      b.applyEvent({
        type: "user_message_received",
        runId: "run-1",
        message: { id: `msg-${i}`, channel: "cli", role: "user", text: `msg ${i}`, createdAt: NOW },
        timestamp: NOW,
      });
    }
    const vm = b.getViewModel();
    expect(vm.conversation).toHaveLength(3);
    // Should keep the latest 3 after timestamp/order sorting.
    if (vm.conversation[0].kind === "user") {
      expect(vm.conversation[0].text).toBe("msg 2");
    }
  });

  // 23
  it("enforces maxLoopFrames limit", () => {
    const b = new ViewModelBuilder({ maxLoopFrames: 3 });
    b.applyEvent({
      type: "run_started",
      runId: "run-1",
      task: "test",
      cwd: "/tmp",
      maxSteps: 10,
      timestamp: NOW,
    });
    // run_started already adds 1 frame, add 4 more
    for (let i = 0; i < 4; i++) {
      b.applyEvent({ type: "model_requested", stepIndex: i, timestamp: NOW });
    }
    const vm = b.getViewModel();
    expect(vm.loop).toHaveLength(3);
    // Should be the last 3 frames
    expect(vm.loop[0].title).toBe("model requested");
  });

  // 24
  it("applyState updates header", () => {
    const b = new ViewModelBuilder();
    const state: AgentRunStateData = {
      runId: "run-2",
      status: "waiting_for_model",
      task: "some task",
      cwd: "/home",
      createdAt: NOW,
      updatedAt: LATER,
      stepIndex: 5,
      maxSteps: 20,
      transcriptPath: "/tmp/transcript.jsonl",
    };
    b.applyState(state);
    const vm = b.getViewModel();
    expect(vm.run.runId).toBe("run-2");
    expect(vm.run.status).toBe("waiting_for_model");
    expect(vm.run.stepIndex).toBe(5);
    expect(vm.run.maxSteps).toBe(20);
    expect(vm.run.cwd).toBe("/home");
    expect(vm.run.startedAt).toBe(NOW);
    expect(vm.run.updatedAt).toBe(LATER);
  });
});
