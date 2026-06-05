import type { EnvironmentEvent, IoWaitRequest } from "../types/environment.js";
import { ioWaitMinLevel } from "../types/environment.js";
import type {
  RuntimeNoProgressPattern,
  RuntimeNoProgressSignal,
  RuntimeProgressState,
  RuntimeStuckReason,
} from "../types/run.js";
import type { AgentObservation, ToolObservation, ToolRequest } from "../types/tools.js";

export const RUNTIME_NO_PROGRESS_WARN_THRESHOLD = 3;
export const RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD = 5;

export function recordObservationProgress(
  progress: RuntimeProgressState | undefined,
  observation: AgentObservation,
  stepIndex: number,
): RuntimeProgressState | undefined {
  if (!observation.recoverable) {
    return clearNoProgress(progress);
  }

  return recordNoProgress(
    progress,
    observationPattern(observation.kind),
    {
      kind: observation.kind,
      message: compactText(observation.message),
    },
    stepIndex,
  );
}

export function recordToolObservationProgress(
  progress: RuntimeProgressState | undefined,
  request: ToolRequest,
  observation: ToolObservation,
  stepIndex: number,
): RuntimeProgressState | undefined {
  if (isAgentObservation(observation)) {
    return recordObservationProgress(progress, observation, stepIndex);
  }

  if (!isTerminalObservationLike(observation)) {
    return clearNoProgress(progress);
  }

  if (observation.result === "ok") {
    return clearNoProgress(progress);
  }

  return recordNoProgress(
    progress,
    "repeated_tool_error",
    {
      kind: "tool_error",
      toolName: request.toolName,
      request: observation.request,
      result: observation.result,
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
      ...(observation.message ? { message: compactText(observation.message) } : {}),
    },
    stepIndex,
  );
}

export function recordIoWaitProgress(
  progress: RuntimeProgressState | undefined,
  wait: IoWaitRequest,
  event: EnvironmentEvent,
  stepIndex: number,
): RuntimeProgressState | undefined {
  if (event.source !== "session") {
    return clearNoProgress(progress);
  }

  return recordNoProgress(
    progress,
    "repeated_io_wait",
    {
      kind: "io_wait",
      message: compactText(
        `io_wait minLevel=${ioWaitMinLevel(wait)} satisfied by ${event.kind}`,
      ),
    },
    stepIndex,
  );
}

export function runtimeStuckReasonForProgress(
  progress: RuntimeProgressState | undefined,
): RuntimeStuckReason | undefined {
  const noProgress = progress?.noProgress;
  if (!noProgress) {
    return undefined;
  }

  if (
    noProgress.consecutiveCount >= RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD &&
    noProgress.lastReportedSeverity !== "blocked"
  ) {
    return buildReason(noProgress, "blocked", RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD);
  }

  if (
    noProgress.consecutiveCount >= RUNTIME_NO_PROGRESS_WARN_THRESHOLD &&
    noProgress.lastReportedSeverity === undefined
  ) {
    return buildReason(noProgress, "warn", RUNTIME_NO_PROGRESS_WARN_THRESHOLD);
  }

  return undefined;
}

export function markRuntimeStuckReported(
  progress: RuntimeProgressState | undefined,
  reason: RuntimeStuckReason,
): RuntimeProgressState {
  const noProgress = progress?.noProgress;
  return {
    ...progress,
    noProgress:
      noProgress && noProgress.signature === reason.signature
        ? {
            ...noProgress,
            lastReportedSeverity: reason.severity,
          }
        : noProgress,
    stuckReason: reason,
  };
}

function recordNoProgress(
  progress: RuntimeProgressState | undefined,
  pattern: RuntimeNoProgressPattern,
  signal: RuntimeNoProgressSignal,
  stepIndex: number,
): RuntimeProgressState {
  const signature = noProgressSignature(signal);
  const previous = progress?.noProgress;
  const isRepeated = previous?.signature === signature;

  return {
    ...progress,
    noProgress: {
      signature,
      pattern,
      signal,
      consecutiveCount: isRepeated ? previous.consecutiveCount + 1 : 1,
      sinceStepIndex: isRepeated ? previous.sinceStepIndex : stepIndex,
      lastStepIndex: stepIndex,
      lastReportedSeverity: isRepeated ? previous.lastReportedSeverity : undefined,
    },
    stuckReason: isRepeated ? progress?.stuckReason : undefined,
  };
}

function clearNoProgress(
  progress: RuntimeProgressState | undefined,
): RuntimeProgressState | undefined {
  if (!progress?.noProgress) {
    return progress;
  }
  return {
    ...progress,
    noProgress: undefined,
    stuckReason: undefined,
  };
}

function buildReason(
  noProgress: NonNullable<RuntimeProgressState["noProgress"]>,
  severity: RuntimeStuckReason["severity"],
  threshold: number,
): RuntimeStuckReason {
  const message =
    severity === "blocked"
      ? `Runtime blocked after ${noProgress.consecutiveCount} repeated no-progress ${noProgress.signal.kind} signals.`
      : `Runtime observed ${noProgress.consecutiveCount} repeated no-progress ${noProgress.signal.kind} signals.`;

  return {
    code: "repeated_no_progress",
    severity,
    pattern: noProgress.pattern,
    message,
    signal: noProgress.signal,
    signature: noProgress.signature,
    consecutiveCount: noProgress.consecutiveCount,
    threshold,
    warnThreshold: RUNTIME_NO_PROGRESS_WARN_THRESHOLD,
    blockThreshold: RUNTIME_NO_PROGRESS_BLOCK_THRESHOLD,
    sinceStepIndex: noProgress.sinceStepIndex,
    lastStepIndex: noProgress.lastStepIndex,
  };
}

function observationPattern(
  kind: AgentObservation["kind"],
): RuntimeNoProgressPattern {
  switch (kind) {
    case "model_output":
      return "repeated_model_output";
    case "tool_validation":
      return "repeated_tool_validation";
    case "tool_review":
      return "repeated_tool_review";
    case "io_wait":
      return "repeated_io_wait";
  }
}

function noProgressSignature(signal: RuntimeNoProgressSignal): string {
  return JSON.stringify(signal);
}

function compactText(message: string): string {
  const compacted = message.replace(/\s+/g, " ").trim();
  return compacted.length > 240 ? `${compacted.slice(0, 237)}...` : compacted;
}

function isAgentObservation(value: ToolObservation): value is AgentObservation {
  return (
    typeof value === "object" &&
    value !== null &&
    "recoverable" in value &&
    "message" in value &&
    typeof (value as { recoverable?: unknown }).recoverable === "boolean"
  );
}

function isTerminalObservationLike(value: ToolObservation): value is ToolObservation & {
  request: string;
  result: string;
  errorCode?: string;
  message?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "request" in value &&
    "result" in value &&
    typeof (value as { request?: unknown }).request === "string" &&
    typeof (value as { result?: unknown }).result === "string"
  );
}
