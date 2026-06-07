// Lifecycle CLI — thin command dispatcher over supervisor lifecycle domain.
// Parses CLI args, delegates lifecycle decisions to supervisor-lifecycle.ts,
// and returns typed JSON envelopes. No in-memory state pretenses.

import type {
  LifecycleInput,
  LifecycleConfig,
  LifecycleResult,
  ReaperDecision,
  ReaperActionKind,
  WorkerLifecycleState,
  HeartbeatInterpretation,
  LeaseEvaluation,
} from "./supervisor-lifecycle.js";
import {
  computeLifecycleState,
  interpretHeartbeat,
  evaluateLease,
  decideReaperAction,
  isGracePeriodActive,
} from "./supervisor-lifecycle.js";
import type { WorkerContact } from "./contact-registry.js";
import {
  successEnvelope,
  failureEnvelope,
  type CliEnvelope,
  type SuccessEnvelopeInput,
} from "../cli/envelope.js";
import type { SupervisorLifecycleEvent } from "./supervisor-store.js";

// ---------------------------------------------------------------------------
// Tool name for JSON envelope
// ---------------------------------------------------------------------------
const TOOL_NAME = "team";

// ---------------------------------------------------------------------------
// Default lifecycle config
// ---------------------------------------------------------------------------
export const DEFAULT_LIFECYCLE_THRESHOLDS: Omit<LifecycleConfig, "now"> = {
  heartbeatMaxAgeMs: 300_000,    // 5 minutes
  evidenceMaxAgeMs: 600_000,     // 10 minutes
  leaseMaxAgeMs: 1_800_000,      // 30 minutes
  gracePeriodMs: 60_000,         // 1 minute
  shutdownMaxAgeMs: 300_000,     // 5 minutes
  processMissingMaxAgeMs: 600_000, // 10 minutes
};

// ---------------------------------------------------------------------------
// buildLifecycleConfig — explicit now factory, no ambient time capture
// ---------------------------------------------------------------------------
export function buildLifecycleConfig(now: string): LifecycleConfig {
  return {
    now,
    heartbeatMaxAgeMs: DEFAULT_LIFECYCLE_THRESHOLDS.heartbeatMaxAgeMs,
    evidenceMaxAgeMs: DEFAULT_LIFECYCLE_THRESHOLDS.evidenceMaxAgeMs,
    leaseMaxAgeMs: DEFAULT_LIFECYCLE_THRESHOLDS.leaseMaxAgeMs,
    gracePeriodMs: DEFAULT_LIFECYCLE_THRESHOLDS.gracePeriodMs,
    shutdownMaxAgeMs: DEFAULT_LIFECYCLE_THRESHOLDS.shutdownMaxAgeMs,
    processMissingMaxAgeMs: DEFAULT_LIFECYCLE_THRESHOLDS.processMissingMaxAgeMs,
  };
}
// CLI ports — explicit dependencies for time/id generation
// ---------------------------------------------------------------------------
export type LifecycleCliPorts = {
  nowIso: () => string;
};

// ---------------------------------------------------------------------------
// Execute ports — optional synchronous effect boundary for tests
// ---------------------------------------------------------------------------
export type ExecuteLifecyclePorts = {
  processExists?: (workerId: string) => boolean;
  shutdownWorker?: (workerId: string, reason?: string) => void;
  appendLifecycleEvent?: (event: SupervisorLifecycleEvent) => { status: string; message?: string };
};

// ---------------------------------------------------------------------------
// Build a LifecycleInput from a WorkerContact + process info
// ---------------------------------------------------------------------------
export function buildLifecycleInput(
  worker: WorkerContact,
  processExists: boolean,
  runLastStepAt?: string,
  ledgerOpenProblems?: number,
  shutdownRequestedAt?: string,
): LifecycleInput {
  return {
    workerId: worker.workerId,
    contactStatus: worker.status,
    lastHeartbeat: worker.lastHeartbeat,
    lastEvidence: worker.lastEvidence,
    runStatus: undefined,
    runLastStepAt,
    ledgerOpenProblems,
    ledgerLastActivityAt: undefined,
    processExists,
    processStartTime: undefined,
    shutdownRequestedAt,
    terminatedAt: worker.status === "terminated" ? undefined : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure command dispatcher
// ---------------------------------------------------------------------------
export function executeLifecycleCommand(
  ports: LifecycleCliPorts,
  args: string[],
  cwd: string | undefined,
  // Caller provides the worker lookups, not state
  lookupWorkerFn: (workerId: string) => WorkerContact | undefined,
  processExistsFn?: (workerId: string) => boolean,
  executePorts?: ExecuteLifecyclePorts,
): CliEnvelope {
  if (args.length === 0) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "MISSING_SUBCOMMAND",
      error: "Missing lifecycle subcommand. Expected one of: lifecycle-status, lease, shutdown, reaper.",
    });
  }

  const subcommand = args[0];
  const rest = args.slice(1);
  const resolveWorker = (id: string): WorkerContact | { error: string } => {
    const w = lookupWorkerFn(id);
    if (!w) return { error: `Unknown worker: "${id}".` };
    return w;
  };

  switch (subcommand) {
    case "lifecycle-status":
      return handleLifecycleStatus(ports, rest, cwd, resolveWorker, processExistsFn, executePorts);
    case "lease":
      return handleLease(ports, rest, cwd, resolveWorker, executePorts);
    case "shutdown":
      return handleShutdown(ports, rest, cwd, resolveWorker, processExistsFn, executePorts);
    case "reaper":
      return handleReaper(ports, rest, cwd, lookupWorkerFn, processExistsFn, executePorts);
    default:
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "UNKNOWN_SUBCOMMAND",
        error: `Unknown lifecycle subcommand: "${subcommand}". Expected: lifecycle-status, lease, shutdown, reaper.`,
      });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle-status handler
// ---------------------------------------------------------------------------
function handleLifecycleStatus(
  ports: LifecycleCliPorts,
  args: string[],
  cwd: string | undefined,
  resolveWorker: (id: string) => WorkerContact | { error: string },
  processExistsFn?: (workerId: string) => boolean,
  executePorts?: ExecuteLifecyclePorts,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "USAGE",
      error: "Usage: team lifecycle-status <workerId>",
    });
  }

  const workerId = args[0];
  const worker = resolveWorker(workerId);
  if ("error" in worker) {
    return failureEnvelope({ tool: TOOL_NAME, cwd, errorCode: "UNKNOWN_WORKER", error: worker.error });
  }

  const now = ports.nowIso();
  const config: LifecycleConfig = buildLifecycleConfig(now);
  const processExists = executePorts?.processExists
    ? executePorts.processExists(workerId)
    : processExistsFn
      ? processExistsFn(workerId)
      : true;
  const input = buildLifecycleInput(worker, processExists);
  const result = computeLifecycleState(input, config);

  return successEnvelope({
    ...base,
    extra: {
      command: "lifecycle-status",
      workerId: worker.workerId,
      role: worker.role,
      contactStatus: worker.status,
      lifecycleState: result.state,
      reason: result.reason,
      riskFlags: result.riskFlags,
      evidence: result.evidence,
      workspace: worker.workspace,
      branch: worker.branch,
      imChannel: worker.imChannel,
      lastHeartbeat: worker.lastHeartbeat ?? null,
      lastEvidence: worker.lastEvidence ?? null,
      currentTask: worker.currentTask ?? null,
      runId: worker.runId ?? null,
      ledgerId: worker.ledgerId ?? null,
      ticket: worker.ticket ?? null,
      allowedActions: worker.allowedActions,
    },
  });
}

// ---------------------------------------------------------------------------
// Lease (heartbeat) handler
// ---------------------------------------------------------------------------
function handleLease(
  ports: LifecycleCliPorts,
  args: string[],
  cwd: string | undefined,
  resolveWorker: (id: string) => WorkerContact | { error: string },
  executePorts?: ExecuteLifecyclePorts,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "USAGE",
      error: "Usage: team lease <workerId> [--expiry-ms <ms>]",
    });
  }

  const workerId = args[0];
  const worker = resolveWorker(workerId);
  if ("error" in worker) {
    return failureEnvelope({ tool: TOOL_NAME, cwd, errorCode: "UNKNOWN_WORKER", error: worker.error });
  }

  // Parse optional --expiry-ms flag
  let expiryMs: number | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--expiry-ms" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0) {
        return failureEnvelope({
          tool: TOOL_NAME, cwd,
          errorCode: "INVALID_ARG",
          error: `Invalid --expiry-ms value: "${args[i + 1]}". Must be a positive integer.`,
        });
      }
      expiryMs = parsed;
      break;
    }
  }

  const now = ports.nowIso();
  const config: LifecycleConfig = buildLifecycleConfig(now);

  // Interpret current heartbeat
  const hbInterpretation = interpretHeartbeat(worker.lastHeartbeat, now, config);

  // When executePorts are provided, actually append the lifecycle event
  let appendResult: { status: string; message?: string } | undefined;
  if (executePorts?.appendLifecycleEvent) {
    const ev: SupervisorLifecycleEvent = {
      eventId: `ev-lease-${workerId}-${now}`,
      type: "heartbeat_recorded",
      timestamp: now,
      payload: { workerId, timestamp: now },
    };
    appendResult = executePorts.appendLifecycleEvent(ev);
  }

  return successEnvelope({
    ...base,
    extra: {
      command: "lease",
      workerId,
      timestamp: now,
      expiryMs,
      leaseExpiresAt: expiryMs ? new Date(new Date(now).getTime() + expiryMs).toISOString() : null,
      heartbeatInterpretation: hbInterpretation,
      appendResult,
      // The caller (team-run.ts / store adapter) is responsible for applying
      // the heartbeat event to the contact registry. CLI only produces the plan.
      plan: {
        event: "worker_heartbeat",
        workerId,
        timestamp: now,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Shutdown handler — dry-run by default
// ---------------------------------------------------------------------------
function handleShutdown(
  ports: LifecycleCliPorts,
  args: string[],
  cwd: string | undefined,
  resolveWorker: (id: string) => WorkerContact | { error: string },
  processExistsFn?: (workerId: string) => boolean,
  executePorts?: ExecuteLifecyclePorts,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "USAGE",
      error: "Usage: team shutdown <workerId> [--execute]",
    });
  }

  const workerId = args[0];
  const worker = resolveWorker(workerId);
  if ("error" in worker) {
    return failureEnvelope({ tool: TOOL_NAME, cwd, errorCode: "UNKNOWN_WORKER", error: worker.error });
  }

  // Check for --execute flag
  const execute = args.includes("--execute");

  if (!execute) {
    // Dry-run: return plan only using domain functions
    const now = ports.nowIso();
    const config: LifecycleConfig = buildLifecycleConfig(now);
    const processExists = processExistsFn ? processExistsFn(workerId) : true;
    const input = buildLifecycleInput(worker, processExists, undefined, undefined, now);
    const result = computeLifecycleState(input, config);

    return successEnvelope({
      ...base,
      extra: {
        command: "shutdown",
        dryRun: true,
        executed: false,
        workerId,
        plan: {
          action: "shutdown",
          workerId,
          currentStatus: worker.status,
          currentLifecycleState: result.state,
          targetStatus: "offline" as const,
          reason: "Shutdown requested",
          timestamp: now,
        },
        lifecycleState: result,
      },
    });
  }

  // Execute: produce the status change plan.
  // The caller is responsible for applying the status change to the contact
  // registry. CLI only validates and produces the plan.
  if (worker.status === "terminated") {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "FSM_REJECTED",
      error: `Worker ${workerId} is already terminated.`,
    });
  }

  const now = ports.nowIso();
  const config: LifecycleConfig = buildLifecycleConfig(now);
  const processExists = processExistsFn ? processExistsFn(workerId) : true;
  const input = buildLifecycleInput(worker, processExists, undefined, undefined, now);
  const result = computeLifecycleState(input, config);

  // Call shutdownWorker and append lifecycle events when executePorts provided
  let shutdownResult: { status: string; message?: string } | undefined;
  if (executePorts?.shutdownWorker) {
    try {
      executePorts.shutdownWorker(workerId, "Shutdown requested via lifecycle CLI");
      shutdownResult = { status: "completed" };
    } catch (e: unknown) {
      shutdownResult = { status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  const appended: Array<{ type: string; status: string; message?: string }> = [];
  if (executePorts?.appendLifecycleEvent) {
    const reqEv: SupervisorLifecycleEvent = {
      eventId: `ev-shutdown-req-${workerId}-${now}`,
      type: "shutdown_requested",
      timestamp: now,
      payload: { phase: "shutdown", requestedBy: "lifecycle-cli", reason: "Shutdown requested via lifecycle CLI" },
    };
    const reqResult = executePorts.appendLifecycleEvent(reqEv);
    appended.push({ type: "shutdown_requested", ...reqResult });

    // The completed event type depends on whether BOTH shutdownWorker and the completed append succeed
    const shutdownOk = !shutdownResult || shutdownResult.status === "completed";
    const completeType = (shutdownOk && reqResult.status === "appended") ? "shutdown_completed" : "shutdown_failed";
    const compEv: SupervisorLifecycleEvent = {
      eventId: `ev-shutdown-comp-${workerId}-${now}`,
      type: completeType,
      timestamp: now,
      payload: completeType === "shutdown_completed"
        ? { totalWorkersTerminated: 1 }
        : { reason: shutdownResult?.message || reqResult.message || "shutdown failed" },
    };
    const compResult = executePorts.appendLifecycleEvent(compEv);
    const compEntryType = compResult.status === "appended" ? completeType : "shutdown_failed";
    appended.push({ type: compEntryType, ...compResult });
  }

  return successEnvelope({
    ...base,
    extra: {
      command: "shutdown",
      dryRun: false,
      executed: true,
      workerId,
      previousStatus: worker.status,
      newStatus: "offline",
      lifecycleResult: result,
      shutdownResult,
      appended,
      plan: {
        event: "worker_status_changed",
        workerId,
        status: "offline" as const,
        reason: "Shutdown requested via lifecycle CLI",
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Stale reaper handler — dry-run by default
// ---------------------------------------------------------------------------
function handleReaper(
  ports: LifecycleCliPorts,
  args: string[],
  cwd: string | undefined,
  lookupWorkerFn: (workerId: string) => WorkerContact | undefined,
  processExistsFn?: (workerId: string) => boolean,
  executePorts?: ExecuteLifecyclePorts,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "USAGE",
      error: "Usage: team reaper list|execute [--threshold-ms <ms>] [--execute]",
    });
  }

  const mode = args[0];
  if (mode !== "list" && mode !== "execute") {
    return failureEnvelope({
      tool: TOOL_NAME, cwd,
      errorCode: "INVALID_MODE",
      error: `Unknown reaper mode: "${mode}". Expected "list" or "execute".`,
    });
  }

  // Parse --threshold-ms flag (default: 5 minutes)
  let thresholdMs = 300000;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--threshold-ms" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0) {
        return failureEnvelope({
          tool: TOOL_NAME, cwd,
          errorCode: "INVALID_ARG",
          error: `Invalid --threshold-ms value: "${args[i + 1]}". Must be a positive integer.`,
        });
      }
      thresholdMs = parsed;
      break;
    }
  }

  // Parse --workers-json flag (required)
  let workersJson: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--workers-json" && i + 1 < args.length) {
      workersJson = args[i + 1];
      break;
    }
  }

  if (!workersJson) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "MISSING_ARG",
      error: "Usage: team reaper list|execute --workers-json <json> [--threshold-ms <ms>] [--execute]",
    });
  }

  let workers: WorkerContact[];
  try {
    workers = JSON.parse(workersJson);
    if (!Array.isArray(workers)) throw new Error("not array");
    // Validate worker shape
    for (const w of workers) {
      if (typeof w.workerId !== "string" || typeof w.status !== "string" ||
          typeof w.role !== "string" || typeof w.workspace !== "string" ||
          typeof w.branch !== "string" || typeof w.imChannel !== "string" ||
          !Array.isArray((w as any).allowedActions)) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "INVALID_ARG",
          error: "Invalid --workers-json: each entry must have string workerId, status, role, workspace, branch, imChannel, and array allowedActions.",
        });
      }
    }
  } catch {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "INVALID_ARG",
      error: "Invalid --workers-json: must be a JSON array of WorkerContact objects.",
    });
  }

  // Check for --execute flag
  const executeFlag = args.includes("--execute");
  const shouldExecute = mode === "execute" && executeFlag;

  const now = ports.nowIso();
  const config: LifecycleConfig = { ...buildLifecycleConfig(now), heartbeatMaxAgeMs: thresholdMs };

  // Compute lifecycle state and reaper decisions for all workers using domain functions
  const staleDecisions: Array<{
    workerId: string;
    contactStatus: string;
    lifecycleState: string;
    reaperAction: string;
    reaperReason: string;
    lastHeartbeat: string | null;
    heartbeatAgeMs: number | null;
  }> = [];

  for (const w of workers) {
    const processExists = processExistsFn ? processExistsFn(w.workerId) : true;
    const input = buildLifecycleInput(w, processExists);
    const lifecycle = computeLifecycleState(input, config);
    const decision = decideReaperAction(input, lifecycle, config);

    if (decision.action !== "none") {
      const hbAge = w.lastHeartbeat
        ? new Date(now).getTime() - new Date(w.lastHeartbeat).getTime()
        : null;

      staleDecisions.push({
        workerId: w.workerId,
        contactStatus: w.status,
        lifecycleState: lifecycle.state,
        reaperAction: decision.action,
        reaperReason: decision.reason,
        lastHeartbeat: w.lastHeartbeat ?? null,
        heartbeatAgeMs: hbAge,
      });
    }
  }

  if (!shouldExecute) {
    return successEnvelope({
      ...base,
      extra: {
        command: "reaper",
        dryRun: true,
        executed: false,
        mode,
        thresholdMs,
        totalWorkers: workers.length,
        staleCount: staleDecisions.length,
        staleWorkers: staleDecisions,
      },
    });
  }

  // Execute: produce termination plans for each stale worker
  // Use only supported supervisor-store event types.
  // Never emit worker_reassign or worker_warn as supervisor events.
  const terminationPlans = staleDecisions.map((d) => ({
    workerId: d.workerId,
    action: d.reaperAction,
    reason: d.reaperReason,
    plan: {
      event: "reaper_executed",
      workerId: d.workerId,
      action: d.reaperAction,
      reason: d.reaperReason,
    },
  }));

  // Append lifecycle events when executePorts provided
  const appended: Array<{ type: string; status: string; message?: string }> = [];
  if (executePorts?.appendLifecycleEvent) {
    for (const d of staleDecisions) {
      // First: reaper_planned with candidateWorkerId
      const plannedEv: SupervisorLifecycleEvent = {
        eventId: `ev-reaper-planned-${d.workerId}-${now}`,
        type: "reaper_planned",
        timestamp: now,
        payload: {
          candidateWorkerId: d.workerId,
          reason: d.reaperReason,
          plannedAction: d.reaperAction,
        },
      };
      const plannedResult = executePorts.appendLifecycleEvent(plannedEv);
      appended.push({ type: "reaper_planned", ...plannedResult });

      // Second: reaper_executed or reaper_skipped
      const actionType = plannedResult.status === "appended" ? "reaper_executed" : "reaper_skipped";
      const actionEv: SupervisorLifecycleEvent = {
        eventId: `ev-reaper-action-${d.workerId}-${now}`,
        type: actionType,
        timestamp: now,
        payload: actionType === "reaper_executed"
          ? { workerId: d.workerId, action: d.reaperAction, reason: d.reaperReason }
          : { candidateWorkerId: d.workerId, reason: plannedResult.message || "reaper_planned append failed" },
      };
      const actionResult = executePorts.appendLifecycleEvent(actionEv);
      appended.push({ type: actionType, ...actionResult });
    }
  }

  return successEnvelope({
    ...base,
    extra: {
      command: "reaper",
      dryRun: false,
      executed: true,
      mode,
      thresholdMs,
      totalWorkers: workers.length,
      staleCount: staleDecisions.length,
      terminationPlans,
      appended: appended.length > 0 ? appended : undefined,
    },
  });
}

