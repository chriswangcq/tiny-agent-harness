import { describe, it, expect, beforeEach } from "vitest";
import { AgentRunState } from "../src/run/state.js";
import type {
  RunEvent,
  FimStepOutput,
  ModelTurn,
  InternalToolCall,
  ToolRequest,
  ToolReviewDecision,
  BashObservation,
  AgentObservation,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createState(overrides?: Partial<Parameters<typeof AgentRunState.create>[0]>): AgentRunState {
  return AgentRunState.create({
    runId: "test-run",
    task: "test task",
    cwd: "/tmp",
    maxSteps: 10,
    transcriptPath: "/tmp/transcript.jsonl",
    ...overrides,
  });
}

const NOW = "2024-01-01T00:00:00.000Z";

function makeToolCall(id = "tc-1"): InternalToolCall {
  return {
    id,
    name: "bash",
    arguments: { session: "default", command: "echo hi" },
  };
}

function makeThinking() {
  return { content: "thinking about it" };
}

function makeFinalTurn(): ModelTurn {
  return {
    kind: "final",
    content: "done",
    thinking: makeThinking(),
    rawDecision: '{"type":"final","content":"done"}',
  };
}

function makeFinalOutput(): FimStepOutput {
  const turn = makeFinalTurn();
  return {
    thinking: makeThinking(),
    rawDecision: '{"type":"final","content":"done"}',
    turn,
  };
}

function makeToolCallTurn(tc?: InternalToolCall): ModelTurn {
  const toolCall = tc ?? makeToolCall();
  return {
    kind: "tool_call",
    toolCall,
    thinking: makeThinking(),
    rawDecision: '{"type":"tool_call","name":"bash","arguments":{}}',
  };
}

function makeToolCallOutput(tc?: InternalToolCall): FimStepOutput {
  const turn = makeToolCallTurn(tc);
  return {
    thinking: makeThinking(),
    rawDecision: '{"type":"tool_call","name":"bash","arguments":{}}',
    turn,
  };
}

function makeInvalidTurn(): ModelTurn {
  return {
    kind: "invalid_output",
    message: "bad output",
  };
}

function makeInvalidOutput(): FimStepOutput {
  return {
    thinking: makeThinking(),
    rawDecision: "not json",
    turn: makeInvalidTurn(),
  };
}

function makeCommandRequest(id = "tc-1"): ToolRequest {
  return {
    kind: "command",
    toolName: "bash",
    toolCallId: id,
    session: "default",
    command: "echo hi",
    timeoutMs: 30000,
  };
}

function makeApproval(): ToolReviewDecision {
  return {
    status: "approved",
    reason: "ok",
    reviewer: "test",
  };
}

function makeRejection(): ToolReviewDecision {
  return {
    status: "rejected",
    reason: "nope",
    reviewer: "test",
  };
}

function makeBashObservation(): BashObservation {
  return {
    session: "default",
    state: "idle",
    returnCode: 0,
    output: "hi\n",
    outputTruncated: false,
  };
}

/**
 * Helper: advance a created state to running.
 */
function toRunning(state: AgentRunState): AgentRunState {
  return state.apply({
    type: "run_started",
    runId: "test-run",
    task: "test task",
    cwd: "/tmp",
    maxSteps: 10,
    timestamp: NOW,
  });
}

/**
 * Helper: advance to waiting_for_model.
 */
function toWaitingForModel(state: AgentRunState): AgentRunState {
  const running = toRunning(state);
  return running.apply({
    type: "model_requested",
    stepIndex: 0,
    timestamp: NOW,
  });
}

// ===========================================================================
// Tests: Legal Transitions
// ===========================================================================

describe("AgentRunState transitions", () => {
  let initial: AgentRunState;

  beforeEach(() => {
    initial = createState();
  });

  it("created + run_started -> running", () => {
    const running = toRunning(initial);
    expect(running.status).toBe("running");
  });

  it("running + model_requested -> waiting_for_model", () => {
    const running = toRunning(initial);
    const waiting = running.apply({
      type: "model_requested",
      stepIndex: 0,
      timestamp: NOW,
    });
    expect(waiting.status).toBe("waiting_for_model");
  });

  it("waiting_for_model + model_output_received(final) -> completed", () => {
    const waiting = toWaitingForModel(initial);
    const completed = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeFinalOutput(),
      turn: makeFinalTurn(),
      timestamp: NOW,
    });
    expect(completed.status).toBe("completed");
    expect(completed.data.final).toBe("done");
  });

  it("waiting_for_model + model_output_received(tool_call) -> running with pendingToolCall", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    const running = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    expect(running.status).toBe("running");
    expect(running.data.pendingToolCall).toEqual(tc);
  });

  it("waiting_for_model + model_output_received(invalid_output) -> running with pendingModelTurn", () => {
    const waiting = toWaitingForModel(initial);
    const running = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeInvalidOutput(),
      turn: makeInvalidTurn(),
      timestamp: NOW,
    });
    expect(running.status).toBe("running");
    expect(running.data.pendingModelTurn?.kind).toBe("invalid_output");
  });

  it("running + tool_call_validated(valid) -> running with pendingToolRequest", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    const running = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });

    const validated = running.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });

    expect(validated.status).toBe("running");
    expect(validated.data.pendingToolRequest).toBeDefined();
    expect(validated.data.pendingToolCall).toBeUndefined();
  });

  it("running + tool_call_validated(invalid) -> running (synthetic observation path)", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    const running = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });

    const invalidObs: AgentObservation = {
      kind: "tool_validation",
      message: "invalid args",
      recoverable: true,
    };

    const afterInvalid = running.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "invalid", observation: invalidObs },
      timestamp: NOW,
    });

    expect(afterInvalid.status).toBe("running");
    expect(afterInvalid.data.pendingToolCall).toBeUndefined();
    // pendingModelTurn should be set to invalid_output for synthetic observation
    expect(afterInvalid.data.pendingModelTurn?.kind).toBe("invalid_output");
  });

  it("running + tool_review_requested -> waiting_for_review", () => {
    // Get to a state with pendingToolRequest
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });

    const waitingReview = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });

    expect(waitingReview.status).toBe("waiting_for_review");
  });

  it("waiting_for_review + tool_reviewed(approved) -> running with pendingReview", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });

    const approved = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: NOW,
    });

    expect(approved.status).toBe("running");
    expect(approved.data.pendingReview?.status).toBe("approved");
  });

  it("waiting_for_review + tool_reviewed(rejected) -> running with pendingReview", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });

    const rejected = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeRejection(),
      timestamp: NOW,
    });

    expect(rejected.status).toBe("running");
    expect(rejected.data.pendingReview?.status).toBe("rejected");
  });

  it("running + tool_execution_started -> waiting_for_tool", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: NOW,
    });

    const waitingTool = s.apply({
      type: "tool_execution_started",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });

    expect(waitingTool.status).toBe("waiting_for_tool");
  });

  it("waiting_for_tool + tool_execution_finished -> running, stepIndex+1", () => {
    const waiting = toWaitingForModel(initial);
    const tc = makeToolCall();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_execution_started",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });

    const afterExec = s.apply({
      type: "tool_execution_finished",
      stepIndex: 0,
      request: makeCommandRequest(),
      observation: makeBashObservation(),
      timestamp: NOW,
    });

    expect(afterExec.status).toBe("running");
    expect(afterExec.data.stepIndex).toBe(1);
    expect(afterExec.data.pendingToolCall).toBeUndefined();
    expect(afterExec.data.pendingToolRequest).toBeUndefined();
    expect(afterExec.data.pendingReview).toBeUndefined();
  });

  it("running + observation_appended -> running, stepIndex+1", () => {
    const waiting = toWaitingForModel(initial);
    const invalidOutput = makeInvalidOutput();
    let s = waiting.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: invalidOutput,
      turn: makeInvalidTurn(),
      timestamp: NOW,
    });

    // Now state is running with pendingModelTurn of invalid_output
    const obs: AgentObservation = {
      kind: "model_output",
      message: "bad output",
      recoverable: true,
    };
    const afterAppend = s.apply({
      type: "observation_appended",
      stepIndex: 0,
      observation: obs,
      timestamp: NOW,
    });

    expect(afterAppend.status).toBe("running");
    expect(afterAppend.data.stepIndex).toBe(1);
  });

  it("any + run_finished -> terminal", () => {
    const running = toRunning(initial);

    const finished = running.apply({
      type: "run_finished",
      status: "failed",
      error: { message: "something broke" },
      timestamp: NOW,
    });

    expect(finished.status).toBe("failed");
    expect(finished.data.error?.message).toBe("something broke");
  });
});

// ===========================================================================
// Tests: Illegal Transitions
// ===========================================================================

describe("AgentRunState illegal transitions", () => {
  it("completed + model_output_received -> Error", () => {
    let s = createState();
    s = toWaitingForModel(s);
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeFinalOutput(),
      turn: makeFinalTurn(),
      timestamp: NOW,
    });
    expect(s.status).toBe("completed");

    expect(() =>
      s.apply({
        type: "model_output_received",
        stepIndex: 0,
        output: makeFinalOutput(),
        turn: makeFinalTurn(),
        timestamp: NOW,
      }),
    ).toThrow(/Invalid transition/);
  });

  it("waiting_for_tool + model_output_received -> Error", () => {
    let s = createState();
    s = toWaitingForModel(s);
    const tc = makeToolCall();
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_execution_started",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    expect(s.status).toBe("waiting_for_tool");

    expect(() =>
      s.apply({
        type: "model_output_received",
        stepIndex: 0,
        output: makeFinalOutput(),
        turn: makeFinalTurn(),
        timestamp: NOW,
      }),
    ).toThrow(/Invalid transition/);
  });

  it("running + tool_execution_finished (no pending approved request) -> Error", () => {
    let s = createState();
    s = toRunning(s);

    expect(() =>
      s.apply({
        type: "tool_execution_started",
        stepIndex: 0,
        request: makeCommandRequest(),
        timestamp: NOW,
      }),
    ).toThrow(/Invalid transition/);
  });

  it("completed + run_finished -> Error (terminal to terminal)", () => {
    let s = createState();
    s = toWaitingForModel(s);
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeFinalOutput(),
      turn: makeFinalTurn(),
      timestamp: NOW,
    });
    expect(s.status).toBe("completed");

    expect(() =>
      s.apply({
        type: "run_finished",
        status: "completed",
        timestamp: NOW,
      }),
    ).toThrow(/Invalid transition/);
  });
});

// ===========================================================================
// Tests: nextEffect()
// ===========================================================================

describe("AgentRunState.nextEffect()", () => {
  it("running with no pending -> call_model", () => {
    let s = createState();
    s = toRunning(s);

    const effect = s.nextEffect();
    expect(effect.type).toBe("call_model");
  });

  it("running with pendingToolCall -> validate_tool_call", () => {
    let s = createState();
    s = toWaitingForModel(s);
    const tc = makeToolCall();
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("validate_tool_call");
    if (effect.type === "validate_tool_call") {
      expect(effect.toolCall).toEqual(tc);
    }
  });

  it("running with pendingToolRequest (no review) -> review_tool", () => {
    let s = createState();
    s = toWaitingForModel(s);
    const tc = makeToolCall();
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("review_tool");
  });

  it("running with pendingToolRequest + approved review -> execute_tool", () => {
    let s = createState();
    s = toWaitingForModel(s);
    const tc = makeToolCall();
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeApproval(),
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("execute_tool");
  });

  it("completed -> stop(final)", () => {
    let s = createState();
    s = toWaitingForModel(s);
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeFinalOutput(),
      turn: makeFinalTurn(),
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("stop");
    if (effect.type === "stop") {
      expect(effect.reason).toBe("final");
    }
  });

  it("running at maxSteps -> stop(max_steps)", () => {
    let s = createState({ maxSteps: 0 });
    s = toRunning(s);

    const effect = s.nextEffect();
    expect(effect.type).toBe("stop");
    if (effect.type === "stop") {
      expect(effect.reason).toBe("max_steps");
    }
  });

  it("running with pendingToolRequest + rejected review -> append_observation", () => {
    let s = createState();
    s = toWaitingForModel(s);
    const tc = makeToolCall();
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeToolCallOutput(tc),
      turn: makeToolCallTurn(tc),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall: tc,
      result: { status: "valid", request: makeCommandRequest() },
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: makeCommandRequest(),
      timestamp: NOW,
    });
    s = s.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: makeCommandRequest(),
      decision: makeRejection(),
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("append_observation");
  });

  it("running with invalid_output pendingModelTurn -> append_observation", () => {
    let s = createState();
    s = toWaitingForModel(s);
    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: makeInvalidOutput(),
      turn: makeInvalidTurn(),
      timestamp: NOW,
    });

    const effect = s.nextEffect();
    expect(effect.type).toBe("append_observation");
  });
});

// ===========================================================================
// Tests: io_wait transitions
// ===========================================================================

describe("io_wait transitions", () => {
  const ioWaitRequest: import("../src/types/environment.js").IoWaitRequest = {
    reason: "test",
    condition: { kind: "new_user_message", channel: "default" },
  };

  function makeIoWaitTurn(): ModelTurn {
    return {
      kind: "io_wait",
      wait: ioWaitRequest,
      thinking: { content: "test", raw: {} },
      rawDecision: '{"type":"io_wait"}',
    };
  }

  function makeIoWaitOutput(): FimStepOutput {
    const turn = makeIoWaitTurn();
    return {
      thinking: { content: "test", raw: {} },
      rawDecision: '{"type":"io_wait"}',
      turn,
    };
  }

  it("model_output_received(io_wait) sets pendingIoWait", () => {
    let s = createState();
    s = toWaitingForModel(s);

    const turn = makeIoWaitTurn();
    const output = makeIoWaitOutput();

    const running = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output,
      turn,
      timestamp: NOW,
    });

    expect(running.status).toBe("running");
    expect(running.data.pendingIoWait).toEqual(ioWaitRequest);
  });

  it("io_wait_started transition -> waiting_for_io", () => {
    let s = createState();
    s = toWaitingForModel(s);

    const turn = makeIoWaitTurn();
    const output = makeIoWaitOutput();

    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output,
      turn,
      timestamp: NOW,
    });
    expect(s.status).toBe("running");
    expect(s.data.pendingIoWait).toBeDefined();

    const waitingIo = s.apply({
      type: "io_wait_started",
      stepIndex: 0,
      wait: ioWaitRequest,
      timestamp: NOW,
    });

    expect(waitingIo.status).toBe("waiting_for_io");
  });

  it("io_wait_satisfied transition -> running, stepIndex+1, pendingIoWait cleared", () => {
    let s = createState();
    s = toWaitingForModel(s);

    const turn = makeIoWaitTurn();
    const output = makeIoWaitOutput();

    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output,
      turn,
      timestamp: NOW,
    });
    s = s.apply({
      type: "io_wait_started",
      stepIndex: 0,
      wait: ioWaitRequest,
      timestamp: NOW,
    });
    expect(s.status).toBe("waiting_for_io");

    const envEvent: import("../src/types/environment.js").EnvironmentEvent = {
      id: "env-1",
      kind: "user_message_received",
      source: "im",
      timestamp: NOW,
      message: {
        id: "msg-1",
        channel: "default",
        role: "user",
        text: "hello",
        createdAt: NOW,
      },
    };

    const satisfied = s.apply({
      type: "io_wait_satisfied",
      stepIndex: 0,
      wait: ioWaitRequest,
      event: envEvent,
      timestamp: NOW,
    });

    expect(satisfied.status).toBe("running");
    expect(satisfied.data.stepIndex).toBe(1);
    expect(satisfied.data.pendingIoWait).toBeUndefined();
  });

  it("nextEffect returns wait_io when pendingIoWait is set", () => {
    let s = createState();
    s = toWaitingForModel(s);

    const turn = makeIoWaitTurn();
    const output = makeIoWaitOutput();

    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output,
      turn,
      timestamp: NOW,
    });
    expect(s.status).toBe("running");
    expect(s.data.pendingIoWait).toBeDefined();

    const effect = s.nextEffect();
    expect(effect.type).toBe("wait_io");
    if (effect.type === "wait_io") {
      expect(effect.wait).toEqual(ioWaitRequest);
    }
  });

  it("Illegal: waiting_for_io + model_output_received -> Error", () => {
    let s = createState();
    s = toWaitingForModel(s);

    const turn = makeIoWaitTurn();
    const output = makeIoWaitOutput();

    s = s.apply({
      type: "model_output_received",
      stepIndex: 0,
      output,
      turn,
      timestamp: NOW,
    });
    s = s.apply({
      type: "io_wait_started",
      stepIndex: 0,
      wait: ioWaitRequest,
      timestamp: NOW,
    });
    expect(s.status).toBe("waiting_for_io");

    expect(() =>
      s.apply({
        type: "model_output_received",
        stepIndex: 0,
        output: makeFinalOutput(),
        turn: makeFinalTurn(),
        timestamp: NOW,
      }),
    ).toThrow(/Invalid transition/);
  });
});
