import { describe, expect, it } from "vitest";
import { diagnoseRunRecovery } from "../src/run/recovery.js";
import type { RunSessionSnapshot } from "../src/run/session-store.js";
import type { AgentRunStateData, RunEvent } from "../src/types/run.js";

const started: RunEvent = {
  type: "run_started",
  runId: "run-1",
  task: "task",
  cwd: "/repo",
  timestamp: "2026-05-31T00:00:00.000Z",
};

function state(overrides: Partial<AgentRunStateData> = {}): AgentRunStateData {
  return {
    runId: "run-1",
    status: "running",
    task: "task",
    cwd: "/repo",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:01.000Z",
    stepIndex: 1,
    transcriptPath: ".tiny-agent/runs/run-1/transcript.jsonl",
    ...overrides,
  };
}

function session(overrides: Partial<RunSessionSnapshot> = {}): RunSessionSnapshot {
  return {
    schemaVersion: 1,
    runId: "run-1",
    updatedAt: "2026-05-31T00:00:01.000Z",
    history: [],
    ...overrides,
  };
}

describe("diagnoseRunRecovery", () => {
  it("classifies a consistent state/transcript/session as healthy", () => {
    expect(
      diagnoseRunRecovery({
        state: state(),
        transcriptEvents: [
          started,
          {
            type: "model_requested",
            stepIndex: 1,
            timestamp: "2026-05-31T00:00:01.000Z",
          },
        ],
        session: session(),
      }),
    ).toMatchObject({
      status: "healthy",
      runId: "run-1",
      highestTranscriptStep: 1,
      findings: [],
      suggestedActions: ["resume_existing_state"],
    });
  });

  it("blocks when state and transcript identify different runs", () => {
    const result = diagnoseRunRecovery({
      state: state({ runId: "run-state" }),
      transcriptEvents: [{ ...started, runId: "run-transcript" }],
      session: session({ runId: "run-state" }),
    });

    expect(result.status).toBe("blocked");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "run_id_mismatch",
        severity: "error",
        action: "inspect_transcript",
      }),
    ]);
  });

  it("marks missing session and stale state as recoverable", () => {
    const result = diagnoseRunRecovery({
      state: state({ stepIndex: 1 }),
      transcriptEvents: [
        started,
        {
          type: "model_requested",
          stepIndex: 3,
          timestamp: "2026-05-31T00:00:03.000Z",
        },
      ],
      session: null,
    });

    expect(result.status).toBe("recoverable");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "missing_session_snapshot",
      "stale_state_step",
    ]);
    expect(result.suggestedActions).toEqual([
      "rebuild_session_from_transcript",
      "rebuild_state_from_transcript",
    ]);
  });

  it("reports missing state from explicit inputs without reading files", () => {
    const result = diagnoseRunRecovery({
      state: null,
      transcriptEvents: [],
      session: null,
    });

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "missing_state",
      "missing_transcript_start",
      "missing_session_snapshot",
    ]);
    expect(result.suggestedActions).toContain("start_new_run");
  });
});
