import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunState } from "../src/run/state.js";
import {
  RunOrchestrator,
  type HistoryItem,
  type RunPorts,
} from "../src/run/orchestrator.js";
import { TranscriptStore } from "../src/transcript/store.js";
import { BASH_TOOL_DEFINITION } from "../src/tools/catalog.js";
import type { BashObservation } from "../src/types/bash.js";
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

function finalOutput(content: string): FimStepOutput {
  const turn: ModelTurn = {
    kind: "final",
    content,
    thinking: { content: "done" },
    rawDecision: `final:${content}`,
  };
  return { thinking: turn.thinking, rawDecision: turn.rawDecision, turn };
}

function toolOutput(toolCall: InternalToolCall): FimStepOutput {
  const turn: ModelTurn = {
    kind: "tool_call",
    toolCall,
    thinking: { content: "need bash" },
    rawDecision: "bash",
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
  validateResult?: RunPorts["validator"]["validate"];
  reviewDecision?: ToolReviewDecision;
  bashObservation?: BashObservation;
  activeSkillRuns?: ReturnType<RunPorts["listActiveSkillRuns"]>;
}) {
  const runDir = path.join(makeTmpDir(), "run-001");
  const transcript = new TranscriptStore(runDir);
  const state = AgentRunState.create({
    runId: "run-001",
    task: "test task",
    cwd: "/repo",
    maxSteps: 5,
    transcriptPath: transcript.transcriptFilePath,
  });

  const outputs = [...(options?.outputs ?? [finalOutput("ok")])];
  const contexts: ModelStepContext[] = [];
  const histories: HistoryItem[][] = [];
  const consumedCalls: Array<{ runId: string; afterEventId?: string }> = [];
  const waitCalls: Array<{ runId: string; wait: IoWaitRequest }> = [];
  const reviewCalls: ToolRequest[] = [];
  const bashCalls: ToolRequest[] = [];

  const ports: RunPorts = {
    model: {
      async generateTurn(context) {
        contexts.push(context);
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
          kind: "command",
          toolName: "bash",
          toolCallId: toolCall.id,
          session: "default",
          command: "pwd",
          timeoutMs: 30_000,
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
    bash: {
      async execute(request) {
        bashCalls.push(request);
        return (
          options?.bashObservation ?? {
            session: "default",
            state: "idle",
            returnCode: 0,
            output: "/repo\n",
            outputTruncated: false,
            outputLogPath: ".tiny-agent/sessions/default/output.log",
          }
        );
      },
    },
    prompt: {
      buildMessages(task, history) {
        histories.push([...history]);
        return [
          { role: "system", content: "system" },
          { role: "user", content: task },
          ...history.map((entry) => ({
            role: "observation" as const,
            content: JSON.stringify(entry),
          })),
        ];
      },
    },
    bashTool: BASH_TOOL_DEFINITION,
    environment: {
      appendEvent() {},
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
    reviewCalls,
    bashCalls,
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

describe("RunOrchestrator", () => {
  it("completes a run when the model returns final", async () => {
    const { orchestrator, transcript, contexts } = makeRun({
      outputs: [finalOutput("finished")],
    });

    const finalState = await orchestrator.run();

    expect(finalState.status).toBe("completed");
    expect(finalState.data.final).toBe("finished");
    expect(contexts).toHaveLength(1);

    const events = readTranscript(transcript);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_requested",
      "model_output_received",
      "run_finished",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
      final: "finished",
    });
  });

  it("executes an approved bash tool call and preserves tool history for the next model step", async () => {
    const toolCall: InternalToolCall = {
      id: "call-1",
      name: "bash",
      arguments: { session: "default", command: "pwd" },
    };
    const { orchestrator, transcript, histories, reviewCalls, bashCalls } = makeRun({
      outputs: [toolOutput(toolCall), finalOutput("after bash")],
    });

    const finalState = await orchestrator.run();

    expect(finalState.status).toBe("completed");
    expect(reviewCalls).toHaveLength(1);
    expect(bashCalls).toEqual([
      {
        kind: "command",
        toolName: "bash",
        toolCallId: "call-1",
        session: "default",
        command: "pwd",
        timeoutMs: 30_000,
      },
    ]);

    expect(histories).toHaveLength(2);
    expect(histories[1]).toEqual([
      { type: "tool_call", toolCall },
      {
        type: "observation",
        observation: expect.objectContaining({
          session: "default",
          returnCode: 0,
          output: "/repo\n",
        }),
      },
    ]);

    const eventTypes = readTranscript(transcript).map((event) => event.type);
    expect(eventTypes).toEqual([
      "run_started",
      "model_requested",
      "model_output_received",
      "tool_call_validated",
      "tool_review_requested",
      "tool_reviewed",
      "tool_execution_started",
      "tool_execution_finished",
      "model_requested",
      "model_output_received",
      "run_finished",
    ]);
  });

  it("appends a synthetic observation after invalid model output and recovers on the next model step", async () => {
    const { orchestrator, transcript, histories } = makeRun({
      outputs: [invalidOutput("bad native frame"), finalOutput("recovered")],
    });

    const finalState = await orchestrator.run();

    expect(finalState.status).toBe("completed");
    expect(finalState.data.final).toBe("recovered");
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

  it("records consumed environment events and injects both environment reminder and skill reminder into model context", async () => {
    const envEvent: EnvironmentEvent = {
      id: "env-001",
      kind: "command_finished",
      source: "bash",
      timestamp: "2026-05-25T12:00:00.000Z",
      session: "default",
      commandId: "cmd-001",
      returnCode: 0,
      outputLogPath: ".tiny-agent/sessions/default/output.log",
    };
    const { orchestrator, transcript, contexts, consumedCalls } = makeRun({
      outputs: [finalOutput("ok")],
      envEvents: [envEvent],
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

    expect(consumedCalls).toEqual([{ runId: "run-001" }]);

    // Environment reminder should be in messages
    const messages = contexts[0]!.messages;
    const envReminder = messages.find(
      (m) => m.role === "system" && m.content.includes("Environment reminder:"),
    );
    expect(envReminder).toBeDefined();
    expect(envReminder!.content).toContain("command_finished");
    expect(envReminder!.content).toContain("cmd-001");
    expect(envReminder!.content).toContain("rc=0");

    // Skill reminder should also be present
    const skillReminder = messages.find(
      (m) => m.role === "system" && m.content.includes("Active skill reminder:"),
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
      outputs: [ioWaitOutput(wait), finalOutput("done after wait")],
      waitEvent: event,
    });

    const finalState = await orchestrator.run();

    expect(finalState.status).toBe("completed");
    expect(finalState.data.stepIndex).toBe(1);
    expect(waitCalls).toEqual([{ runId: "run-001", wait }]);
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

  it("persists user_message_received environment events into history for subsequent model calls", async () => {
    const toolCall: InternalToolCall = {
      id: "call-1",
      name: "bash",
      arguments: { session: "default", command: "echo hi" },
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
      outputs: [toolOutput(toolCall), finalOutput("done")],
      envEvents: [userEvent],
    });

    await orchestrator.run();

    // First call: envEvents consumed, history should include user_message
    // Second call: history should still contain the user_message alongside tool history
    expect(histories).toHaveLength(2);
    expect(histories[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user_message",
          text: "请帮我看一下文件",
          channel: "default",
        }),
      ]),
    );
  });
});
