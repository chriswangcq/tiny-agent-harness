import { describe, expect, it } from "vitest";
import {
  buildEvalCaseSummary,
  buildReplayCase,
  summarizeReplayEvents,
} from "../src/run/replay.js";
import type { AgentRunStateData, RunEvent } from "../src/types/run.js";
import type { InternalToolCall, ModelTurn } from "../src/types/model.js";

function state(overrides: Partial<AgentRunStateData> = {}): AgentRunStateData {
  return {
    runId: "run-1",
    status: "waiting_for_io",
    task: "write tests",
    cwd: "/repo",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:05.000Z",
    stepIndex: 2,
    transcriptPath: ".tiny-agent/runs/run-1/transcript.jsonl",
    ...overrides,
  };
}

const toolCall: InternalToolCall = {
  id: "call-1",
  name: "session_observe",
  arguments: { session: "default" },
};

const toolTurn: ModelTurn = {
  kind: "tool_call",
  toolCall,
  thinking: { content: "inspect" },
  rawDecision: "session_observe",
};

const invalidTurn: ModelTurn = {
  kind: "invalid_output",
  message: "bad DSML",
  thinking: { content: "oops" },
  rawDecision: "bad",
};

const events: RunEvent[] = [
  {
    type: "run_started",
    runId: "run-1",
    task: "write tests",
    cwd: "/repo",
    timestamp: "2026-05-31T00:00:00.000Z",
  },
  {
    type: "model_output_received",
    stepIndex: 1,
    output: {
      thinking: toolTurn.thinking,
      rawDecision: toolTurn.rawDecision,
      turn: toolTurn,
    },
    turn: toolTurn,
    timestamp: "2026-05-31T00:00:01.000Z",
  },
  {
    type: "tool_execution_finished",
    stepIndex: 1,
    request: {
      kind: "terminal_tool",
      toolName: "session_observe",
      toolCallId: "call-1",
      request: { kind: "session_observe", session: "default" },
    },
    observation: {
      kind: "tool_validation",
      message: "ok",
      recoverable: false,
    },
    timestamp: "2026-05-31T00:00:02.000Z",
  },
  {
    type: "model_output_received",
    stepIndex: 2,
    output: {
      thinking: invalidTurn.thinking!,
      rawDecision: invalidTurn.rawDecision!,
      turn: invalidTurn,
    },
    turn: invalidTurn,
    timestamp: "2026-05-31T00:00:03.000Z",
  },
  {
    type: "io_wait_started",
    stepIndex: 2,
    wait: {
      reason: "need user",
      condition: { kind: "new_user_message", channel: "default" },
    },
    timestamp: "2026-05-31T00:00:04.000Z",
  },
  {
    type: "user_message_received",
    runId: "run-1",
    message: {
      id: "msg-1",
      channel: "default",
      role: "user",
      text: "continue",
      createdAt: "2026-05-31T00:00:05.000Z",
    },
    timestamp: "2026-05-31T00:00:05.000Z",
  },
];

describe("run replay/eval case builders", () => {
  it("summarizes replay event counts", () => {
    expect(summarizeReplayEvents(events)).toMatchObject({
      totalEvents: 6,
      modelTurns: 2,
      toolCalls: 1,
      toolObservations: 1,
      invalidModelOutputs: 1,
      ioWaits: 1,
      userMessages: 1,
    });
  });

  it("builds replay cases with reconstructed history and diagnostics", () => {
    const replayCase = buildReplayCase({
      state: state(),
      transcriptEvents: events,
      session: {
        schemaVersion: 2,
        runId: "run-1",
        updatedAt: "2026-05-31T00:00:05.000Z",
        modelContext: {
          version: 1,
          task: "write tests",
          items: [],
        },
      },
    });

    expect(replayCase).toMatchObject({
      caseId: "run-1:6:2026-05-31T00:00:05.000Z",
      runId: "run-1",
      task: "write tests",
      cwd: "/repo",
      status: "waiting_for_io",
      lastStepIndex: 2,
      stats: {
        modelTurns: 2,
        toolCalls: 1,
      },
      recovery: {
        status: "healthy",
      },
    });
    expect(replayCase.modelContextItems).toEqual([
      expect.objectContaining({
        type: "tool_call",
        toolCall,
        provenance: expect.objectContaining({ kind: "transcript_replay" }),
      }),
      expect.objectContaining({
        type: "observation",
        provenance: expect.objectContaining({ kind: "transcript_replay" }),
      }),
    ]);
  });

  it("builds compact eval summaries with diagnostic codes", () => {
    const replayCase = buildReplayCase({
      state: state({ runId: "other-run" }),
      transcriptEvents: events,
      session: null,
    });

    expect(
      buildEvalCaseSummary(replayCase, {
        label: "baseline",
        model: "deepseek-v4",
        toolCatalogHash: "tools-sha",
      }),
    ).toMatchObject({
      label: "baseline",
      model: "deepseek-v4",
      toolCatalogHash: "tools-sha",
      recoveryStatus: "blocked",
      recoveryFindingCodes: [
        "run_id_mismatch",
        "missing_session_snapshot",
      ],
      modelTurns: 2,
      toolCalls: 1,
      invalidModelOutputs: 1,
    });
  });
});
