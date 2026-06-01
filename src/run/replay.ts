import type { ModelContextItem } from "../model/context-session.js";
import type { RunSessionSnapshot } from "./session-store.js";
import { reconstructModelContextItemsFromTranscript } from "./session-store.js";
import {
  diagnoseRunRecovery,
  type RecoveryDiagnostics,
} from "./recovery.js";
import type { AgentRunStateData, RunEvent } from "../types/run.js";

export type ReplayEventStats = {
  totalEvents: number;
  modelTurns: number;
  invalidModelOutputs: number;
  toolCalls: number;
  toolObservations: number;
  ioWaits: number;
  userMessages: number;
  agentMessages: number;
};

export type ReplayCase = {
  caseId: string;
  runId: string;
  task: string;
  cwd: string;
  status?: AgentRunStateData["status"];
  lastStepIndex: number;
  startedAt?: string;
  updatedAt?: string;
  stats: ReplayEventStats;
  modelContextItems: ModelContextItem[];
  recovery: RecoveryDiagnostics;
};

export type EvalCaseSummary = {
  caseId: string;
  label?: string;
  runId: string;
  task: string;
  status?: AgentRunStateData["status"];
  lastStepIndex: number;
  modelTurns: number;
  toolCalls: number;
  ioWaits: number;
  invalidModelOutputs: number;
  recoveryStatus: RecoveryDiagnostics["status"];
  recoveryFindingCodes: string[];
  model?: string;
  toolCatalogHash?: string;
};

export function buildReplayCase(input: {
  state: AgentRunStateData | null;
  transcriptEvents: readonly RunEvent[];
  session: RunSessionSnapshot | null;
}): ReplayCase {
  const start = findRunStart(input.transcriptEvents);
  const recovery = diagnoseRunRecovery(input);
  const runId =
    input.state?.runId ??
    start?.runId ??
    input.session?.runId ??
    "unknown-run";
  const task = input.state?.task ?? start?.task ?? "";
  const cwd = input.state?.cwd ?? start?.cwd ?? "";
  const lastStepIndex = findHighestStep(input.transcriptEvents);
  const stats = summarizeReplayEvents(input.transcriptEvents);

  return {
    caseId: buildReplayCaseId(runId, input.transcriptEvents),
    runId,
    task,
    cwd,
    ...(input.state?.status ? { status: input.state.status } : {}),
    lastStepIndex,
    ...(start?.timestamp ? { startedAt: start.timestamp } : {}),
    ...(input.state?.updatedAt ? { updatedAt: input.state.updatedAt } : {}),
    stats,
    modelContextItems: reconstructModelContextItemsFromTranscript(input.transcriptEvents),
    recovery,
  };
}

export function buildEvalCaseSummary(
  replayCase: ReplayCase,
  options: {
    label?: string;
    model?: string;
    toolCatalogHash?: string;
  } = {},
): EvalCaseSummary {
  return {
    caseId: replayCase.caseId,
    ...(options.label ? { label: options.label } : {}),
    runId: replayCase.runId,
    task: replayCase.task,
    ...(replayCase.status ? { status: replayCase.status } : {}),
    lastStepIndex: replayCase.lastStepIndex,
    modelTurns: replayCase.stats.modelTurns,
    toolCalls: replayCase.stats.toolCalls,
    ioWaits: replayCase.stats.ioWaits,
    invalidModelOutputs: replayCase.stats.invalidModelOutputs,
    recoveryStatus: replayCase.recovery.status,
    recoveryFindingCodes: replayCase.recovery.findings.map(
      (finding) => finding.code,
    ),
    ...(options.model ? { model: options.model } : {}),
    ...(options.toolCatalogHash
      ? { toolCatalogHash: options.toolCatalogHash }
      : {}),
  };
}

export function summarizeReplayEvents(
  events: readonly RunEvent[],
): ReplayEventStats {
  const stats: ReplayEventStats = {
    totalEvents: events.length,
    modelTurns: 0,
    invalidModelOutputs: 0,
    toolCalls: 0,
    toolObservations: 0,
    ioWaits: 0,
    userMessages: 0,
    agentMessages: 0,
  };

  for (const event of events) {
    switch (event.type) {
      case "model_output_received":
        stats.modelTurns++;
        if (event.turn.kind === "invalid_output") {
          stats.invalidModelOutputs++;
        }
        if (event.turn.kind === "tool_call") {
          stats.toolCalls++;
        }
        break;
      case "tool_execution_finished":
      case "observation_appended":
        stats.toolObservations++;
        break;
      case "io_wait_started":
        stats.ioWaits++;
        break;
      case "user_message_received":
        stats.userMessages++;
        break;
      case "agent_message_sent":
        stats.agentMessages++;
        break;
      default:
        break;
    }
  }

  return stats;
}

function findRunStart(events: readonly RunEvent[]):
  | Extract<RunEvent, { type: "run_started" }>
  | undefined {
  return events.find(
    (event): event is Extract<RunEvent, { type: "run_started" }> =>
      event.type === "run_started",
  );
}

function findHighestStep(events: readonly RunEvent[]): number {
  let highest = -1;
  for (const event of events) {
    if ("stepIndex" in event && typeof event.stepIndex === "number") {
      highest = Math.max(highest, event.stepIndex);
    }
  }
  return highest;
}

function buildReplayCaseId(
  runId: string,
  events: readonly RunEvent[],
): string {
  const lastTimestamp = events.at(-1)?.timestamp ?? "no-events";
  return `${runId}:${events.length}:${lastTimestamp}`;
}
