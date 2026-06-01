import type { RunSessionSnapshot } from "./session-store.js";
import type { AgentRunStateData, RunEvent } from "../types/run.js";

export type RecoveryFindingCode =
  | "missing_state"
  | "missing_transcript_start"
  | "run_id_mismatch"
  | "missing_session_snapshot"
  | "session_run_id_mismatch"
  | "stale_state_step";

export type RecoverySeverity = "info" | "warn" | "error";

export type RecoveryAction =
  | "resume_existing_state"
  | "inspect_transcript"
  | "rebuild_state_from_transcript"
  | "rebuild_session_from_transcript"
  | "start_new_run";

export type RecoveryFinding = {
  code: RecoveryFindingCode;
  severity: RecoverySeverity;
  message: string;
  action: RecoveryAction;
  details?: Record<string, unknown>;
};

export type RecoveryDiagnostics = {
  status: "healthy" | "recoverable" | "blocked";
  runId?: string;
  highestTranscriptStep: number;
  findings: RecoveryFinding[];
  suggestedActions: RecoveryAction[];
};

export type RecoveryDiagnosticsInput = {
  state: AgentRunStateData | null;
  transcriptEvents: readonly RunEvent[];
  session: RunSessionSnapshot | null;
};

export function diagnoseRunRecovery(
  input: RecoveryDiagnosticsInput,
): RecoveryDiagnostics {
  const findings: RecoveryFinding[] = [];
  const transcriptRunId = findTranscriptRunId(input.transcriptEvents);
  const highestTranscriptStep = findHighestTranscriptStep(input.transcriptEvents);
  const stateRunId = input.state?.runId;
  const runId = stateRunId ?? transcriptRunId ?? input.session?.runId;

  if (!input.state) {
    findings.push({
      code: "missing_state",
      severity: "error",
      message: "Run state snapshot is missing.",
      action: input.transcriptEvents.length > 0
        ? "rebuild_state_from_transcript"
        : "start_new_run",
    });
  }

  if (!transcriptRunId) {
    findings.push({
      code: "missing_transcript_start",
      severity: "warn",
      message: "Transcript has no run_started or run_resumed event.",
      action: "inspect_transcript",
    });
  }

  if (stateRunId && transcriptRunId && stateRunId !== transcriptRunId) {
    findings.push({
      code: "run_id_mismatch",
      severity: "error",
      message: "Run state and transcript identify different runs.",
      action: "inspect_transcript",
      details: { stateRunId, transcriptRunId },
    });
  }

  if (!input.session) {
    findings.push({
      code: "missing_session_snapshot",
      severity: "warn",
      message: "Agent model-context session snapshot is missing.",
      action: "rebuild_session_from_transcript",
    });
  } else if (stateRunId && input.session.runId !== stateRunId) {
    findings.push({
      code: "session_run_id_mismatch",
      severity: "error",
      message: "Agent model-context session belongs to a different run.",
      action: "rebuild_session_from_transcript",
      details: {
        stateRunId,
        sessionRunId: input.session.runId,
      },
    });
  }

  if (
    input.state &&
    highestTranscriptStep > input.state.stepIndex
  ) {
    findings.push({
      code: "stale_state_step",
      severity: "warn",
      message: "Transcript contains events newer than the state snapshot.",
      action: "rebuild_state_from_transcript",
      details: {
        stateStepIndex: input.state.stepIndex,
        highestTranscriptStep,
      },
    });
  }

  return {
    status: classifyRecoveryStatus(findings),
    ...(runId ? { runId } : {}),
    highestTranscriptStep,
    findings,
    suggestedActions: uniqueActions(
      findings.length > 0
        ? findings.map((finding) => finding.action)
        : ["resume_existing_state"],
    ),
  };
}

function classifyRecoveryStatus(
  findings: readonly RecoveryFinding[],
): RecoveryDiagnostics["status"] {
  if (findings.some((finding) => finding.severity === "error")) {
    return "blocked";
  }
  if (findings.length > 0) {
    return "recoverable";
  }
  return "healthy";
}

function uniqueActions(actions: readonly RecoveryAction[]): RecoveryAction[] {
  return [...new Set(actions)];
}

function findTranscriptRunId(events: readonly RunEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "run_started" || event.type === "run_resumed") {
      return event.runId;
    }
  }
  return undefined;
}

function findHighestTranscriptStep(events: readonly RunEvent[]): number {
  let highest = -1;
  for (const event of events) {
    if ("stepIndex" in event && typeof event.stepIndex === "number") {
      highest = Math.max(highest, event.stepIndex);
    }
  }
  return highest;
}
