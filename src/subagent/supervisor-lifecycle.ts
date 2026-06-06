// Pure supervisor lifecycle decision domain.
//
// Provides deterministic lifecycle/lease/heartbeat/reaper decisions
// for the sub-agent team supervisor. All functions take explicit inputs;
// no hidden reads from time, filesystem, environment, or globals.
//
// Consumed by: CLI, store workers, TUI, and master agent.
// Does NOT implement: runtime IO, process management, file persistence.

// ---- Types ----

export type WorkerLifecycleState =
  | "healthy"
  | "stale"
  | "expired"
  | "grace_period"
  | "shutdown"
  | "terminated"
  | "missing_process"
  | "unknown";

export interface LifecycleInput {
  workerId: string;
  contactStatus: string;
  lastHeartbeat?: string;
  lastEvidence?: string;
  runStatus?: string;
  runLastStepAt?: string;
  ledgerOpenProblems?: number;
  ledgerLastActivityAt?: string;
  processExists: boolean;
  processStartTime?: string;
  shutdownRequestedAt?: string;
  terminatedAt?: string;
}

export interface LifecycleConfig {
  now: string;
  heartbeatMaxAgeMs: number;
  evidenceMaxAgeMs: number;
  leaseMaxAgeMs: number;
  gracePeriodMs: number;
  shutdownMaxAgeMs: number;
  processMissingMaxAgeMs: number;
}

export interface HeartbeatInterpretation {
  kind: "healthy" | "stale" | "expired" | "missing";
  ageMs?: number;
  thresholdMs: number;
}

export interface LeaseRecord {
  leaseId: string;
  workerId: string;
  taskId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  releasedAt?: string;
}

export type LeaseStatus = "valid" | "expired" | "released" | "invalid";

export interface LeaseEvaluation {
  status: LeaseStatus;
  reason: string;
  remainingMs?: number;
}

export interface ProcessTableEntry {
  pid: number;
  workerId: string;
  startTime: string;
  exists: boolean;
}

export interface LifecycleEvidence {
  heartbeatInterpretation: HeartbeatInterpretation;
  leaseEvaluation?: LeaseEvaluation;
  processExists: boolean;
  ageMs?: number;
}

export interface LifecycleResult {
  state: WorkerLifecycleState;
  reason: string;
  evidence: LifecycleEvidence;
  riskFlags: string[];
}

export type ReaperActionKind = "none" | "warn" | "reassign" | "terminate";

export interface ReaperDecision {
  action: ReaperActionKind;
  reason: string;
  workerId: string;
}

export interface LifecycleAuditReason {
  fromState: WorkerLifecycleState;
  toState: WorkerLifecycleState;
  event: string;
  decidedAt: string;
  workerId?: string;
  context: Record<string, unknown>;
}

// ---- Pure helpers ----

function isoToMs(iso: string): number {
  if (typeof iso !== "string" || iso.length < 20) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(iso);
  if (!m) return 0;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6], ms = +m[7];
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

function computeAge(timestamp: string | undefined, now: string): number | undefined {
  if (!timestamp) return undefined;
  const tsMs = isoToMs(timestamp);
  if (tsMs === 0) return undefined;
  const nowMs = isoToMs(now);
  if (nowMs === 0) return undefined;
  return nowMs - tsMs;
}

// ---- interpretHeartbeat ----

export function interpretHeartbeat(
  heartbeat: string | undefined,
  now: string,
  config: LifecycleConfig,
): HeartbeatInterpretation {
  if (!heartbeat) {
    return { kind: "missing", thresholdMs: config.heartbeatMaxAgeMs };
  }

  const ageMs = computeAge(heartbeat, now);
  if (ageMs === undefined) {
    return { kind: "missing", thresholdMs: config.heartbeatMaxAgeMs };
  }

  // Stale threshold: heartbeatMaxAgeMs
  // Expired threshold: heartbeatMaxAgeMs * 2
  const expiredThreshold = config.heartbeatMaxAgeMs * 2;

  if (ageMs <= config.heartbeatMaxAgeMs) {
    return { kind: "healthy", ageMs, thresholdMs: config.heartbeatMaxAgeMs };
  }
  if (ageMs <= expiredThreshold) {
    return { kind: "stale", ageMs, thresholdMs: config.heartbeatMaxAgeMs };
  }
  return { kind: "expired", ageMs, thresholdMs: config.heartbeatMaxAgeMs };
}

// ---- evaluateLease ----

export function evaluateLease(
  lease: LeaseRecord,
  now: string,
  config: LifecycleConfig,
): LeaseEvaluation {
  if (lease.releasedAt) {
    return { status: "released", reason: "Lease has been released" };
  }

  if (!lease.expiresAt) {
    return { status: "invalid", reason: "Lease has no expiration time" };
  }

  const expiresMs = isoToMs(lease.expiresAt);
  if (expiresMs === 0) {
    return { status: "invalid", reason: "Invalid expiration timestamp" };
  }

  const nowMs = isoToMs(now);
  const remainingMs = expiresMs - nowMs;

  if (remainingMs <= 0) {
    return { status: "expired", reason: `Lease expired at ${lease.expiresAt}`, remainingMs };
  }

  return { status: "valid", reason: `Lease valid, expires at ${lease.expiresAt}`, remainingMs };
}

// ---- computeLifecycleState ----

export function computeLifecycleState(
  input: LifecycleInput,
  config: LifecycleConfig,
): LifecycleResult {
  const riskFlags: string[] = [];

  // 1. Terminated contact is always terminated
  if (input.contactStatus === "terminated" || input.terminatedAt) {
    return {
      state: "terminated",
      reason: "Worker contact is terminated",
      evidence: {
        heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
        processExists: input.processExists,
      },
      riskFlags: [],
    };
  }

  // 2. Offline with no recent signals -> terminated
  if (input.contactStatus === "offline") {
    const hbAge = computeAge(input.lastHeartbeat, config.now);
    if (hbAge === undefined || hbAge > config.processMissingMaxAgeMs) {
      return {
        state: "terminated",
        reason: "Offline worker with no recent heartbeat",
        evidence: {
          heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
          processExists: input.processExists,
        },
        riskFlags: [],
      };
    }
  }

  // 3. Shutdown requested
  if (input.shutdownRequestedAt) {
    const shutdownAge = computeAge(input.shutdownRequestedAt, config.now);
    if (shutdownAge !== undefined) {
      if (shutdownAge <= config.gracePeriodMs) {
        return {
          state: "grace_period",
          reason: "Shutdown requested, within grace period",
          evidence: {
            heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
            processExists: input.processExists,
            ageMs: shutdownAge,
          },
          riskFlags: [],
        };
      }
      if (shutdownAge <= config.shutdownMaxAgeMs) {
        return {
          state: "shutdown",
          reason: "Shutdown in progress",
          evidence: {
            heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
            processExists: input.processExists,
            ageMs: shutdownAge,
          },
          riskFlags: [],
        };
      }
      // Beyond shutdown max age -> treat as terminated
      return {
        state: "terminated",
        reason: "Shutdown exceeded maximum age",
        evidence: {
          heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
          processExists: input.processExists,
          ageMs: shutdownAge,
        },
        riskFlags: [],
      };
    }
  }

  // 4. Process existence check
  if (!input.processExists) {
    const hbAge = computeAge(input.lastHeartbeat, config.now);
    if (hbAge !== undefined && hbAge > config.processMissingMaxAgeMs) {
      return {
        state: "missing_process",
        reason: "Process not found and heartbeat is stale",
        evidence: {
          heartbeatInterpretation: interpretHeartbeat(input.lastHeartbeat, config.now, config),
          processExists: false,
          ageMs: hbAge,
        },
        riskFlags: ["missing_process"],
      };
    }
  }

  // 5. Heartbeat-based classification
  const hbInterpretation = interpretHeartbeat(input.lastHeartbeat, config.now, config);
  const evidenceAge = computeAge(input.lastEvidence, config.now);

  if (hbInterpretation.kind === "expired") {
    riskFlags.push("stale_heartbeat");
    return {
      state: "expired",
      reason: "Heartbeat has expired",
      evidence: {
        heartbeatInterpretation: hbInterpretation,
        processExists: input.processExists,
        ageMs: hbInterpretation.ageMs,
      },
      riskFlags,
    };
  }

  if (hbInterpretation.kind === "stale") {
    riskFlags.push("stale_heartbeat");
    // If evidence is also stale, it's more severe
    if (evidenceAge !== undefined && evidenceAge > config.evidenceMaxAgeMs) {
      riskFlags.push("stale_evidence");
      return {
        state: "expired",
        reason: "Heartbeat stale and evidence outdated",
        evidence: {
          heartbeatInterpretation: hbInterpretation,
          processExists: input.processExists,
          ageMs: hbInterpretation.ageMs,
        },
        riskFlags,
      };
    }
    return {
      state: "stale",
      reason: "Heartbeat is stale but evidence is recent",
      evidence: {
        heartbeatInterpretation: hbInterpretation,
        processExists: input.processExists,
        ageMs: hbInterpretation.ageMs,
      },
      riskFlags,
    };
  }

  if (hbInterpretation.kind === "missing") {
    // Missing heartbeat but process exists and run is recent -> still healthy
    const runAge = computeAge(input.runLastStepAt, config.now);
    if (input.processExists && runAge !== undefined && runAge <= config.heartbeatMaxAgeMs) {
      return {
        state: "healthy",
        reason: "No heartbeat but process exists with recent run activity",
        evidence: {
          heartbeatInterpretation: hbInterpretation,
          processExists: input.processExists,
        },
        riskFlags: [],
      };
    }
    riskFlags.push("missing_heartbeat");
    return {
      state: "stale",
      reason: "Heartbeat is missing",
      evidence: {
        heartbeatInterpretation: hbInterpretation,
        processExists: input.processExists,
      },
      riskFlags,
    };
  }

  // 6. Check evidence staleness for healthy workers
  if (evidenceAge !== undefined && evidenceAge > config.evidenceMaxAgeMs) {
    riskFlags.push("stale_evidence");
    return {
      state: "stale",
      reason: "Evidence is outdated",
      evidence: {
        heartbeatInterpretation: hbInterpretation,
        processExists: input.processExists,
        ageMs: evidenceAge,
      },
      riskFlags,
    };
  }

  // 7. Healthy
  return {
    state: "healthy",
    reason: "All signals are recent and healthy",
    evidence: {
      heartbeatInterpretation: hbInterpretation,
      processExists: input.processExists,
    },
    riskFlags: [],
  };
}

// ---- isGracePeriodActive ----

export function isGracePeriodActive(
  state: LifecycleResult,
  config: LifecycleConfig,
): boolean {
  if (!state.evidence.ageMs) return false;
  return state.state === "grace_period" && state.evidence.ageMs <= config.gracePeriodMs;
}

// ---- decideReaperAction ----

export function decideReaperAction(
  input: LifecycleInput,
  lifecycle: LifecycleResult,
  config: LifecycleConfig,
): ReaperDecision {
  const { state } = lifecycle;

  switch (state) {
    case "healthy":
    case "grace_period":
    case "shutdown":
    case "terminated":
      return {
        action: "none",
        reason: `No reap action needed for ${state} worker`,
        workerId: input.workerId,
      };

    case "stale":
      // If there are open ledger problems, reassign rather than warn
      if (input.ledgerOpenProblems && input.ledgerOpenProblems > 0) {
        return {
          action: "reassign",
          reason: `Stale worker with ${input.ledgerOpenProblems} open ledger problems`,
          workerId: input.workerId,
        };
      }
      return {
        action: "warn",
        reason: "Worker heartbeat is stale",
        workerId: input.workerId,
      };

    case "expired":
    case "missing_process":
      return {
        action: "terminate",
        reason: `Worker is in ${state} state`,
        workerId: input.workerId,
      };

    default:
      return {
        action: "warn",
        reason: `Unknown lifecycle state: ${state}`,
        workerId: input.workerId,
      };
  }
}

// ---- auditReason ----

export function auditReason(
  now: string,

  toState: WorkerLifecycleState,
  fromState: WorkerLifecycleState,
  event: string,
  context: Record<string, unknown> = {},
  workerId?: string,
): LifecycleAuditReason {
  return {
    fromState,
    toState,
    event,
    decidedAt: now,
    workerId,
    context,
  };
}
