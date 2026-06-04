import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunState } from "../src/run/state.js";
import { Environment } from "../src/environment/environment.js";
import {
  RunOrchestrator,
  type RunPorts,
} from "../src/run/orchestrator.js";
import { TranscriptStore } from "../src/transcript/store.js";
import { STATIC_TOOL_CATALOG } from "../src/tools/catalog.js";
import { DeterministicModelContextCompactor } from "../src/model/context-window.js";
import {
  ModelContextSession,
  type ModelContextItem,
} from "../src/model/context-session.js";
import type { TerminalObservation, TerminalState } from "../src/terminal/types.js";
import type { EnvironmentEvent, IoWaitRequest } from "../src/types/environment.js";
import type { FimStepOutput, InternalToolCall, ModelStepContext, ModelTurn } from "../src/types/model.js";
import type { RunEvent } from "../src/types/run.js";
import type { ToolRequest, ToolReviewDecision } from "../src/types/tools.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-orchestrator-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function terminal(inputSeq: number): TerminalState {
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
  };
}

function toolOutput(toolCall: InternalToolCall): FimStepOutput {
  const turn: ModelTurn = {
    kind: "tool_call",
    toolCall,
    thinking: { content: "need terminal" },
    rawDecision: "terminal_write",
  };
  return { thinking: turn.thinking, rawDecision: turn.rawDecision, turn };
}

function invalidOutput(message: string): FimStepOutput {
  const turn: ModelTurn = {
    kind: "invalid_output",
    message,
    thinking: { content: "confused" },
    rawDecision: "not a tool",
  };
  return { thinking: turn.thinking!, rawDecision: turn.rawDecision!, turn };
}

function ioWaitOutput(wait: IoWaitRequest): FimStepOutput {
  const turn: ModelTurn = {
    kind: "io_wait",
    wait,
    thinking: { content: "need user" },
    rawDecision: "io_wait",
  };
  return { thinking: turn.thinking, rawDecision: turn.rawDecision, turn };
}

function makeRun(options?: {
  outputs?: FimStepOutput[];
  envEvents?: EnvironmentEvent[];
  waitEvent?: EnvironmentEvent;
  environment?: RunPorts["environment"];
  validateResult?: RunPorts["validator"]["validate"];
  reviewDecision?: ToolReviewDecision;
  terminalObservation?: TerminalObservation;
  initialHistory?: ModelContextItem[];
  contextWindow?: Parameters<ModelContextSession["compactIfNeeded"]>[0]["contextWindow"];
  activeSkillRuns?: ReturnType<RunPorts["listActiveSkillRuns"]>;
  modelProgress?: string[];
  modelError?: unknown;
  onGenerateTurn?: (context: ModelStepContext) => void | Promise<void>;
  initialState?: AgentRunState;
}) {
  const runDir = path.join(makeTmpDir(), "run-001");
  const transcript = new TranscriptStore(runDir);
  const state = options?.initialState ?? AgentRunState.create({
    runId: "run-001",
    task: "test task",
    cwd: "/repo",
    transcriptPath: transcript.transcriptFilePath,
  });

  const defaultWait: IoWaitRequest = {
    reason: "awaiting next instruction",
    condition: { kind: "new_user_message", channel: "default" },
  };
  const outputs = [...(options?.outputs ?? [ioWaitOutput(defaultWait)])];
  const contexts: ModelStepContext[] = [];
  const histories: ModelContextItem[][] = [];
  const consumedCalls: Array<{ runId: string; afterEventId?: string }> = [];
  const waitCalls: Array<{ runId: string; wait: IoWaitRequest }> = [];
  const appendedEvents: EnvironmentEvent[] = [];
  const reviewCalls: ToolRequest[] = [];
  const terminalCalls: ToolRequest[] = [];
  const sessionSaves: ModelContextItem[][] = [];

  const modelContext = ModelContextSession.create({
    task: state.data.task,
    initialItems: options?.initialHistory ?? [],
    contextWindow: options?.contextWindow ?? {
      maxTokens: Number.POSITIVE_INFINITY,
      countTokens: () => 0,
      compact: () => undefined,
    },
    renderer: {
      render(input) {
        histories.push([...input.items]);
        return [
          { role: "system", content: "system" },
          ...input.items.map((entry) =>
            entry.type === "environment_reminder"
              ? { role: "user" as const, content: entry.content }
              : { role: "user" as const, content: JSON.stringify(entry) },
          ),
          ...(input.transientReminders ?? []).map((content) => ({
            role: "user" as const,
            content,
          })),
        ];
      },
    },
  });

  const ports: RunPorts = {
    model: {
      async generateTurn(context, modelOptions) {
        contexts.push(context);
        if (options?.modelError !== undefined) {
          throw options.modelError;
        }
        for (const [sequence, content] of (options?.modelProgress ?? []).entries()) {
          await modelOptions.onProgress?.({
            type: "thinking_delta",
            content,
            sequence,
          });
        }
        await options?.onGenerateTurn?.(context);
        const output = outputs.shift();
        if (!output) {
          throw new Error("No queued model output");
        }
        return output;
      },
    },
    validator: {
      validate: options?.validateResult ?? ((toolCall) => ({
        status: "valid",
        request: {
          kind: "terminal_tool",
          toolName: "terminal_write",
          toolCallId: toolCall.id,
          request: {
            kind: "terminal_write",
            expectedInputSeq: 1,
            text: "pwd",
          },
        },
      })),
    },
    reviewer: {
      async review(request) {
        reviewCalls.push(request);
        return (
          options?.reviewDecision ?? {
            status: "approved",
            reason: "ok",
            reviewer: "test",
          }
        );
      },
    },
    terminal: {
      async execute(request) {
        terminalCalls.push(request);
        return (
          options?.terminalObservation ?? {
            currentSession: "default",
            observedSession: "default",
            terminal: terminal(2),
            request: request.request.kind,
            result: "ok",
            returnedToPrompt: false,
            screen: {
              text:
                request.request.kind === "terminal_write"
                  ? request.request.text
                  : "",
              rows: 24,
              cols: 80,
              truncated: false,
              logRef: { path: "managed-pty://default" },
            },
          }
        );
      },
    },
    modelContext,
    session: {
      saveModelContext(_runId, snapshot) {
        sessionSaves.push([...snapshot.items]);
      },
    },
    tools: [...STATIC_TOOL_CATALOG],
    environment: options?.environment ?? {
      appendEvent(event) {
        appendedEvents.push(event);
      },
      consumeSince(call) {
        consumedCalls.push(call);
        const events = options?.envEvents ?? [];
        options!.envEvents = [];
        return events;
      },
      async waitFor(call) {
        waitCalls.push(call);
        if (!options?.waitEvent) {
          throw new Error("No wait event configured");
        }
        return options.waitEvent;
      },
    },
    listActiveSkillRuns: () => options?.activeSkillRuns ?? [],
  };

  const orchestrator = new RunOrchestrator(state, transcript, ports);

  return {
    orchestrator,
    transcript,
    contexts,
    histories,
    consumedCalls,
    waitCalls,
    appendedEvents,
    reviewCalls,
    terminalCalls,
    sessionSaves,
  };
}

function readTranscript(store: TranscriptStore): RunEvent[] {
  return fs
    .readFileSync(store.transcriptFilePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

async function waitForTranscriptCount(
  store: TranscriptStore,
  type: RunEvent["type"],
  count: number,
): Promise<RunEvent[]> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(store.transcriptFilePath)) {
      const events = readTranscript(store);
      if (events.filter((event) => event.type === type).length >= count) {
        return events;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} transcript events of type ${type}`);
}

describe("RunOrchestrator", () => {
  it("marks the run failed when the model port throws after model_requested", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new Error("fetch failed", { cause });
    const { orchestrator, transcript } = makeRun({
      modelError: error,
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(endState.data.error).toMatchObject({
      message: "fetch failed",
      code: "MODEL_ERROR",
      details: {
        name: "Error",
        cause: {
          message: "Connect Timeout Error",
          code: "UND_ERR_CONNECT_TIMEOUT",
        },
      },
    });

    const events = readTranscript(transcript);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_requested",
      "run_finished",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "failed",
      error: {
        message: "fetch failed",
        code: "MODEL_ERROR",
      },
    });
  });

  it("resumes a persisted run with restored model context", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-resume",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-resume",
        channel: "default",
        role: "user",
        text: "continue",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const failedState = AgentRunState.create({
      runId: "run-resume",
      task: "resume task",
      cwd: "/repo",
      transcriptPath: "/tmp/resume-transcript.jsonl",
    })
      .apply({
        type: "run_started",
        runId: "run-resume",
        task: "resume task",
        cwd: "/repo",
        timestamp: "2026-05-25T11:59:00.000Z",
      })
      .apply({
        type: "run_finished",
        status: "failed",
        error: { message: "previous failure" },
        timestamp: "2026-05-25T11:59:01.000Z",
      });
    const initialHistory: ModelContextItem[] = [
      { type: "environment_reminder", content: "persisted context" },
    ];
    const { orchestrator, transcript, contexts, sessionSaves } = makeRun({
      initialState: failedState,
      initialHistory,
      outputs: [ioWaitOutput(wait)],
      waitEvent,
    });

    await orchestrator.run();

    const events = readTranscript(transcript);
    expect(events[0]).toMatchObject({
      type: "run_resumed",
      runId: "run-resume",
      previousStatus: "failed",
    });
    expect(events.some((event) => event.type === "run_started")).toBe(false);
    expect(sessionSaves[0]).toEqual(initialHistory);
    expect(contexts[0]!.messages.map((message) => message.content).join("\n")).toContain(
      "persisted context",
    );
  });

  it("does not replay in-flight tool execution after resume", async () => {
    const toolCall: InternalToolCall = {
      id: "call-before-crash",
      name: "terminal_write",
      arguments: {
        expectedInputSeq: 1,
        text: "echo side effect\n",
      },
    };
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    let waitingToolState = AgentRunState.create({
      runId: "run-resume-tool",
      task: "resume tool task",
      cwd: "/repo",
      transcriptPath: "/tmp/resume-tool-transcript.jsonl",
    }).apply({
      type: "run_started",
      runId: "run-resume-tool",
      task: "resume tool task",
      cwd: "/repo",
      timestamp: "2026-05-25T11:59:00.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "model_requested",
      stepIndex: 0,
      timestamp: "2026-05-25T11:59:01.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "model_output_received",
      stepIndex: 0,
      output: toolOutput(toolCall),
      turn: toolOutput(toolCall).turn,
      timestamp: "2026-05-25T11:59:02.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "tool_call_validated",
      stepIndex: 0,
      toolCall,
      result: {
        status: "valid",
        request: {
          kind: "terminal_tool",
          toolName: "terminal_write",
          toolCallId: toolCall.id,
          request: {
            kind: "terminal_write",
            expectedInputSeq: 1,
            text: "echo side effect\n",
          },
        },
      },
      timestamp: "2026-05-25T11:59:03.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "tool_review_requested",
      stepIndex: 0,
      request: {
        kind: "terminal_tool",
        toolName: "terminal_write",
        toolCallId: toolCall.id,
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "echo side effect\n",
        },
      },
      timestamp: "2026-05-25T11:59:04.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "tool_reviewed",
      stepIndex: 0,
      request: {
        kind: "terminal_tool",
        toolName: "terminal_write",
        toolCallId: toolCall.id,
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "echo side effect\n",
        },
      },
      decision: {
        status: "approved",
        reason: "ok",
        reviewer: "test",
      },
      timestamp: "2026-05-25T11:59:05.000Z",
    });
    waitingToolState = waitingToolState.apply({
      type: "tool_execution_started",
      stepIndex: 0,
      request: {
        kind: "terminal_tool",
        toolName: "terminal_write",
        toolCallId: toolCall.id,
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "echo side effect\n",
        },
      },
      timestamp: "2026-05-25T11:59:06.000Z",
    });

    const { orchestrator, transcript, terminalCalls } = makeRun({
      initialState: waitingToolState,
      outputs: [ioWaitOutput(wait)],
      waitEvent: {
        id: "msg-env-resume-tool",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:00:00.000Z",
        message: {
          id: "msg-resume-tool",
          channel: "default",
          role: "user",
          text: "continue",
          createdAt: "2026-05-25T12:00:00.000Z",
        },
      },
    });

    await orchestrator.run();

    expect(terminalCalls).toEqual([]);
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_resumed" }),
        expect.objectContaining({
          type: "observation_appended",
          observation: expect.objectContaining({
            kind: "model_output",
            message: expect.stringContaining("in flight"),
          }),
        }),
      ]),
    );
  });

  it("streams model thinking progress into transcript detail and debug artifact", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "ok",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript } = makeRun({
      outputs: [ioWaitOutput(wait)],
      waitEvent,
      modelProgress: ["checking context", "choosing action"],
    });

    await orchestrator.run();

    const events = readTranscript(transcript);
    const firstModelOutputIndex = events.findIndex(
      (event) => event.type === "model_output_received",
    );
    expect(events.slice(0, firstModelOutputIndex + 1).map((event) => event.type)).toEqual([
      "run_started",
      "model_requested",
      "model_thinking_delta",
      "model_thinking_delta",
      "model_output_received",
    ]);
    const thinkingDeltas = events.filter(
      (event): event is Extract<RunEvent, { type: "model_thinking_delta" }> =>
        event.type === "model_thinking_delta",
    );
    expect(thinkingDeltas.slice(0, 2).map((event) => event.delta)).toEqual([
      "checking context",
      "choosing action",
    ]);

    const tracePath = path.join(
      path.dirname(transcript.transcriptFilePath),
      "debug/thinking/step-0000-thinking.trace.txt",
    );
    expect(fs.readFileSync(tracePath, "utf-8")).toBe(
      "checking contextchoosing action",
    );

    const modelOutput = events.find(
      (event): event is Extract<RunEvent, { type: "model_output_received" }> =>
        event.type === "model_output_received",
    );
    expect(modelOutput?.output.thinking.raw).toMatchObject({
      traceRef: {
        path: tracePath,
        relativePath: path.join("debug", "thinking", "step-0000-thinking.trace.txt"),
        bytes: Buffer.byteLength("checking contextchoosing action", "utf-8"),
      },
    });
  });

  it("compacts model context before model requests when the context threshold is reached", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-compact",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-compact",
        channel: "default",
        role: "user",
        text: "ok",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const compactor = new DeterministicModelContextCompactor({
      recentItemCount: 1,
      maxSummaryItems: 8,
    });
    const initialHistory: ModelContextItem[] = [
      { type: "environment_reminder", content: "old context that should compress" },
      { type: "environment_reminder", content: "recent context to keep" },
    ];
    const { orchestrator, transcript, contexts } = makeRun({
      outputs: [ioWaitOutput(wait)],
      waitEvent,
      initialHistory,
      contextWindow: {
        maxTokens: 2,
        countTokens: (history) => (history.length >= 2 ? 2 : 0),
        compact: (input) => compactor.compact(input),
      },
    });

    await orchestrator.run();

    const events = readTranscript(transcript);
    const compactEvent = events.find((event) => event.type === "history_compacted");
    expect(compactEvent).toMatchObject({
      type: "history_compacted",
      stepIndex: 0,
      compaction: {
        tokenCount: 2,
        maxTokens: 2,
        originalItemCount: 2,
        retainedItemCount: 1,
        droppedItemCount: 1,
      },
    });
    expect(events.findIndex((event) => event.type === "history_compacted")).toBeLessThan(
      events.findIndex((event) => event.type === "model_requested"),
    );
    const firstPrompt = contexts[0]!.messages.map((message) => message.content).join("\n");
    expect(firstPrompt).toContain("Compressed model-context history.");
    expect(firstPrompt).toContain("recent context to keep");
    expect(firstPrompt).toContain("Dropped history items:");
  });

  it("does not compact history below the context threshold", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-no-compact",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-no-compact",
        channel: "default",
        role: "user",
        text: "ok",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript, contexts } = makeRun({
      outputs: [ioWaitOutput(wait)],
      waitEvent,
      initialHistory: [
        { type: "environment_reminder", content: "small context" },
      ],
      contextWindow: {
        maxTokens: 10,
        countTokens: () => 9,
        compact: () => {
          throw new Error("should not compact below threshold");
        },
      },
    });

    await orchestrator.run();

    expect(readTranscript(transcript).some((event) => event.type === "history_compacted")).toBe(false);
    expect(contexts[0]!.messages.map((message) => message.content).join("\n")).toContain(
      "small context",
    );
  });

  it("marks the run failed when model-context preparation throws before model_requested", async () => {
    const { orchestrator, transcript, contexts } = makeRun({
      initialHistory: [
        { type: "environment_reminder", content: "large context" },
      ],
      contextWindow: {
        maxTokens: 1,
        countTokens: () => {
          throw new Error("token counter unavailable");
        },
        compact: () => {
          throw new Error("should not compact after count failure");
        },
      },
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(endState.data.error).toMatchObject({
      message: "token counter unavailable",
      code: "MODEL_CONTEXT_ERROR",
    });
    expect(contexts).toHaveLength(0);
    expect(readTranscript(transcript).map((event) => event.type)).toEqual([
      "run_started",
      "run_finished",
    ]);
  });

  it("continues after io_wait instead of stopping at a step cap", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "ok",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript, contexts } = makeRun({
      outputs: [ioWaitOutput(wait)],
      waitEvent,
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(contexts).toHaveLength(2);

    const events = readTranscript(transcript);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_requested",
      "model_output_received",
      "io_wait_started",
      "io_wait_satisfied",
      "model_requested",
      "run_finished",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "failed",
    });
  });

  it("keeps io_wait decisions and results in model history", async () => {
    const firstWait: IoWaitRequest = {
      reason: "awaiting first reply",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const secondWait: IoWaitRequest = {
      reason: "awaiting second reply",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "next",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, histories } = makeRun({
      outputs: [ioWaitOutput(firstWait), ioWaitOutput(secondWait)],
      waitEvent,
    });

    await orchestrator.run();

    expect(histories[1]).toEqual(
      expect.arrayContaining([
        {
          type: "io_wait_call",
          toolCallId: "fim-call-run-001-0",
          wait: firstWait,
          thinking: { content: "need user" },
        },
        {
          type: "observation",
          toolCallId: "fim-call-run-001-0",
          observation: {
            kind: "io_wait",
            message: "io_wait satisfied by external event.",
            recoverable: false,
            event: waitEvent,
          },
        },
      ]),
    );
  });

  it("dispatches approved PTY actions through the terminal port", async () => {
    const toolCall: InternalToolCall = {
      id: "call-pty",
      name: "terminal_write",
      arguments: {
        expectedInputSeq: 1,
        text: "pwd",
      },
    };
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const { orchestrator, histories, terminalCalls } = makeRun({
      outputs: [toolOutput(toolCall), ioWaitOutput(wait)],
      validateResult: () => ({
        status: "valid",
        request: {
          kind: "terminal_tool",
          toolName: "terminal_write",
          toolCallId: "call-pty",
          request: {
            kind: "terminal_write",
            expectedInputSeq: 1,
            text: "pwd",
          },
        },
      }),
      waitEvent: {
        id: "msg-env-wait",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:02:00.000Z",
        message: {
          id: "msg-wait",
          channel: "default",
          role: "user",
          text: "ok",
          createdAt: "2026-05-25T12:02:00.000Z",
        },
      },
    });

    await orchestrator.run();

    expect(terminalCalls).toEqual([
      {
        kind: "terminal_tool",
        toolName: "terminal_write",
        toolCallId: "call-pty",
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "pwd",
        },
      },
    ]);
    expect(histories[1]).toEqual([
      { type: "tool_call", toolCall, thinking: { content: "need terminal" } },
      {
        type: "observation",
        observation: expect.objectContaining({
          currentSession: "default",
          result: "ok",
          request: "terminal_write",
        }),
      },
    ]);
  });

  it("moves raw thinking prompts into debug artifact files", async () => {
    const toolCall: InternalToolCall = {
      id: "call-debug-prompt",
      name: "terminal_write",
      arguments: {
        expectedInputSeq: 1,
        text: "pwd",
      },
    };
    const thinking = {
      content: "need terminal",
      raw: {
        prompt: "encoded prompt for debugging",
        finishReasons: ["stop"],
      },
    };
    const turn: ModelTurn = {
      kind: "tool_call",
      toolCall,
      thinking,
      rawDecision: "terminal_write",
    };
    const output: FimStepOutput = {
      thinking,
      rawDecision: turn.rawDecision,
      turn,
    };
    const { orchestrator, transcript, histories } = makeRun({
      outputs: [output],
    });

    await orchestrator.run();

    const artifactPath = path.join(
      path.dirname(transcript.transcriptFilePath),
      "debug/prompts/step-0000-thinking.prompt.txt",
    );
    expect(fs.readFileSync(artifactPath, "utf-8")).toBe(
      "encoded prompt for debugging",
    );

    const events = readTranscript(transcript);
    const modelOutput = events.find(
      (event): event is Extract<RunEvent, { type: "model_output_received" }> =>
        event.type === "model_output_received",
    );
    expect(modelOutput?.output.thinking.raw).toMatchObject({
      finishReasons: ["stop"],
      promptRef: {
        path: artifactPath,
        relativePath: path.join("debug", "prompts", "step-0000-thinking.prompt.txt"),
        bytes: Buffer.byteLength("encoded prompt for debugging", "utf-8"),
      },
    });
    expect(JSON.stringify(modelOutput)).not.toContain("encoded prompt for debugging");
    expect(histories[1]).toEqual([
      {
        type: "tool_call",
        toolCall,
        thinking: {
          content: "need terminal",
          raw: expect.objectContaining({
            promptRef: expect.objectContaining({
              path: artifactPath,
            }),
          }),
        },
      },
      expect.objectContaining({ type: "observation" }),
    ]);
    expect(JSON.stringify(histories)).not.toContain("encoded prompt for debugging");
  });

  it("records rejected PTY observations from the terminal port", async () => {
    const toolCall: InternalToolCall = {
      id: "call-pty-reject",
      name: "terminal_write",
      arguments: {
        expectedInputSeq: 1,
        text: "pwd",
      },
    };
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const rejected: TerminalObservation = {
      currentSession: "default",
      observedSession: "default",
      terminal: {
        ...terminal(4),
        syncStatus: { kind: "unsynced", reason: "state_gap" },
      },
      request: "terminal_write",
      result: "rejected",
      returnedToPrompt: false,
      errorCode: "TERMINAL_UNSYNCED",
      message: "Terminal state is unsynced.",
      screen: {
        text: "pwd",
        rows: 24,
        cols: 80,
        truncated: false,
        logRef: { path: "managed-pty://default" },
      },
    };
    const { orchestrator, histories, terminalCalls } = makeRun({
      outputs: [toolOutput(toolCall), ioWaitOutput(wait)],
      validateResult: () => ({
        status: "valid",
        request: {
          kind: "terminal_tool",
          toolName: "terminal_write",
          toolCallId: "call-pty-reject",
          request: {
            kind: "terminal_write",
            expectedInputSeq: 1,
            text: "pwd",
          },
        },
      }),
      terminalObservation: rejected,
      waitEvent: {
        id: "msg-env-wait",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:02:00.000Z",
        message: {
          id: "msg-wait",
          channel: "default",
          role: "user",
          text: "ok",
          createdAt: "2026-05-25T12:02:00.000Z",
        },
      },
    });

    await orchestrator.run();

    expect(terminalCalls).toHaveLength(1);
    expect(histories[1]).toContainEqual({
      type: "observation",
      observation: rejected,
    });
  });

  it("appends a synthetic observation after invalid model output and recovers on the next model step", async () => {
    const wait: IoWaitRequest = {
      reason: "awaiting next instruction",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const waitEvent: EnvironmentEvent = {
      id: "msg-env-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "ok",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript, histories } = makeRun({
      outputs: [invalidOutput("bad native frame"), ioWaitOutput(wait)],
      waitEvent,
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(histories[1]).toEqual([
      {
        type: "observation",
        observation: {
          kind: "model_output",
          message: "bad native frame",
          recoverable: true,
        },
      },
    ]);
    expect(readTranscript(transcript).map((event) => event.type)).toContain(
      "observation_appended",
    );
  });

  it("does not enter io_wait after an IM send write that has not returned to prompt", async () => {
    const toolCall: InternalToolCall = {
      id: "call-im-send",
      name: "terminal_write",
      arguments: {
        expectedInputSeq: 1,
        text: "node dist/cli/main.js im send --channel default --kind status --text-stdin <<'EOF'\nreport\nEOF\n",
      },
    };
    const wait: IoWaitRequest = {
      reason: "done",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const terminalObservation: TerminalObservation = {
      currentSession: "default",
      observedSession: "default",
      terminal: terminal(2),
      request: "terminal_write",
      result: "ok",
      returnedToPrompt: false,
      screen: {
        text: "node dist/cli/main.js im send --ch",
        rows: 24,
        cols: 80,
        truncated: false,
        logRef: { path: "managed-pty://default" },
      },
    };
    const { orchestrator, transcript, waitCalls, histories } = makeRun({
      outputs: [toolOutput(toolCall), ioWaitOutput(wait), invalidOutput("done")],
      terminalObservation,
    });

    await orchestrator.run();

    expect(waitCalls).toEqual([]);
    expect(histories[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_call",
          toolCallId: "fim-call-run-001-1",
          wait,
        }),
        expect.objectContaining({
          type: "observation",
          toolCallId: "fim-call-run-001-1",
          observation: expect.objectContaining({
            kind: "io_wait",
            recoverable: true,
            message: expect.stringContaining("prompt"),
          }),
        }),
      ]),
    );
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "observation_appended",
          observation: expect.objectContaining({
            kind: "io_wait",
            message: expect.stringContaining("prompt"),
          }),
        }),
      ]),
    );
  });

  it("records consumed environment events and injects both environment reminder and skill reminder into model context", async () => {
    const envEvent: EnvironmentEvent = {
      id: "env-001",
      kind: "skill_run_started",
      source: "skill",
      timestamp: "2026-05-25T12:00:00.000Z",
      skillRunId: "skillrun-env-001",
      skill: "review",
      statePath: ".tiny-agent/skill-runs/skillrun-env-001/state.json",
      executionLogPath: ".tiny-agent/skill-runs/skillrun-env-001/execution.txt",
    };
    const { orchestrator, transcript, contexts, consumedCalls } = makeRun({
      outputs: [ioWaitOutput({
        reason: "awaiting",
        condition: { kind: "new_user_message", channel: "default" },
      })],
      envEvents: [envEvent],
      waitEvent: {
        id: "msg-env-wait",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:00:01.000Z",
        message: {
          id: "msg-wait",
          channel: "default",
          role: "user",
          text: "ok",
          createdAt: "2026-05-25T12:00:01.000Z",
        },
      },
      activeSkillRuns: [
        {
          skillRunId: "skillrun-001",
          skill: "review",
          status: "review_pending",
          executionReturnCode: 0,
          executionLogPath: ".tiny-agent/skill-runs/skillrun-001/execution.txt",
          reviewTaskPath: ".tiny-agent/skill-runs/skillrun-001/review-task.txt",
        },
      ],
    });

    await orchestrator.run();

    expect(consumedCalls).toEqual([{ runId: "run-001" }, { runId: "run-001" }]);

    // Environment reminder should be in messages
    const messages = contexts[0]!.messages;
    const envReminder = messages.find((m) =>
      m.role === "user" && m.content.includes("Environment reminder:"),
    );
    expect(envReminder).toBeDefined();
    expect(envReminder!.content).toContain("skill_run_started");
    expect(envReminder!.content).toContain("skillrun-env-001");
    expect(envReminder!.content).toContain("review");

    // Skill reminder should also be present
    const skillReminder = messages.find(
      (m) => m.role === "user" && m.content.includes("Active skill reminder:"),
    );
    expect(skillReminder).toBeDefined();
    expect(skillReminder!.content).toContain("skillrun-001");
    expect(skillReminder!.content).toContain("review_pending");

    expect(readTranscript(transcript)).toContainEqual(
      expect.objectContaining({
        type: "environment_events_consumed",
        eventIds: ["env-001"],
      }),
    );
  });

  it("waits for IO events and resumes with the matching environment event", async () => {
    const wait: IoWaitRequest = {
      reason: "need user reply",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const event: EnvironmentEvent = {
      id: "msg-env-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "continue",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript, waitCalls } = makeRun({
      outputs: [ioWaitOutput(wait), ioWaitOutput(wait)],
      waitEvent: event,
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(endState.data.stepIndex).toBe(2);
    expect(waitCalls).toHaveLength(2);
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "io_wait_started", wait }),
        expect.objectContaining({
          type: "io_wait_satisfied",
          wait,
          event,
        }),
      ]),
    );
  });

  it("allows bare event io_wait conditions as any-event waits", async () => {
    const wait: IoWaitRequest = {
      reason: "waiting for any environment event",
      condition: { kind: "event" },
    };
    const event: EnvironmentEvent = {
      id: "env-any",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-any",
        channel: "default",
        role: "user",
        text: "anything changed",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const { orchestrator, transcript, waitCalls } = makeRun({
      outputs: [ioWaitOutput(wait)],
      waitEvent: event,
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]?.wait).toEqual(wait);
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_started",
          wait,
        }),
        expect.objectContaining({
          type: "io_wait_satisfied",
          wait,
          event,
        }),
      ]),
    );
  });

  it("records terminal prompt returns as session environment events", async () => {
    const toolCall: InternalToolCall = {
      id: "tool-returned",
      name: "terminal_write",
      arguments: { expectedInputSeq: 1, text: "pwd\n" },
    };
    const { orchestrator, appendedEvents } = makeRun({
      outputs: [toolOutput(toolCall)],
      terminalObservation: {
        currentSession: "default",
        observedSession: "default",
        terminal: terminal(2),
        request: "terminal_write",
        result: "ok",
        returnedToPrompt: true,
        terminalEvents: [
          {
            kind: "prompt",
            returnCode: 0,
            cwd: "/repo",
            promptSeq: 3,
            promptNonce: "nonce",
          },
        ],
        screen: {
          text: "/repo\n",
          rows: 24,
          cols: 80,
          truncated: false,
          logRef: { path: "managed-pty://default" },
        },
      },
    });

    await orchestrator.run();

    expect(appendedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "session_returned_to_prompt",
          source: "session",
          session: "default",
          request: "terminal_write",
          inputSeq: 2,
          promptSeq: 3,
          level: 10,
        }),
        expect.objectContaining({
          kind: "session_input_ready",
          source: "session",
          session: "default",
          request: "terminal_write",
          inputSeq: 2,
          promptSeq: 3,
          level: 10,
        }),
      ]),
    );
  });

  it("deduplicates repeated terminal facts across different observations", async () => {
    const environment = new Environment();
    const environmentPort: RunPorts["environment"] = {
      appendEvent(event) {
        return environment.appendEvent(event);
      },
      consumeSince(options) {
        return environment.consumeSince(options);
      },
      waitFor(options) {
        return environment.waitFor(options);
      },
    };
    const firstToolCall: InternalToolCall = {
      id: "tool-returned-1",
      name: "terminal_write",
      arguments: { expectedInputSeq: 1, text: "pwd\n" },
    };
    const secondToolCall: InternalToolCall = {
      id: "tool-returned-2",
      name: "terminal_write",
      arguments: { expectedInputSeq: 1, text: "pwd\n" },
    };
    const terminalObservation: TerminalObservation = {
      currentSession: "default",
      observedSession: "default",
      terminal: terminal(2),
      request: "terminal_write",
      result: "ok",
      returnedToPrompt: true,
      terminalEvents: [
        {
          kind: "prompt",
          returnCode: 0,
          cwd: "/repo",
          promptSeq: 3,
          promptNonce: "same-prompt",
        },
      ],
      screen: {
        text: "/repo\n",
        rows: 24,
        cols: 80,
        truncated: false,
        logRef: { path: "managed-pty://default" },
      },
    };
    const { orchestrator, transcript } = makeRun({
      outputs: [toolOutput(firstToolCall), toolOutput(secondToolCall)],
      environment: environmentPort,
      terminalObservation,
    });

    await orchestrator.run();

    expect(environment.state.events).toEqual([
      expect.objectContaining({
        id: "env-session-run-001-default-returned-nonce-same-prompt",
        kind: "session_returned_to_prompt",
      }),
      expect.objectContaining({
        id: "env-session-run-001-default-input-ready-prompt-nonce-same-prompt",
        kind: "session_input_ready",
      }),
    ]);
    expect(
      readTranscript(transcript).filter(
        (event) => event.type === "environment_event_recorded",
      ),
    ).toHaveLength(2);
  });

  it("session environment events can wake a pending io_wait", async () => {
    const wait: IoWaitRequest = {
      reason: "wait for terminal readiness",
      condition: { kind: "event", source: "session", minLevel: 10 },
    };
    const environment = new Environment();
    const appendedEvents: EnvironmentEvent[] = [];
    const environmentPort: RunPorts["environment"] = {
      appendEvent(event) {
        appendedEvents.push(event);
        environment.appendEvent(event);
      },
      consumeSince(options) {
        return environment.consumeSince(options);
      },
      waitFor(options) {
        return environment.waitFor(options);
      },
    };
    const { orchestrator, terminalCalls, transcript } = makeRun({
      outputs: [ioWaitOutput(wait)],
      environment: environmentPort,
      terminalObservation: {
        currentSession: "default",
        observedSession: "default",
        terminal: terminal(2),
        request: "session_observe",
        result: "ok",
        returnedToPrompt: true,
        terminalEvents: [
          {
            kind: "prompt",
            returnCode: 0,
            cwd: "/repo",
            promptSeq: 4,
            promptNonce: "nonce",
          },
        ],
        screen: {
          text: "[repo]$ ",
          rows: 24,
          cols: 80,
          truncated: false,
          logRef: { path: "managed-pty://default" },
        },
      },
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(terminalCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "session_observe",
          toolCallId: expect.stringContaining("session-watch-"),
        }),
      ]),
    );
    expect(appendedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "session_input_ready",
          source: "session",
          level: 10,
          promptSeq: 4,
        }),
      ]),
    );
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_satisfied",
          event: expect.objectContaining({
            source: "session",
            level: 10,
          }),
        }),
      ]),
    );
  });

  it("background low-priority session output does not satisfy default io_wait", async () => {
    const wait: IoWaitRequest = {
      reason: "wait for meaningful external input",
    };
    const environment = new Environment();
    const environmentPort: RunPorts["environment"] = {
      appendEvent(event) {
        return environment.appendEvent(event);
      },
      consumeSince(options) {
        return environment.consumeSince(options);
      },
      waitFor(options) {
        return environment.waitFor(options);
      },
    };
    const { orchestrator, terminalCalls, transcript } = makeRun({
      outputs: [ioWaitOutput(wait)],
      environment: environmentPort,
      terminalObservation: {
        currentSession: "default",
        observedSession: "default",
        terminal: terminal(2),
        request: "session_observe",
        result: "ok",
        returnedToPrompt: false,
        terminalEvents: [{ kind: "output", bytes: 14, preview: "still running" }],
        screen: {
          text: "still running\n",
          rows: 24,
          cols: 80,
          truncated: false,
          logRef: { path: "managed-pty://default" },
        },
      },
    });

    const runPromise = orchestrator.run();

    await waitForTranscriptCount(transcript, "environment_event_recorded", 1);
    expect(terminalCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "session_observe",
          toolCallId: expect.stringContaining("session-watch-"),
        }),
      ]),
    );
    expect(readTranscript(transcript)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_satisfied",
        }),
      ]),
    );

    const userEvent: EnvironmentEvent = {
      id: "msg-env-operator-interrupt",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:01.000Z",
      message: {
        id: "msg-operator-interrupt",
        channel: "default",
        role: "user",
        text: "pause that and answer me",
        createdAt: "2026-05-25T12:00:01.000Z",
      },
    };
    environment.appendEvent(userEvent);

    const endState = await runPromise;

    expect(endState.status).toBe("failed");
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_satisfied",
          wait,
          event: userEvent,
        }),
      ]),
    );
  });

  it("delivers the wait-satisfying user message into the next model context", async () => {
    const wait: IoWaitRequest = {
      reason: "need user reply",
      condition: { kind: "new_user_message", channel: "default" },
    };
    const firstMessage: EnvironmentEvent = {
      id: "msg-env-poem-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:00.000Z",
      message: {
        id: "msg-poem-001",
        channel: "default",
        role: "user",
        text: "发一首诗",
        createdAt: "2026-05-25T12:00:00.000Z",
      },
    };
    const secondMessage: EnvironmentEvent = {
      id: "msg-env-poem-002",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:01.000Z",
      message: {
        id: "msg-poem-002",
        channel: "default",
        role: "user",
        text: "继续",
        createdAt: "2026-05-25T12:00:01.000Z",
      },
    };
    const environment = new Environment();
    const { orchestrator, transcript, contexts } = makeRun({
      outputs: [ioWaitOutput(wait), ioWaitOutput(wait)],
      environment,
    });

    const runPromise = orchestrator.run();

    await waitForTranscriptCount(transcript, "io_wait_started", 1);
    environment.appendEvent(firstMessage);

    await waitForTranscriptCount(transcript, "model_requested", 2);
    expect(contexts).toHaveLength(2);
    const secondPrompt = contexts[1]!.messages
      .map((message) => message.content)
      .join("\n");
    expect(secondPrompt).toContain("[user@default] 发一首诗");

    await waitForTranscriptCount(transcript, "io_wait_started", 2);
    environment.appendEvent(secondMessage);

    const endState = await runPromise;
    expect(endState.status).toBe("failed");

    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "environment_events_consumed",
          eventIds: ["msg-env-poem-001"],
        }),
      ]),
    );
  });

  it("persists user_message_received environment events as environment_reminder in history for subsequent model calls", async () => {
    const toolCall: InternalToolCall = {
      id: "call-1",
      name: "terminal_write",
      arguments: { expectedInputSeq: 1, text: "echo hi\n" },
    };
    const userEvent: EnvironmentEvent = {
      id: "env-im-001",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:01:00.000Z",
      message: {
        id: "msg-001",
        channel: "default",
        role: "user",
        text: "请帮我看一下文件",
        createdAt: "2026-05-25T12:01:00.000Z",
      },
    };

    const { orchestrator, histories } = makeRun({
      outputs: [toolOutput(toolCall), ioWaitOutput({
        reason: "awaiting",
        condition: { kind: "new_user_message", channel: "default" },
      })],
      envEvents: [userEvent],
      waitEvent: {
        id: "msg-env-wait",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:02:00.000Z",
        message: {
          id: "msg-wait",
          channel: "default",
          role: "user",
          text: "ok",
          createdAt: "2026-05-25T12:02:00.000Z",
        },
      },
    });

    await orchestrator.run();

    expect(histories).toHaveLength(3);
    expect(histories[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "environment_reminder",
          content: expect.stringContaining("[user@default] 请帮我看一下文件"),
        }),
      ]),
    );
  });

  it("does not miss environment events that arrive during the model turn before io_wait", async () => {
    const wait: IoWaitRequest = {
      reason: "wait after thinking",
    };
    const duringModelMessage: EnvironmentEvent = {
      id: "msg-env-during-model",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-05-25T12:00:02.000Z",
      message: {
        id: "msg-during-model",
        channel: "default",
        role: "user",
        text: "别等了，先看这个",
        createdAt: "2026-05-25T12:00:02.000Z",
      },
    };
    const environment = new Environment();
    const { orchestrator, transcript } = makeRun({
      outputs: [ioWaitOutput(wait)],
      environment,
      onGenerateTurn() {
        environment.appendEvent(duringModelMessage);
      },
    });

    const endState = await orchestrator.run();

    expect(endState.status).toBe("failed");
    expect(readTranscript(transcript)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "io_wait_satisfied",
          wait,
          event: duringModelMessage,
        }),
        expect.objectContaining({
          type: "environment_events_consumed",
          eventIds: ["msg-env-during-model"],
        }),
      ]),
    );
  });
});
