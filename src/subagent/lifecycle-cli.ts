// Lifecycle CLI — pure command parsing and service layer for lifecycle subcommands.
// Consumes contact-registry FSM. Produces typed results; no shell/pty dependency.

import type {
  WorkerContact,
  WorkerContactStatus,
  ContactRegistryState,
  ContactRegistryEvent,
  ContactRegistryResult,
} from "./contact-registry.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  summarizeContactRegistry,
  lookupWorker,
  listWorkersByStatus,
} from "./contact-registry.js";
import {
  successEnvelope,
  failureEnvelope,
  type CliEnvelope,
  type SuccessEnvelopeInput,
} from "../cli/envelope.js";

// ---------------------------------------------------------------------------
// Tool name for JSON envelope
// ---------------------------------------------------------------------------
const TOOL_NAME = "team";

// ---------------------------------------------------------------------------
// Explicit dependency ports — no hidden time or id generation in core logic
// ---------------------------------------------------------------------------
export type LifecycleCliPorts = {
  /** ISO-8601 timestamp — explicit clock input */
  nowIso: () => string;
  /** Generate a unique event id — explicit id generation */
  newEventId: (prefix: string) => string;
};

// ---------------------------------------------------------------------------
// In-memory service state
// ---------------------------------------------------------------------------
export type LifecycleServiceState = {
  contactRegistry: ContactRegistryState;
};

export function createLifecycleServiceState(
  registryState?: ContactRegistryState,
): LifecycleServiceState {
  return {
    contactRegistry: registryState ?? createContactRegistryState("default-registry"),
  };
}

// ---------------------------------------------------------------------------
// Pure command dispatcher
// ---------------------------------------------------------------------------
export function executeLifecycleCommand(
  ports: LifecycleCliPorts,
  state: LifecycleServiceState,
  args: string[],
  cwd?: string,
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
  switch (subcommand) {
    case "lifecycle-status":
      return handleLifecycleStatus(ports, state, args.slice(1), cwd);
    case "lease":
      return handleLease(ports, state, args.slice(1), cwd);
    case "shutdown":
      return handleShutdown(ports, state, args.slice(1), cwd);
    case "reaper":
      return handleReaper(ports, state, args.slice(1), cwd);
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
  state: LifecycleServiceState,
  args: string[],
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "USAGE",
      error: "Usage: team lifecycle-status <workerId>",
    });
  }

  const workerId = args[0];
  const worker = lookupWorker(state.contactRegistry, workerId);
  if (!worker) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "UNKNOWN_WORKER",
      error: `Unknown worker: "${workerId}".`,
    });
  }

  const now = ports.nowIso();
  const nowMs = new Date(now).getTime();
  const heartbeatMs = worker.lastHeartbeat ? new Date(worker.lastHeartbeat).getTime() : null;
  const heartbeatAgeMs = heartbeatMs !== null ? nowMs - heartbeatMs : null;

  return successEnvelope({
    ...base,
    extra: {
      command: "lifecycle-status",
      workerId: worker.workerId,
      role: worker.role,
      status: worker.status,
      workspace: worker.workspace,
      branch: worker.branch,
      imChannel: worker.imChannel,
      lastHeartbeat: worker.lastHeartbeat ?? null,
      lastHeartbeatAgeMs: heartbeatAgeMs,
      hasHeartbeat: worker.lastHeartbeat != null,
      hasEvidence: worker.lastEvidence != null,
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
  state: LifecycleServiceState,
  args: string[],
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "USAGE",
      error: "Usage: team lease <workerId> [--expiry-ms <ms>]",
    });
  }

  const workerId = args[0];
  const worker = lookupWorker(state.contactRegistry, workerId);
  if (!worker) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "UNKNOWN_WORKER",
      error: `Unknown worker: "${workerId}".`,
    });
  }

  // Parse optional --expiry-ms flag
  let expiryMs: number | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--expiry-ms" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "INVALID_ARG",
          error: `Invalid --expiry-ms value: "${args[i + 1]}". Must be a positive integer.`,
        });
      }
      expiryMs = parsed;
      break;
    }
  }

  const now = ports.nowIso();
  const event: ContactRegistryEvent = {
    kind: "worker_heartbeat",
    eventId: ports.newEventId("ev-hb"),
    workerId,
    timestamp: now,
  };

  const result = applyContactRegistryEvent(state.contactRegistry, event);
  if (result.status === "rejected") {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "FSM_REJECTED",
      error: result.rejection.message,
    });
  }

  const newState: LifecycleServiceState = {
    contactRegistry: result.state,
  };

  return successEnvelope({
    ...base,
    extra: {
      command: "lease",
      workerId,
      newHeartbeat: now,
      expiryMs,
      leaseExpiresAt: expiryMs ? new Date(new Date(now).getTime() + expiryMs).toISOString() : null,
      state: newState,
    },
  });
}

// ---------------------------------------------------------------------------
// Shutdown handler
// ---------------------------------------------------------------------------
function handleShutdown(
  ports: LifecycleCliPorts,
  state: LifecycleServiceState,
  args: string[],
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "USAGE",
      error: "Usage: team shutdown <workerId> [--execute]",
    });
  }

  const workerId = args[0];
  const worker = lookupWorker(state.contactRegistry, workerId);
  if (!worker) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "UNKNOWN_WORKER",
      error: `Unknown worker: "${workerId}".`,
    });
  }

  // Check for --execute flag
  const execute = args.includes("--execute");

  if (!execute) {
    // Dry-run: return plan only, no state change
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
          targetStatus: "offline" as WorkerContactStatus,
          reason: "Shutdown requested",
          timestamp: ports.nowIso(),
        },
      },
    });
  }

  // Execute: change worker status to offline
  const statusEvent: ContactRegistryEvent = {
    kind: "worker_status_changed",
    eventId: ports.newEventId("ev-status"),
    workerId,
    status: "offline",
    reason: "Shutdown requested via lifecycle CLI",
  };

  const statusResult = applyContactRegistryEvent(state.contactRegistry, statusEvent);
  if (statusResult.status === "rejected") {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "FSM_REJECTED",
      error: statusResult.rejection.message,
    });
  }

  const newState: LifecycleServiceState = {
    contactRegistry: statusResult.state,
  };

  return successEnvelope({
    ...base,
    extra: {
      command: "shutdown",
      dryRun: false,
      executed: true,
      workerId,
      previousStatus: worker.status,
      newStatus: "offline",
      state: newState,
    },
  });
}

// ---------------------------------------------------------------------------
// Stale reaper handler
// ---------------------------------------------------------------------------
function handleReaper(
  ports: LifecycleCliPorts,
  state: LifecycleServiceState,
  args: string[],
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  if (args.length < 1) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "USAGE",
      error: "Usage: team reaper list|execute [--threshold-ms <ms>] [--execute]",
    });
  }

  const mode = args[0];
  if (mode !== "list" && mode !== "execute") {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "INVALID_MODE",
      error: `Unknown reaper mode: "${mode}". Expected "list" or "execute".`,
    });
  }

  // Parse --threshold-ms flag (default: 5 minutes = 300000ms)
  let thresholdMs = 300000;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--threshold-ms" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "INVALID_ARG",
          error: `Invalid --threshold-ms value: "${args[i + 1]}". Must be a positive integer.`,
        });
      }
      thresholdMs = parsed;
      break;
    }
  }

  // Check for --execute flag
  const executeFlag = args.includes("--execute");
  const shouldExecute = mode === "execute" && executeFlag;

  const now = ports.nowIso();
  const nowMs = new Date(now).getTime();

  // Find all stale workers
  const allWorkers = Object.values(state.contactRegistry.workers);
  const nonTerminated = allWorkers.filter((w) => w.status !== "terminated");

  const staleWorkers: Array<{
    workerId: string;
    status: WorkerContactStatus;
    lastHeartbeat: string | null;
    heartbeatAgeMs: number | null;
    reason: string;
  }> = [];

  for (const w of nonTerminated) {
    if (!w.lastHeartbeat) {
      // Never heartbeated — treat as stale
      staleWorkers.push({
        workerId: w.workerId,
        status: w.status,
        lastHeartbeat: null,
        heartbeatAgeMs: null,
        reason: "No heartbeat recorded",
      });
      continue;
    }

    const heartbeatMs = new Date(w.lastHeartbeat).getTime();
    const ageMs = nowMs - heartbeatMs;

    if (ageMs > thresholdMs) {
      staleWorkers.push({
        workerId: w.workerId,
        status: w.status,
        lastHeartbeat: w.lastHeartbeat,
        heartbeatAgeMs: ageMs,
        reason: `Heartbeat age ${ageMs}ms exceeds threshold ${thresholdMs}ms`,
      });
    }
  }

  if (!shouldExecute) {
    // Dry-run: return stale worker list
    return successEnvelope({
      ...base,
      extra: {
        command: "reaper",
        dryRun: true,
        executed: false,
        mode,
        thresholdMs,
        totalWorkers: allWorkers.length,
        nonTerminatedWorkers: nonTerminated.length,
        staleWorkers,
        staleCount: staleWorkers.length,
      },
    });
  }

  // Execute: terminate stale workers
  const terminatedWorkers: Array<{
    workerId: string;
    previousStatus: WorkerContactStatus;
    result: "terminated" | "failed";
    reason?: string;
  }> = [];

  let currentState = state.contactRegistry;

  for (const sw of staleWorkers) {
    const termEvent: ContactRegistryEvent = {
      kind: "worker_terminated",
      eventId: ports.newEventId("ev-term"),
      workerId: sw.workerId,
      reason: `Stale reaper: ${sw.reason}`,
    };

    const termResult = applyContactRegistryEvent(currentState, termEvent);

    if (termResult.status === "applied") {
      currentState = termResult.state;
      terminatedWorkers.push({
        workerId: sw.workerId,
        previousStatus: sw.status,
        result: "terminated",
      });
    } else {
      terminatedWorkers.push({
        workerId: sw.workerId,
        previousStatus: sw.status,
        result: "failed",
        reason: termResult.status === "rejected" ? termResult.rejection.message : "duplicate",
      });
      currentState = termResult.state;
    }
  }

  const newState: LifecycleServiceState = {
    contactRegistry: currentState,
  };

  return successEnvelope({
    ...base,
    extra: {
      command: "reaper",
      dryRun: false,
      executed: true,
      mode,
      thresholdMs,
      totalWorkers: allWorkers.length,
      staleWorkersFound: staleWorkers.length,
      terminatedWorkers,
      terminatedCount: terminatedWorkers.filter((t) => t.result === "terminated").length,
      failedCount: terminatedWorkers.filter((t) => t.result === "failed").length,
      state: newState,
    },
  });
}
