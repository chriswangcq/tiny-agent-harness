import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  reconstructHistoryFromTranscript,
  RunSessionStore,
} from "../src/run/session-store.js";
import type { HistoryItem } from "../src/run/orchestrator.js";
import type { InternalToolCall, ModelTurn } from "../src/types/model.js";
import type { RunEvent } from "../src/types/run.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-session-store-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("RunSessionStore", () => {
  it("saves and loads agent-loop history snapshots", () => {
    const runDir = makeTmpDir();
    const store = new RunSessionStore(runDir);
    const history: HistoryItem[] = [
      { type: "environment_reminder", content: "persist me" },
    ];

    store.save({
      runId: "run-123",
      updatedAt: "2026-05-28T00:00:00.000Z",
      history,
    });

    expect(fs.existsSync(path.join(runDir, "session.json"))).toBe(true);
    expect(store.load()).toEqual({
      schemaVersion: 1,
      runId: "run-123",
      updatedAt: "2026-05-28T00:00:00.000Z",
      history,
    });
  });
});

describe("reconstructHistoryFromTranscript", () => {
  it("rebuilds tool call, observation, and io_wait history from transcript events", () => {
    const toolCall: InternalToolCall = {
      id: "call-1",
      name: "bash",
      arguments: { kind: "poll", session: "default" },
    };
    const turn: ModelTurn = {
      kind: "tool_call",
      toolCall,
      thinking: { content: "inspect terminal" },
      rawDecision: "bash",
    };
    const waitTurn: ModelTurn = {
      kind: "io_wait",
      wait: {
        reason: "need user",
        condition: { kind: "new_user_message", channel: "default" },
      },
      thinking: { content: "wait" },
      rawDecision: "io_wait",
    };
    const events: RunEvent[] = [
      {
        type: "run_started",
        runId: "run-123",
        task: "task",
        cwd: "/repo",
        timestamp: "2026-05-28T00:00:00.000Z",
      },
      {
        type: "model_output_received",
        stepIndex: 0,
        output: { thinking: turn.thinking, rawDecision: turn.rawDecision, turn },
        turn,
        timestamp: "2026-05-28T00:00:01.000Z",
      },
      {
        type: "tool_execution_finished",
        stepIndex: 0,
        request: {
          kind: "pty_action",
          toolName: "bash",
          toolCallId: "call-1",
          action: { kind: "poll", session: "default" },
        },
        observation: {
          kind: "tool_validation",
          message: "ok",
          recoverable: false,
        },
        timestamp: "2026-05-28T00:00:02.000Z",
      },
      {
        type: "model_output_received",
        stepIndex: 1,
        output: {
          thinking: waitTurn.thinking,
          rawDecision: waitTurn.rawDecision,
          turn: waitTurn,
        },
        turn: waitTurn,
        timestamp: "2026-05-28T00:00:03.000Z",
      },
      {
        type: "io_wait_started",
        stepIndex: 1,
        wait: waitTurn.wait,
        timestamp: "2026-05-28T00:00:04.000Z",
      },
      {
        type: "io_wait_satisfied",
        stepIndex: 1,
        wait: waitTurn.wait,
        event: {
          id: "env-1",
          kind: "user_message_received",
          source: "im",
          timestamp: "2026-05-28T00:00:05.000Z",
          message: {
            id: "msg-1",
            channel: "default",
            role: "user",
            text: "continue",
            createdAt: "2026-05-28T00:00:05.000Z",
          },
        },
        timestamp: "2026-05-28T00:00:05.000Z",
      },
    ];

    expect(reconstructHistoryFromTranscript(events)).toEqual([
      {
        type: "tool_call",
        toolCall,
        thinking: { content: "inspect terminal" },
      },
      {
        type: "observation",
        observation: {
          kind: "tool_validation",
          message: "ok",
          recoverable: false,
        },
      },
      {
        type: "io_wait_call",
        toolCallId: "fim-call-run-123-1",
        wait: waitTurn.wait,
        thinking: { content: "wait" },
      },
      {
        type: "observation",
        toolCallId: "fim-call-run-123-1",
        observation: expect.objectContaining({
          kind: "io_wait",
          recoverable: false,
        }),
      },
    ]);
  });
});
