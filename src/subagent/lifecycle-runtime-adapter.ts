// Lifecycle Runtime Adapter — run-scoped lifecycle operations.
//
// Takes explicit team snapshots, supervisor events, and injected ports.
// No hidden reads from Date.now, fs, process.kill, process.cwd.
// No process-local state — idempotency comes from event IDs in the store.
//
// Consumed by: reaper, lease heartbeat, shutdown, test harness.
// Does NOT implement: real CLI process killing, real filesystem IO.

import type { TeamMember, TeamRosterEvent } from "./team-roster.js";
import type {
  SupervisorLifecycleEvent,
  SupervisorLifecycleEventType,
} from "./supervisor-store.js";
import {
  interpretHeartbeat,
  evaluateLease,
  computeLifecycleState,
  decideReaperAction,
  type LifecycleInput,
  type LifecycleConfig,
  type HeartbeatInterpretation,
  type LeaseRecord,
  type ReaperDecision,
  type WorkerLifecycleState,
} from "./supervisor-lifecycle.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClockIdPort {
  nowIso: () => string;
  generateId: (prefix: string, workerId: string) => string;
}

export interface SupervisorEventPort {
  appendSupervisorEvent: (
    event: SupervisorLifecycleEvent,
  ) => Promise<{ status: "appended" | "duplicate" | "error"; message?: string }>;
  readEvents?: () => Promise<SupervisorLifecycleEvent[]>;
}

export interface ShutdownWorkerPort {
  shutdownWorker: (workerId: string, reason?: string) => Promise<void>;
}

export interface ContactEventPort {
  applyContactEvent: (event: TeamRosterEvent) => Promise<string>;
}

export interface LifecycleRuntimePorts
  extends ClockIdPort,
    SupervisorEventPort,
    ShutdownWorkerPort,
    ContactEventPort {}

export interface TeamSnapshot {
  rosterState: {
    members: Record<string, TeamMember>;
    teamId: string;
    appliedEventIds: string[];
  };
  supervisorEvents: SupervisorLifecycleEvent[];
  createdAt: string;
  runId: string;
  /** Per-worker process existence. If absent for a worker, defaults to true. */
  processExistence?: Record<string, boolean>;
}

export interface LeaseFacts {
  leaseId: string | null;
  leaseStatus: "valid" | "expired" | "released" | "none";
  leaseExpiresAt: string | null;
  leaseAcquiredAt: string | null;
  leaseRenewedAt: string | null;
}

export interface WorkerFacts {
  workerId: string;
  memberStatus: string;
  lifecycleState: WorkerLifecycleState;
  heartbeatInterpretation: HeartbeatInterpretation;
  leaseFacts: LeaseFacts | null;
  reaperDecision: ReaperDecision | null;
  isStale: boolean;
  riskFlags: string[];
}

export interface WorkerEnumerationResult {
  totalWorkers: number;
  workers: WorkerFacts[];
  activeWorkers: WorkerFacts[];
  terminatedWorkers: WorkerFacts[];
  staleWorkers: WorkerFacts[];
}

export interface HeartbeatEnvelope {
  status: "ok" | "error";
  workerId: string;
  errorCode?: string;
  error?: string;
  timestamp?: string;
  heartbeatInterpretation?: HeartbeatInterpretation;
  leaseAction?: "acquired" | "renewed" | "none";
  leaseId?: string;
  leaseExpiresAt?: string;
}

export interface ReaperEnvelope {
  status: "ok" | "error";
  errorCode?: string;
  error?: string;
  dryRun: boolean;
  executed: boolean;
  totalWorkers: number;
  staleCount: number;
  thresholdMs: number;
  plannedActions?: Array<{
    workerId: string;
    action: string;
    reason: string;
    eventType: string;
  }>;
  failures?: Array<{ workerId: string; error: string }>;
  appended?: Array<{ type: string; status: string; message?: string }>;
}

export interface ShutdownEnvelope {
  status: "ok" | "error";
  workerId: string;
  errorCode?: string;
  error?: string;
  dryRun: boolean;
  executed: boolean;
  plan?: {
    event: string;
    workerId: string;
    targetStatus: string;
    reason: string;
    timestamp: string;
  };
  appended?: Array<{ type: string; status: string; message?: string }>;
}

// ---------------------------------------------------------------------------
// LifecycleRuntimeAdapter
// ---------------------------------------------------------------------------

export interface LifecycleRuntimeAdapter {
  recordHeartbeat(
    worker: TeamMember,
    supervisorEvents: SupervisorLifecycleEvent[],
    options: {
      heartbeatNow: string;
      leaseDurationMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<HeartbeatEnvelope>;

  enumerateWorkers(
    snapshot: TeamSnapshot,
    options: { now: string; staleThresholdMs: number },
  ): Promise<WorkerEnumerationResult>;

  runReaper(
    snapshot: TeamSnapshot,
    options: { now: string; staleThresholdMs: number; execute: boolean },
  ): Promise<ReaperEnvelope>;

  requestShutdown(
    worker: TeamMember,
    options: { now: string; reason: string; execute: boolean },
  ): Promise<ShutdownEnvelope>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
  heartbeatMaxAgeMs: 300_000,
  evidenceMaxAgeMs: 600_000,
  leaseMaxAgeMs: 1_800_000,
  gracePeriodMs: 60_000,
  shutdownMaxAgeMs: 300_000,
  processMissingMaxAgeMs: 600_000,
};

function buildConfig(now: string): LifecycleConfig {
  return { now, ...DEFAULT_THRESHOLDS };
}

function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

function buildLifecycleInput(
  worker: TeamMember,
  processExists: boolean,
): LifecycleInput {
  return {
    workerId: worker.memberId,
    memberStatus: worker.status,
    lastHeartbeat: worker.lastHeartbeat,
    lastEvidence: worker.lastEvidence,
    processExists,
  };
}

/**
 * Parse a lease record from a supervisor event.
 * For lease_renewed, the payload uses newExpiresAt as the active expiresAt.
 * The returned LeaseRecord always has a populated expiresAt.
 */
function parseLeaseFromEvent(event: SupervisorLifecycleEvent): LeaseRecord | null {
  try {
    const p = event.payload as any;
    if (event.type === "lease_acquired") {
      if (
        typeof p.workerId === "string" &&
        typeof p.leaseId === "string" &&
        typeof p.expiresAt === "string"
      ) {
        return {
          leaseId: p.leaseId,
          workerId: p.workerId,
          taskId: (p.taskId as string) ?? p.resource ?? "",
          acquiredAt: typeof p.acquiredAt === "string" ? p.acquiredAt : event.timestamp,
          expiresAt: p.expiresAt,
          renewedAt: undefined,
          releasedAt: undefined,
        };
      }
    }
    if (event.type === "lease_renewed") {
      // lease_renewed carries newExpiresAt as the effective expiry
      const expiresAt = (typeof p.newExpiresAt === "string" ? p.newExpiresAt : undefined)
        ?? (typeof p.expiresAt === "string" ? p.expiresAt : undefined);
      if (
        typeof p.workerId === "string" &&
        typeof p.leaseId === "string" &&
        typeof expiresAt === "string"
      ) {
        return {
          leaseId: p.leaseId,
          workerId: p.workerId,
          taskId: (p.taskId as string) ?? "",
          acquiredAt: typeof p.acquiredAt === "string" ? p.acquiredAt : event.timestamp,
          expiresAt,
          renewedAt: event.timestamp,
          releasedAt: undefined,
        };
      }
    }
    if (
      event.type === "lease_released" &&
      typeof p.workerId === "string" &&
      typeof p.leaseId === "string"
    ) {
      return {
        leaseId: p.leaseId,
        workerId: p.workerId,
        taskId: (p.taskId as string) ?? "",
        acquiredAt: event.timestamp,
        expiresAt: event.timestamp,
        releasedAt: event.timestamp,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function findLatestLease(
  events: SupervisorLifecycleEvent[],
  workerId: string,
): LeaseRecord | null {
  const workerLeaseEvents = events
    .filter(
      (e) =>
        (e.type === "lease_acquired" ||
          e.type === "lease_renewed" ||
          e.type === "lease_released" ||
          e.type === "lease_expired") &&
        (e.payload as any)?.workerId === workerId,
    )
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

  if (workerLeaseEvents.length === 0) return null;
  const latest = workerLeaseEvents[workerLeaseEvents.length - 1];
  return parseLeaseFromEvent(latest);
}

function deriveLeaseFacts(
  events: SupervisorLifecycleEvent[],
  workerId: string,
  now: string,
  config: LifecycleConfig,
): LeaseFacts | null {
  const lease = findLatestLease(events, workerId);
  if (!lease) return null;

  const evaluation = evaluateLease(lease, now, config);
  const latestRelease = events.filter(
    (e) => e.type === "lease_released" && (e.payload as any)?.workerId === workerId,
  ).pop();

  return {
    leaseId: latestRelease ? null : lease.leaseId,
    leaseStatus: latestRelease ? "released" : evaluation.status === "invalid" ? "expired" : evaluation.status,
    leaseExpiresAt: lease.expiresAt ?? null,
    leaseAcquiredAt: lease.acquiredAt ?? null,
    leaseRenewedAt: lease.renewedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// createRuntimeAdapter — no process-local state
// ---------------------------------------------------------------------------

export function createRuntimeAdapter(
  ports: LifecycleRuntimePorts,
): LifecycleRuntimeAdapter {
  async function recordHeartbeat(
    worker: TeamMember,
    supervisorEvents: SupervisorLifecycleEvent[],
    options: {
      heartbeatNow: string;
      leaseDurationMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<HeartbeatEnvelope> {
    const { heartbeatNow, leaseDurationMs = 60000, idempotencyKey } = options;

    if (!worker.memberId) {
      return {
        status: "error",
        workerId: "",
        errorCode: "MISSING_WORKER",
        error: "Worker ID is required",
      };
    }

    const config = buildConfig(heartbeatNow);
    const hbInterpretation = interpretHeartbeat(
      worker.lastHeartbeat,
      heartbeatNow,
      config,
    );

    // Derive existing lease from explicit supervisorEvents input
    const existingLease = findLatestLease(supervisorEvents, worker.memberId);

    let leaseAction: "acquired" | "renewed" | "none" = "none";
    let leaseId = "";
    let leaseExpiresAt = "";

    // Append heartbeat_recorded event — idempotency via event store
    const hbEventId = idempotencyKey ?? ports.generateId("hb", worker.memberId);
    const hbEvent: SupervisorLifecycleEvent = {
      eventId: hbEventId,
      type: "heartbeat_recorded",
      timestamp: heartbeatNow,
      payload: { workerId: worker.memberId, timestamp: heartbeatNow },
    };
    const hbAppendResult = await ports.appendSupervisorEvent(hbEvent);

    if (hbAppendResult.status === "duplicate") {
      return {
        status: "ok",
        workerId: worker.memberId,
        timestamp: heartbeatNow,
        heartbeatInterpretation: hbInterpretation,
        leaseAction: "none",
      };
    }

    if (!existingLease || existingLease.releasedAt) {
      leaseAction = "acquired";
      leaseId = ports.generateId("lease", worker.memberId);
      const expiresAt = new Date(
        isoToMs(heartbeatNow) + leaseDurationMs,
      ).toISOString();
      leaseExpiresAt = expiresAt;

      const leaseEvent: SupervisorLifecycleEvent = {
        eventId: idempotencyKey
          ? `${idempotencyKey}-lease`
          : ports.generateId("lease-acq", worker.memberId),
        type: "lease_acquired",
        timestamp: heartbeatNow,
        payload: {
          workerId: worker.memberId,
          leaseId,
          resource: "worker-lease",
          acquiredAt: heartbeatNow,
          expiresAt,
        },
      };
      await ports.appendSupervisorEvent(leaseEvent);
    } else {
      leaseAction = "renewed";
      leaseId = existingLease.leaseId;
      const newExpiresAt = new Date(
        isoToMs(heartbeatNow) + leaseDurationMs,
      ).toISOString();
      leaseExpiresAt = newExpiresAt;

      const leaseEvent: SupervisorLifecycleEvent = {
        eventId: idempotencyKey
          ? `${idempotencyKey}-lease`
          : ports.generateId("lease-ren", worker.memberId),
        type: "lease_renewed",
        timestamp: heartbeatNow,
        payload: {
          workerId: worker.memberId,
          leaseId,
          renewedAt: heartbeatNow,
          newExpiresAt,
          // Include expiresAt for compatibility with parsers that check it
          expiresAt: newExpiresAt,
        },
      };
      await ports.appendSupervisorEvent(leaseEvent);
    }

    await ports.applyContactEvent({
      kind: "member_heartbeat",
      eventId: hbEventId,
      memberId: worker.memberId,
      timestamp: heartbeatNow,
    });

    return {
      status: "ok",
      workerId: worker.memberId,
      timestamp: heartbeatNow,
      heartbeatInterpretation: hbInterpretation,
      leaseAction,
      leaseId: leaseId || undefined,
      leaseExpiresAt: leaseExpiresAt || undefined,
    };
  }

  async function enumerateWorkers(
    snapshot: TeamSnapshot,
    options: { now: string; staleThresholdMs: number },
  ): Promise<WorkerEnumerationResult> {
    const { now, staleThresholdMs } = options;
    const config: LifecycleConfig = { ...buildConfig(now), heartbeatMaxAgeMs: staleThresholdMs };

    const allWorkers = Object.values(snapshot.rosterState.members);
    const workerFacts: WorkerFacts[] = [];

    for (const w of allWorkers) {
      const input = buildLifecycleInput(w, snapshot.processExistence?.[w.memberId] ?? true);
      const lifecycle = computeLifecycleState(input, config);
      const hbInterpretation = interpretHeartbeat(w.lastHeartbeat, now, config);
      const reaperDecision = decideReaperAction(input, lifecycle, config);
      const leaseFacts = deriveLeaseFacts(
        snapshot.supervisorEvents,
        w.memberId,
        now,
        config,
      );

      const isStale = hbInterpretation.kind === "stale"
        || hbInterpretation.kind === "expired"
        || hbInterpretation.kind === "missing";

      workerFacts.push({
        workerId: w.memberId,
        memberStatus: w.status,
        lifecycleState: lifecycle.state,
        heartbeatInterpretation: hbInterpretation,
        leaseFacts,
        reaperDecision: reaperDecision.action !== "none" ? reaperDecision : null,
        isStale,
        riskFlags: lifecycle.riskFlags,
      });
    }

    return {
      totalWorkers: workerFacts.length,
      workers: workerFacts,
      activeWorkers: workerFacts.filter(
        (w) => w.memberStatus === "active" || w.memberStatus === "idle",
      ),
      terminatedWorkers: workerFacts.filter(
        (w) => w.memberStatus === "terminated",
      ),
      staleWorkers: workerFacts.filter(
        (w) => w.isStale && w.memberStatus !== "terminated",
      ),
    };
  }

  async function runReaper(
    snapshot: TeamSnapshot,
    options: { now: string; staleThresholdMs: number; execute: boolean },
  ): Promise<ReaperEnvelope> {
    const { now, staleThresholdMs, execute } = options;
    const config: LifecycleConfig = { ...buildConfig(now), heartbeatMaxAgeMs: staleThresholdMs };

    const allWorkers = Object.values(snapshot.rosterState.members);
    const staleDecisions: Array<{ workerId: string; action: string; reason: string }> = [];

    for (const w of allWorkers) {
      if (w.status === "terminated" || w.status === "offline") continue;

      const input = buildLifecycleInput(w, snapshot.processExistence?.[w.memberId] ?? true);
      const lifecycle = computeLifecycleState(input, config);
      const decision = decideReaperAction(input, lifecycle, config);

      if (decision.action !== "none") {
        staleDecisions.push({
          workerId: w.memberId,
          action: decision.action,
          reason: decision.reason,
        });
      }
    }

    const plannedActions = staleDecisions.map((d) => ({
      workerId: d.workerId,
      action: d.action,
      reason: d.reason,
      eventType: "reaper_planned" as SupervisorLifecycleEventType,
    }));

    if (!execute) {
      return {
        status: "ok",
        dryRun: true,
        executed: false,
        totalWorkers: allWorkers.length,
        staleCount: staleDecisions.length,
        thresholdMs: staleThresholdMs,
        plannedActions,
      };
    }

    const appended: Array<{ type: string; status: string; message?: string }> = [];
    const failures: Array<{ workerId: string; error: string }> = [];

    for (const d of staleDecisions) {
      // reaper_planned
      const plannedEvent: SupervisorLifecycleEvent = {
        eventId: ports.generateId("reaper-planned", d.workerId),
        type: "reaper_planned",
        timestamp: now,
        payload: {
          candidateWorkerId: d.workerId,
          reason: d.reason,
          plannedAction: d.action,
        },
      };
      const plannedResult = await ports.appendSupervisorEvent(plannedEvent);
      appended.push({ type: "reaper_planned", ...plannedResult });

      // shutdown_requested before executing shutdown
      const reqEvent: SupervisorLifecycleEvent = {
        eventId: ports.generateId("shutdown-req", d.workerId),
        type: "shutdown_requested",
        timestamp: now,
        payload: {
          phase: "reaper",
          requestedBy: "reaper-adapter",
          reason: d.reason,
          workerId: d.workerId,
        },
      };
      const reqResult = await ports.appendSupervisorEvent(reqEvent);
      appended.push({ type: "shutdown_requested", ...reqResult });

      // Try shutdown
      let shutdownOk = true;
      try {
        await ports.shutdownWorker(d.workerId, d.reason);
      } catch (e: unknown) {
        shutdownOk = false;
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ workerId: d.workerId, error: msg });

        const failEvent: SupervisorLifecycleEvent = {
          eventId: ports.generateId("shutdown-fail", d.workerId),
          type: "shutdown_failed",
          timestamp: now,
          payload: { workerId: d.workerId, reason: msg },
        };
        const failResult = await ports.appendSupervisorEvent(failEvent);
        appended.push({ type: "shutdown_failed", ...failResult });
      }

      if (shutdownOk) {
        // shutdown_completed
        const compEvent: SupervisorLifecycleEvent = {
          eventId: ports.generateId("shutdown-comp", d.workerId),
          type: "shutdown_completed",
          timestamp: now,
          payload: { workerId: d.workerId, totalWorkersTerminated: 1 },
        };
        const compResult = await ports.appendSupervisorEvent(compEvent);
        appended.push({ type: "shutdown_completed", ...compResult });

        await ports.applyContactEvent({
          kind: "member_status_changed",
          eventId: ports.generateId("status-chg", d.workerId),
          memberId: d.workerId,
          status: "terminated",
          reason: d.reason,
        });
      }

      // reaper_executed (records the reaper action, not the shutdown result)
      const executedEvent: SupervisorLifecycleEvent = {
        eventId: ports.generateId("reaper-exec", d.workerId),
        type: "reaper_executed",
        timestamp: now,
        payload: {
          workerId: d.workerId,
          action: d.action,
          reason: d.reason,
          shutdownSucceeded: shutdownOk,
        },
      };
      const execResult = await ports.appendSupervisorEvent(executedEvent);
      appended.push({ type: "reaper_executed", ...execResult });
    }

    return {
      status: "ok",
      dryRun: false,
      executed: true,
      totalWorkers: allWorkers.length,
      staleCount: staleDecisions.length,
      thresholdMs: staleThresholdMs,
      plannedActions,
      failures: failures.length > 0 ? failures : undefined,
      appended: appended.length > 0 ? appended : undefined,
    };
  }

  async function requestShutdown(
    worker: TeamMember,
    options: { now: string; reason: string; execute: boolean },
  ): Promise<ShutdownEnvelope> {
    const { now, reason, execute } = options;

    if (!worker.memberId) {
      return {
        status: "error",
        workerId: "",
        errorCode: "MISSING_WORKER",
        error: "Worker ID is required",
        dryRun: false,
        executed: false,
      };
    }

    if (worker.status === "terminated") {
      return {
        status: "error",
        workerId: worker.memberId,
        errorCode: "ALREADY_TERMINATED",
        error: `Worker ${worker.memberId} is already terminated`,
        dryRun: false,
        executed: false,
      };
    }

    const plan = {
      event: "member_status_changed",
      workerId: worker.memberId,
      targetStatus: "terminated" as const,
      reason,
      timestamp: now,
    };

    if (!execute) {
      return {
        status: "ok",
        workerId: worker.memberId,
        dryRun: true,
        executed: false,
        plan,
      };
    }

    const appended: Array<{ type: string; status: string; message?: string }> = [];

    const reqEvent: SupervisorLifecycleEvent = {
      eventId: ports.generateId("shutdown-req", worker.memberId),
      type: "shutdown_requested",
      timestamp: now,
      payload: {
        phase: "shutdown",
        requestedBy: "lifecycle-adapter",
        reason,
        workerId: worker.memberId,
      },
    };
    const reqResult = await ports.appendSupervisorEvent(reqEvent);
    appended.push({ type: "shutdown_requested", ...reqResult });

    try {
      await ports.shutdownWorker(worker.memberId, reason);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const failEvent: SupervisorLifecycleEvent = {
        eventId: ports.generateId("shutdown-fail", worker.memberId),
        type: "shutdown_failed",
        timestamp: now,
        payload: { workerId: worker.memberId, reason: msg },
      };
      const failResult = await ports.appendSupervisorEvent(failEvent);
      appended.push({ type: "shutdown_failed", ...failResult });
      return {
        status: "error",
        errorCode: "SHUTDOWN_FAILED",
        error: msg,
        workerId: worker.memberId,
        dryRun: false,
        executed: true,
        plan,
        appended,
      };
    }

    const compEvent: SupervisorLifecycleEvent = {
      eventId: ports.generateId("shutdown-comp", worker.memberId),
      type: "shutdown_completed",
      timestamp: now,
      payload: { workerId: worker.memberId, totalWorkersTerminated: 1 },
    };
    const compResult = await ports.appendSupervisorEvent(compEvent);
    appended.push({ type: "shutdown_completed", ...compResult });

    await ports.applyContactEvent({
      kind: "member_status_changed",
      eventId: ports.generateId("status-chg", worker.memberId),
      memberId: worker.memberId,
      status: "terminated",
      reason,
    });

    return {
      status: "ok",
      workerId: worker.memberId,
      dryRun: false,
      executed: true,
      plan,
      appended,
    };
  }

  return { recordHeartbeat, enumerateWorkers, runReaper, requestShutdown };
}
