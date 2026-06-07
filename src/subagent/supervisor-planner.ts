// Pure supervisor operation planner.
//
// Takes explicit worker snapshots, lease records, and configuration;
// computes planned actions for each worker with audit-friendly reasons.
// No hidden reads from time, filesystem, environment, process, or globals.
//
// Does NOT implement: process killing, IO, or screen writes.
// Uses existing lifecycle functions (computeLifecycleState, decideReaperAction,
// evaluateLease) instead of duplicating state math.

import {
  computeLifecycleState,
  decideReaperAction,
  evaluateLease,
  type LifecycleInput,
  type LifecycleConfig,
  type LifecycleResult,
  type LeaseRecord,
  type LeaseEvaluation,
  type ReaperDecision,
  type WorkerLifecycleState,
} from "./supervisor-lifecycle.js";

import type { WorkerContact } from "./contact-registry.js";

// ---------------------------------------------------------------------------
// Planner types
// ---------------------------------------------------------------------------

export type PlannedActionKind =
  | "noop"
  | "renew_lease"
  | "release_lease"
  | "reap_warn"
  | "reap_reassign"
  | "reap_terminate"
  | "request_shutdown"
  | "skip_shutdown"
  | "mark_terminated"
  | "escalate_missing_process";

export type ActionSeverity = "info" | "warning" | "critical";

export interface ExecutionIntent {
  /** Whether this action should be executed (false for noop/mark_terminated). */
  executable: boolean;
  /** Dry-run guard: planner output is always dryRun:true; caller must opt-in. */
  dryRun: boolean;
  /** The planned action kind this execution intent wraps. */
  intent: PlannedActionKind;
}

export interface PlannedAction {
  /** What action the supervisor should take. */
  kind: PlannedActionKind;
  /** Which worker this action targets. */
  workerId: string;
  /** Human-readable reason for the action. */
  reason: string;
  /** Priority: lower = more urgent. */
  priority: number;
  /** Worker lifecycle state at planning time. */
  lifecycleState: WorkerLifecycleState;
  /** Stable idempotency key for this action (deterministic from inputs). */
  idempotencyKey: string;
  /** Execution intent: whether and how to execute this action. */
  execution: ExecutionIntent;
  /** Severity level for audit/alerting. */
  severity: ActionSeverity;
  /** Risk flags from lifecycle computation, exposed at top level. */
  riskFlags: string[];
  /** Lease evaluation, if a lease was provided. */
  leaseEvaluation?: LeaseEvaluation;
  /** Reaper decision, if applicable. */
  reaperDecision?: ReaperDecision;
  /** Contextual details for audit. */
  context: Record<string, unknown>;
}

export interface PlannerSnapshot {
  /** The worker ID. */
  workerId: string;
  /** Worker contact data from registry. */
  contact: WorkerContact;
  /** Lifecycle input for computeLifecycleState. */
  lifecycleInput: LifecycleInput;
  /** Optional lease record for this worker. */
  lease?: LeaseRecord;
  /** Whether the process is known to exist. */
  processExists: boolean;
  /** Optional PID of the process. */
  pid?: number;
  /** ISO timestamp of when the process was started. */
  processStartTime?: string;
}

export interface PlannerConfig {
  /** Explicit "now" ISO timestamp. No hidden Date.now(). */
  now: string;
  /** Lifecycle configuration (timeouts, thresholds). */
  lifecycleConfig: LifecycleConfig;
  /** Whether automatic lease renewal is enabled. */
  leaseRenewalEnabled: boolean;
  /** Whether automatic reaping/termination is enabled. */
  reapingEnabled: boolean;
  /** Whether shutdown escalation is enabled. */
  shutdownEnabled: boolean;
  /** Whether to include terminated workers in the plan. */
  includeTerminated: boolean;
}

export interface PlannerResult {
  /** The configuration used for this plan. */
  config: PlannerConfig;
  /** Planned actions sorted by priority (lowest first). */
  actions: PlannedAction[];
  /** Summary counts by action kind. */
  summary: Record<PlannedActionKind, number>;
  /** ISO timestamp when the plan was computed. */
  plannedAt: string;
  /** Total number of workers in the snapshot. */
  totalWorkers: number;
  /** Number of terminated workers (no actions needed). */
  terminatedWorkers: number;
}

// ---------------------------------------------------------------------------
// Priority table
// ---------------------------------------------------------------------------

const PRIORITY: Record<PlannedActionKind, number> = {
  escalate_missing_process: 1,
  reap_terminate: 2,
  reap_reassign: 3,
  request_shutdown: 4,
  release_lease: 5,
  reap_warn: 6,
  renew_lease: 7,
  skip_shutdown: 8,
  mark_terminated: 9,
  noop: 10,
};

// ---------------------------------------------------------------------------
// Severity by action kind
// ---------------------------------------------------------------------------

function severityForKind(kind: PlannedActionKind): ActionSeverity {
  switch (kind) {
    case "escalate_missing_process":
    case "reap_terminate":
    case "request_shutdown":
      return "critical";
    case "reap_reassign":
    case "release_lease":
    case "reap_warn":
    case "renew_lease":
    case "skip_shutdown":
      return "warning";
    case "mark_terminated":
    case "noop":
      return "info";
    default:
      return "info";
  }
}

// ---------------------------------------------------------------------------
// Executable check by action kind
// ---------------------------------------------------------------------------

function executableForKind(kind: PlannedActionKind): boolean {
  switch (kind) {
    case "noop":
    case "mark_terminated":
      return false;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Deterministic idempotency key
// ---------------------------------------------------------------------------

function makeIdempotencyKey(
  workerId: string,
  kind: PlannedActionKind,
  plannedAt: string,
  reason: string,
): string {
  // Naive deterministic key: concat and hash-approximate.
  // Not cryptographic; just stable for same inputs.
  const raw = `${workerId}|${kind}|${plannedAt}|${reason}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  // Use positive hex representation
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${kind}-${workerId}-${hex}`;
}

// ---------------------------------------------------------------------------
// Default summary builder
// ---------------------------------------------------------------------------

function emptySummary(): Record<PlannedActionKind, number> {
  return {
    noop: 0,
    renew_lease: 0,
    release_lease: 0,
    reap_warn: 0,
    reap_reassign: 0,
    reap_terminate: 0,
    request_shutdown: 0,
    skip_shutdown: 0,
    mark_terminated: 0,
    escalate_missing_process: 0,
  };
}

// ---------------------------------------------------------------------------
// Plan a single worker
// ---------------------------------------------------------------------------

function planWorker(
  snapshot: PlannerSnapshot,
  config: PlannerConfig,
): PlannedAction {
  const { workerId, lifecycleInput, lease } = snapshot;

  // 1. Compute lifecycle state using the existing pure function.
  const lifecycle = computeLifecycleState(lifecycleInput, config.lifecycleConfig);

  // 2. Evaluate lease if present.
  const leaseEvaluation = lease
    ? evaluateLease(lease, config.now, config.lifecycleConfig)
    : undefined;

  // --- Helper to assemble the final action with all required fields ---
  const finishAction = (
    kind: PlannedActionKind,
    reason: string,
    riskFlags: string[],
    extraContext: Record<string, unknown> = {},
  ): PlannedAction => ({
    kind,
    workerId,
    reason,
    priority: PRIORITY[kind],
    lifecycleState: lifecycle.state,
    idempotencyKey: makeIdempotencyKey(workerId, kind, config.now, reason),
    execution: {
      executable: executableForKind(kind),
      dryRun: true, // Always dryRun:true in planner output
      intent: kind,
    },
    severity: severityForKind(kind),
    riskFlags,
    leaseEvaluation,
    context: {
      lifecycle,
      riskFlags: lifecycle.riskFlags,
      ...extraContext,
    },
  });

  // 3. Already terminated — no further action needed.
  if (lifecycle.state === "terminated") {
    if (config.includeTerminated) {
      return finishAction(
        "mark_terminated",
        `Worker terminated: ${lifecycle.reason}`,
        [],
      );
    }
    return finishAction("noop", lifecycle.reason, []);
  }

  // 4. Shutdown requested — decide if it's within grace period or beyond.
  if (
    lifecycle.state === "grace_period" ||
    lifecycle.state === "shutdown"
  ) {
    if (!config.shutdownEnabled) {
      return finishAction(
        "skip_shutdown",
        `Shutdown disabled, state is ${lifecycle.state}: ${lifecycle.reason}`,
        lifecycle.riskFlags,
        { ageMs: lifecycle.evidence.ageMs },
      );
    }

    if (lifecycle.state === "grace_period") {
      // In grace period — skip, let worker shut down gracefully.
      return finishAction("skip_shutdown", lifecycle.reason, lifecycle.riskFlags, {
        ageMs: lifecycle.evidence.ageMs,
      });
    }

    // shutdown state — request formal shutdown.
    return finishAction(
      "request_shutdown",
      lifecycle.reason,
      lifecycle.riskFlags,
      { ageMs: lifecycle.evidence.ageMs },
    );
  }

  // 5. Missing process — escalate.
  if (lifecycle.state === "missing_process") {
    return finishAction(
      "escalate_missing_process",
      lifecycle.reason,
      lifecycle.riskFlags,
    );
  }

  // 6. For healthy, stale, expired — consider reaper and lease actions.
  const reaperDecision = config.reapingEnabled
    ? decideReaperAction(lifecycleInput, lifecycle, config.lifecycleConfig)
    : undefined;

  // Determine reaping action based on reaper decision.
  if (reaperDecision && reaperDecision.action !== "none") {
    let reapKind: PlannedActionKind;
    switch (reaperDecision.action) {
      case "warn":
        reapKind = "reap_warn";
        break;
      case "reassign":
        reapKind = "reap_reassign";
        break;
      case "terminate":
        reapKind = "reap_terminate";
        break;
      default:
        reapKind = "reap_warn";
    }

    const action = finishAction(reapKind, reaperDecision.reason, lifecycle.riskFlags);
    action.reaperDecision = reaperDecision;
    return action;
  }

  // 7. Lease actions — renewal or release.
  if (lease && config.leaseRenewalEnabled) {
    if (leaseEvaluation) {
      if (leaseEvaluation.status === "valid" && leaseEvaluation.remainingMs !== undefined) {
        // Consider renewal if close to expiry (within 25% of remaining).
        const leasePeriod = config.lifecycleConfig.leaseMaxAgeMs;
        if (leaseEvaluation.remainingMs < leasePeriod * 0.25) {
          return finishAction(
            "renew_lease",
            `Lease valid but close to expiry: ${leaseEvaluation.reason}`,
            lifecycle.riskFlags,
            { remainingMs: leaseEvaluation.remainingMs },
          );
        }
      } else if (leaseEvaluation.status === "expired") {
        return finishAction(
          "release_lease",
          `Lease expired: ${leaseEvaluation.reason}`,
          lifecycle.riskFlags,
        );
      }
      // released — no action, already handled.
    }
  }

  // 8. No action needed — worker is healthy.
  return finishAction(
    "noop",
    `Worker is ${lifecycle.state}: ${lifecycle.reason}`,
    lifecycle.riskFlags,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a supervisor operation plan from worker snapshots and configuration.
 * Pure function — no side effects, no hidden I/O or time reads.
 */
export function computeSupervisorPlan(
  snapshots: PlannerSnapshot[],
  config: PlannerConfig,
): PlannerResult {
  const actions: PlannedAction[] = [];

  for (const snapshot of snapshots) {
    const action = planWorker(snapshot, config);
    actions.push(action);
  }

  // Sort by priority ascending.
  actions.sort((a, b) => a.priority - b.priority);

  // Build summary.
  const summary = emptySummary();
  let terminatedWorkers = 0;

  for (const action of actions) {
    summary[action.kind] += 1;
    if (
      action.lifecycleState === "terminated" ||
      action.kind === "mark_terminated"
    ) {
      terminatedWorkers += 1;
    }
  }

  return {
    config,
    actions,
    summary,
    plannedAt: config.now,
    totalWorkers: snapshots.length,
    terminatedWorkers,
  };
}

/**
 * Extract a worker snapshot from a WorkerContact, lifecycle input, and optional lease.
 * Convenience helper that avoids manual assembly.
 */
export function buildSnapshot(
  contact: WorkerContact,
  lifecycleInput: LifecycleInput,
  lease?: LeaseRecord,
  pid?: number,
  processStartTime?: string,
): PlannerSnapshot {
  return {
    workerId: contact.workerId,
    contact,
    lifecycleInput,
    lease,
    processExists: lifecycleInput.processExists,
    pid,
    processStartTime,
  };
}
