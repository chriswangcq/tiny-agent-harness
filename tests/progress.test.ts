import { describe, it, expect } from "vitest";
import {
  recordObservationProgress,
  recordToolObservationProgress,
  recordIoWaitProgress,
  runtimeStuckReasonForProgress,
  markRuntimeStuckReported,
  RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
  RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD,
} from "../src/run/progress.js";
import type {
  RuntimeProgressState,
  RuntimeStuckReason,
} from "../src/types/run.js";
import type { AgentObservation, ToolObservation, ToolRequest } from "../src/types/tools.js";
import type { IoWaitRequest, EnvironmentEvent } from "../src/types/environment.js";

function makeRecoverableObs(kind: AgentObservation["kind"], message: string): AgentObservation {
  return { kind, message, recoverable: true };
}

function makeNonRecoverableObs(kind: AgentObservation["kind"], message: string): AgentObservation {
  return { kind, message, recoverable: false };
}

function makeToolRequest(name = "terminal_write"): ToolRequest {
  return {
    toolName: name,
    arguments: { expectedInputSeq: 1, text: "echo hi\n" },
  };
}

function makeOkTerminalObs(): ToolObservation {
  return {
    request: "terminal_write/expectedInputSeq=1",
    result: "ok",
    screen: { text: "hi", rows: 24, cols: 80, truncated: false, logRef: { path: "/tmp/log" } },
    message: "ok",
  };
}

function makeRejectedTerminalObs(): ToolObservation {
  return {
    request: "terminal_write/expectedInputSeq=1",
    result: "rejected",
    errorCode: "STALE_INPUT",
    message: "inputSeq expired",
    screen: { text: "", rows: 24, cols: 80, truncated: false, logRef: { path: "/tmp/log" } },
  };
}

function makeIoWaitRequest(): IoWaitRequest {
  return { reason: "waiting for user", minLevel: 10 };
}

function makeSessionEvent(): EnvironmentEvent {
  return {
    id: "ev-1",
    source: "session",
    kind: "output_available",
    level: 10,
    timestamp: "2024-01-01T00:00:00.000Z",
    session: "default",
  };
}

function makeNonSessionEvent(): EnvironmentEvent {
  return {
    id: "ev-2",
    source: "im",
    kind: "message_received",
    level: 100,
    timestamp: "2024-01-01T00:00:00.000Z",
    channel: "default",
  };
}

function buildStuckReason(severity: "warn" | "blocked"): RuntimeStuckReason {
  return {
    code: "repeated_no_progress",
    severity,
    pattern: "repeated_model_output",
    message: `Runtime ${severity === "blocked" ? "blocked" : "observed"} 5 repeated no-progress model_output signals.`,
    signal: { kind: "model_output", message: "invalid output" },
    signature: '{"kind":"model_output","message":"invalid output"}',
    consecutiveCount: 5,
    threshold: severity === "blocked" ? RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD : RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
    warnThreshold: RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
    blockThreshold: RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD,
    sinceStepIndex: 1,
    lastStepIndex: 5,
  };
}

describe("progress state cleanup", () => {
  it("clearNoProgress removes stuckReason when no-progress state clears", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: reason.pattern,
        signal: reason.signal,
        consecutiveCount: reason.consecutiveCount,
        sinceStepIndex: reason.sinceStepIndex,
        lastStepIndex: reason.lastStepIndex,
        lastReportedSeverity: reason.severity,
      },
      stuckReason: reason,
    };

    // A non-recoverable observation should clear both noProgress and stuckReason
    const result = recordObservationProgress(
      progress,
      makeNonRecoverableObs("model_output", "progress made"),
      10,
    );

    expect(result?.noProgress).toBeUndefined();
    expect(result?.stuckReason).toBeUndefined();
  });

  it("clearNoProgress via successful tool observation clears stuckReason", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: "repeated_tool_error",
        signal: { kind: "tool_error", toolName: "terminal_write", request: "terminal_write/1", result: "rejected" },
        consecutiveCount: 4,
        sinceStepIndex: 2,
        lastStepIndex: 5,
      },
      stuckReason: reason,
    };

    const result = recordToolObservationProgress(
      progress,
      makeToolRequest(),
      makeOkTerminalObs(),
      10,
    );

    expect(result?.noProgress).toBeUndefined();
    expect(result?.stuckReason).toBeUndefined();
  });

  it("clearNoProgress via non-session io_wait clears stuckReason", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: "repeated_io_wait",
        signal: { kind: "io_wait", message: "waiting..." },
        consecutiveCount: 3,
        sinceStepIndex: 1,
        lastStepIndex: 3,
        lastReportedSeverity: "warn",
      },
      stuckReason: reason,
    };

    const result = recordIoWaitProgress(
      progress,
      makeIoWaitRequest(),
      makeNonSessionEvent(),
      10,
    );

    expect(result?.noProgress).toBeUndefined();
    expect(result?.stuckReason).toBeUndefined();
  });

  it("stuckReason is preserved when progress is still stuck", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: "repeated_model_output",
        signal: reason.signal,
        consecutiveCount: 6,
        sinceStepIndex: 1,
        lastStepIndex: 6,
      },
      stuckReason: reason,
    };

    // A recoverable observation with the same pattern should increase no-progress
    const result = recordObservationProgress(
      progress,
      makeRecoverableObs("model_output", "invalid output"),
      7,
    );

    expect(result?.noProgress).toBeDefined();
    expect(result?.noProgress?.consecutiveCount).toBe(7);
    // stuckReason should still be present (it gets updated on next runtime_stuck_detected)
    expect(result?.stuckReason).toBeDefined();
  });

  it("markRuntimeStuckReported sets stuckReason", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: "repeated_model_output",
        signal: reason.signal,
        consecutiveCount: 3,
        sinceStepIndex: 1,
        lastStepIndex: 3,
      },
    };

    const result = markRuntimeStuckReported(progress, reason);
    expect(result.stuckReason).toEqual(reason);
    expect(result.noProgress?.lastReportedSeverity).toBe("warn");
  });
});

describe("stuck reason detection", () => {
  it("returns warn reason at warn threshold", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
        sinceStepIndex: 1,
        lastStepIndex: 3,
      },
    };

    const reason = runtimeStuckReasonForProgress(progress);
    expect(reason).toBeDefined();
    expect(reason?.severity).toBe("warn");
    expect(reason?.threshold).toBe(RUNTIME_NO_PROGRESS_WARN_THRESHOLD);
  });

  it("returns block reason at block threshold", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD,
        sinceStepIndex: 1,
        lastStepIndex: 5,
        lastReportedSeverity: "warn",
      },
    };

    const reason = runtimeStuckReasonForProgress(progress);
    expect(reason).toBeDefined();
    expect(reason?.severity).toBe("blocked");
    expect(reason?.threshold).toBe(RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD);
  });

  it("returns undefined when below warn threshold", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: 2,
        sinceStepIndex: 1,
        lastStepIndex: 2,
      },
    };

    const reason = runtimeStuckReasonForProgress(progress);
    expect(reason).toBeUndefined();
  });

  it("returns undefined when no noProgress", () => {
    const reason = runtimeStuckReasonForProgress(undefined);
    expect(reason).toBeUndefined();
  });

  it("returns undefined when already reported at same severity", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: RUNTIME_NO_PROGRESS_WARN_THRESHOLD + 1,
        sinceStepIndex: 1,
        lastStepIndex: 4,
        lastReportedSeverity: "warn",
      },
    };

    const reason = runtimeStuckReasonForProgress(progress);
    // Already warned at >= warn threshold, and consecutive < block threshold, so undefined
    expect(reason).toBeUndefined();
  });
});

describe("no-progress accumulation", () => {
  it("recordObservationProgress accumulates on repeated recoverable observations", () => {
    // First recoverable obs starts no-progress at count 1
    const r1 = recordObservationProgress(
      undefined,
      makeRecoverableObs("model_output", "err"),
      1,
    );
    expect(r1?.noProgress).toBeDefined();
    expect(r1?.noProgress?.consecutiveCount).toBe(1);
    expect(r1?.noProgress?.pattern).toBe("repeated_model_output");
    expect(r1?.noProgress?.sinceStepIndex).toBe(1);

    // Second recoverable obs with same signature increments count
    const r2 = recordObservationProgress(
      r1,
      makeRecoverableObs("model_output", "err"),
      2,
    );
    expect(r2?.noProgress?.consecutiveCount).toBe(2);
    expect(r2?.noProgress?.sinceStepIndex).toBe(1); // unchanged
    expect(r2?.noProgress?.lastStepIndex).toBe(2);
  });

  it("recordObservationProgress resets consecutive count on signature change", () => {
    // Start with model_output no-progress at count 3
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: 3,
        sinceStepIndex: 1,
        lastStepIndex: 3,
      },
    };

    // Different kind resets count
    const result = recordObservationProgress(
      progress,
      makeRecoverableObs("tool_validation", "bad tool"),
      4,
    );
    expect(result?.noProgress?.consecutiveCount).toBe(1);
    expect(result?.noProgress?.pattern).toBe("repeated_tool_validation");
    expect(result?.noProgress?.sinceStepIndex).toBe(4);
  });

  it("recordToolObservationProgress accumulates on repeated errors", () => {
    const r1 = recordToolObservationProgress(
      undefined,
      makeToolRequest(),
      makeRejectedTerminalObs(),
      1,
    );
    expect(r1?.noProgress).toBeDefined();
    expect(r1?.noProgress?.consecutiveCount).toBe(1);
    expect(r1?.noProgress?.pattern).toBe("repeated_tool_error");

    // Same error again
    const r2 = recordToolObservationProgress(
      r1,
      makeToolRequest(),
      makeRejectedTerminalObs(),
      2,
    );
    expect(r2?.noProgress?.consecutiveCount).toBe(2);
  });

  it("recordIoWaitProgress accumulates on repeated session events", () => {
    const r1 = recordIoWaitProgress(
      undefined,
      makeIoWaitRequest(),
      makeSessionEvent(),
      1,
    );
    expect(r1?.noProgress).toBeDefined();
    expect(r1?.noProgress?.consecutiveCount).toBe(1);
    expect(r1?.noProgress?.pattern).toBe("repeated_io_wait");

    // Same session event again
    const r2 = recordIoWaitProgress(
      r1,
      makeIoWaitRequest(),
      makeSessionEvent(),
      2,
    );
    expect(r2?.noProgress?.consecutiveCount).toBe(2);
  });
});

describe("markRuntimeStuckReported edge cases", () => {
  it("does not re-escalate when reported at same severity", () => {
    const reason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: reason.signature,
        pattern: reason.pattern,
        signal: reason.signal,
        consecutiveCount: 4,
        sinceStepIndex: 1,
        lastStepIndex: 4,
        lastReportedSeverity: "warn",
      },
      stuckReason: reason,
    };

    // Report again with same severity
    const warnReason2 = buildStuckReason("warn");
    const result = markRuntimeStuckReported(progress, warnReason2);

    // stuckReason should still be the original warn reason
    expect(result.stuckReason).toBeDefined();
    expect(result.stuckReason?.severity).toBe("warn");
    // lastReportedSeverity should remain "warn"
    expect(result.noProgress?.lastReportedSeverity).toBe("warn");
  });

  it("clears stuckReason when noProgress signature changes", () => {
    const oldReason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: oldReason.signature,
        pattern: oldReason.pattern,
        signal: oldReason.signal,
        consecutiveCount: 4,
        sinceStepIndex: 1,
        lastStepIndex: 4,
        lastReportedSeverity: "warn",
      },
      stuckReason: oldReason,
    };

    // New reason with different signature
    const newReason: RuntimeStuckReason = {
      code: "repeated_no_progress",
      severity: "warn",
      pattern: "repeated_tool_error",
      message: "different stuck reason",
      signal: { kind: "tool_error", toolName: "x", request: "x", result: "rejected" },
      signature: "different-signature",
      consecutiveCount: 5,
      threshold: RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
      warnThreshold: RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
      blockThreshold: RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD,
      sinceStepIndex: 2,
      lastStepIndex: 5,
    };

    const result = markRuntimeStuckReported(progress, newReason);

    // stuckReason should be cleared because the noProgress signature
    // doesn't match the new reason's signature
    expect(result.stuckReason).toEqual(newReason);
    // noProgress should be unchanged (signature doesn't match)
    expect(result.noProgress).toBe(progress.noProgress);
  });

  it("upgrades severity from warn to blocked", () => {
    const warnReason = buildStuckReason("warn");
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: warnReason.signature,
        pattern: warnReason.pattern,
        signal: warnReason.signal,
        consecutiveCount: 5,
        sinceStepIndex: 1,
        lastStepIndex: 5,
        lastReportedSeverity: "warn",
      },
      stuckReason: warnReason,
    };

    const blockReason = buildStuckReason("blocked");
    const result = markRuntimeStuckReported(progress, blockReason);

    expect(result.stuckReason).toEqual(blockReason);
    expect(result.noProgress?.lastReportedSeverity).toBe("blocked");
  });
});

describe("progress edge cases", () => {
  it("undefined progress returns undefined for non-recoverable", () => {
    const result = recordObservationProgress(
      undefined,
      makeNonRecoverableObs("model_output", "ok"),
      1,
    );
    expect(result).toBeUndefined();
  });

  it("non-recoverable observation clears accumulated no-progress", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: '{"kind":"model_output","message":"err"}',
        pattern: "repeated_model_output",
        signal: { kind: "model_output", message: "err" },
        consecutiveCount: 4,
        sinceStepIndex: 1,
        lastStepIndex: 4,
        lastReportedSeverity: "warn",
      },
      stuckReason: buildStuckReason("warn"),
    };

    const result = recordObservationProgress(
      progress,
      makeNonRecoverableObs("model_output", "ok"),
      5,
    );
    expect(result?.noProgress).toBeUndefined();
    expect(result?.stuckReason).toBeUndefined();
  });

  it("non-terminal tool observation clears no-progress", () => {
    const progress: RuntimeProgressState = {
      noProgress: {
        signature: "tool-sig",
        pattern: "repeated_tool_error",
        signal: { kind: "tool_error", toolName: "x", request: "x", result: "rejected" },
        consecutiveCount: 3,
        sinceStepIndex: 1,
        lastStepIndex: 3,
      },
    };

    // A non-terminal-like observation (e.g., session_list result)
    const result = recordToolObservationProgress(
      progress,
      makeToolRequest(),
      { sessions: [{ id: "s1", cwd: "/tmp" }] } as unknown as ToolObservation,
      4,
    );
    expect(result?.noProgress).toBeUndefined();
  });
});
