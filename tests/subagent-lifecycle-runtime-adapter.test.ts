import { describe, it, expect } from "vitest";
import {
  createRuntimeAdapter,
  type LifecycleRuntimeAdapter,
  type LifecycleRuntimePorts,
  type TeamSnapshot,
  type LeaseFacts,
  type WorkerFacts,
  type ShutdownEnvelope,
  type ReaperEnvelope,
  type HeartbeatEnvelope,
} from "../src/subagent/lifecycle-runtime-adapter.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  type ContactRegistryState,
  type WorkerContact,
} from "../src/subagent/contact-registry.js";
import type { SupervisorLifecycleEvent } from "../src/subagent/supervisor-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-07T12:00:00.000Z";

function makeWorker(overrides: Partial<WorkerContact> = {}): WorkerContact {
  return {
    workerId: "w1",
    role: "coder",
    workspace: "/tmp/w1",
    branch: "codex/p6/w1",
    imChannel: "ch-w1",
    allowedActions: ["code"],
    status: "active",
    ...overrides,
  };
}

function makeTeamSnapshot(workers: Array<Partial<WorkerContact>> = []): TeamSnapshot {
  let state = createContactRegistryState("test-registry");
  const events: SupervisorLifecycleEvent[] = [];
  for (const w of workers) {
    const full: WorkerContact = {
      workerId: w.workerId ?? "w1",
      role: w.role ?? "coder",
      workspace: w.workspace ?? "/tmp/w1",
      branch: w.branch ?? "codex/p6/w1",
      imChannel: w.imChannel ?? "ch-w1",
      allowedActions: w.allowedActions ?? ["code"],
      status: w.status ?? "active",
      lastHeartbeat: w.lastHeartbeat,
      lastEvidence: w.lastEvidence,
    };
    state = applyContactRegistryEvent(state, {
      kind: "worker_registered",
      eventId: `ev-reg-${full.workerId}`,
      workerId: full.workerId,
      role: full.role,
      workspace: full.workspace,
      branch: full.branch,
      imChannel: full.imChannel,
      allowedActions: full.allowedActions,
    }).state;

    if (full.status && full.status !== "idle") {
      state = applyContactRegistryEvent(state, {
        kind: "worker_status_changed" as const,
        eventId: `ev-status-${full.workerId}`,
        workerId: full.workerId,
        status: full.status as any,
      }).state;
    }

    if (full.lastHeartbeat) {
      state = applyContactRegistryEvent(state, {
        kind: "worker_heartbeat" as const,
        eventId: `ev-hb-${full.workerId}`,
        workerId: full.workerId,
        timestamp: full.lastHeartbeat,
      }).state;
    }
  }
  return {
    registryState: state,
    supervisorEvents: events,
    createdAt: NOW,
    runId: "run-test",
  };
}

// Make a prior lease_acquired event to test lease renew
function makeLeaseAcquiredEvent(workerId: string, leaseId: string, acquiredAt: string, expiresAt: string): SupervisorLifecycleEvent {
  return {
    eventId: `ev-lease-${workerId}-1`,
    type: "lease_acquired",
    timestamp: acquiredAt,
    payload: {
      workerId,
      leaseId,
      resource: "worker-lease",
      acquiredAt,
      expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

function makeFakePorts(overrides: {
  appendBehavior?: "append" | "duplicate";
} = {}): {
  ports: LifecycleRuntimePorts;
  appended: SupervisorLifecycleEvent[];
  shutdownCalls: Array<{ workerId: string; reason?: string }>;
  contactEvents: Record<string, number>;
} {
  const appended: SupervisorLifecycleEvent[] = [];
  const shutdownCalls: Array<{ workerId: string; reason?: string }> = [];
  const contactEvents: Record<string, number> = {};
  const seenIds = new Set<string>();

  const ports: LifecycleRuntimePorts = {
    nowIso: () => NOW,
    generateId: (prefix: string, workerId: string) => `${prefix}-${workerId}-1`,
    appendSupervisorEvent: async (event: SupervisorLifecycleEvent) => {
      if (seenIds.has(event.eventId)) {
        return { status: "duplicate" as const };
      }
      seenIds.add(event.eventId);
      appended.push(event);
      return { status: "appended" as const };
    },
    shutdownWorker: async (workerId: string, reason?: string) => {
      shutdownCalls.push({ workerId, reason });
    },
    applyContactEvent: async (event) => {
      contactEvents[event.kind] = (contactEvents[event.kind] ?? 0) + 1;
      return "applied";
    },
  };

  return { ports, appended, shutdownCalls, contactEvents };
}

// ---------------------------------------------------------------------------
// 1. Fresh lease acquire
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - lease", () => {
  it("acquires fresh lease for a worker with no prior lease", async () => {
    const { ports, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1" });

    const envelope: HeartbeatEnvelope = await adapter.recordHeartbeat(
      worker,
      [], // no prior supervisor events
      { heartbeatNow: NOW, leaseDurationMs: 60000 },
    );

    expect(envelope.status).toBe("ok");
    expect(envelope.workerId).toBe("w1");
    expect(envelope.heartbeatInterpretation).toBeDefined();
    const types = appended.map((e) => e.type);
    expect(types).toContain("heartbeat_recorded");
    expect(types).toContain("lease_acquired");
    expect(envelope.leaseAction).toBe("acquired");
  });

  it("renews lease when prior lease_acquired in supervisorEvents", async () => {
    const { ports, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1", lastHeartbeat: "2026-06-07T11:55:00.000Z" });

    // Prior lease event
    const priorEvents: SupervisorLifecycleEvent[] = [
      makeLeaseAcquiredEvent("w1", "lease-w1-1", "2026-06-07T11:55:00.000Z", "2026-06-07T11:56:00.000Z"),
    ];

    const envelope: HeartbeatEnvelope = await adapter.recordHeartbeat(
      worker,
      priorEvents,
      { heartbeatNow: "2026-06-07T11:56:30.000Z", leaseDurationMs: 60000 },
    );

    expect(envelope.status).toBe("ok");
    const types = appended.map((e) => e.type);
    expect(types).toContain("lease_renewed");
    expect(envelope.leaseAction).toBe("renewed");
  });

  it("updates contact projection on heartbeat", async () => {
    const { ports, contactEvents } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1" });

    await adapter.recordHeartbeat(worker, [], { heartbeatNow: NOW, leaseDurationMs: 60000 });

    expect(contactEvents["worker_heartbeat"]).toBe(1);
  });

  it("returns error for missing worker", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "" });

    const envelope: HeartbeatEnvelope = await adapter.recordHeartbeat(
      worker,
      [],
      { heartbeatNow: NOW, leaseDurationMs: 60000 },
    );

    expect(envelope.status).toBe("error");
    expect(envelope.errorCode).toBe("MISSING_WORKER");
  });
});

// ---------------------------------------------------------------------------
// 2. Stale worker enumeration
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - enumerateWorkers", () => {
  it("enumerates workers from team snapshot", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "w1", status: "active", lastHeartbeat: "2026-06-07T11:59:00.000Z" },
      { workerId: "w2", status: "idle", lastHeartbeat: "2026-06-07T11:58:00.000Z" },
      { workerId: "w3", status: "terminated" },
    ]);

    const facts = await adapter.enumerateWorkers(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
    });

    expect(facts.totalWorkers).toBe(3);
    expect(facts.activeWorkers).toHaveLength(2);
    expect(facts.terminatedWorkers).toHaveLength(1);
    expect(facts.workers.length).toBe(3);
  });

  it("identifies stale workers based on heartbeat age", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "fresh", status: "active", lastHeartbeat: "2026-06-07T11:59:00.000Z" },
      { workerId: "stale", status: "active", lastHeartbeat: "2026-06-07T11:50:00.000Z" },
      { workerId: "no-hb", status: "idle" },
    ]);

    const facts = await adapter.enumerateWorkers(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
    });

    expect(facts.staleWorkers.length).toBe(2);
    const staleIds = facts.staleWorkers.map((w) => w.workerId);
    expect(staleIds).toContain("stale");
    expect(staleIds).toContain("no-hb");
    expect(staleIds).not.toContain("fresh");
  });

  it("derives worker facts including lease from supervisor events", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "w1", status: "active", lastHeartbeat: "2026-06-07T11:59:00.000Z" },
    ]);
    snapshot.supervisorEvents = [
      makeLeaseAcquiredEvent("w1", "lease-w1-1", "2026-06-07T11:55:00.000Z", "2026-06-07T12:05:00.000Z"),
    ];

    const facts = await adapter.enumerateWorkers(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
    });

    expect(facts.workers.length).toBe(1);
    const w1 = facts.workers[0];
    expect(w1.leaseFacts).toBeDefined();
    expect(w1.leaseFacts?.leaseStatus).toBe("valid");
    expect(w1.leaseFacts?.leaseId).toBe("lease-w1-1");
  });
});

// ---------------------------------------------------------------------------
// 3. Reaper
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - reaper", () => {
  it("reaper dry-run plans actions without shutdown", async () => {
    const { ports, shutdownCalls } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "fresh", status: "active", lastHeartbeat: "2026-06-07T11:59:00.000Z" },
      { workerId: "stale", status: "active", lastHeartbeat: "2026-06-07T11:45:00.000Z" },
      { workerId: "no-hb", status: "idle" },
    ]);

    const envelope: ReaperEnvelope = await adapter.runReaper(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
      execute: false,
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.executed).toBe(false);
    expect(envelope.dryRun).toBe(true);
    expect(envelope.totalWorkers).toBe(3);
    expect(envelope.staleCount).toBe(2);
    expect(shutdownCalls).toHaveLength(0);
  });

  it("reaper execute-mode uses fake shutdown port and appends audit events", async () => {
    const { ports, shutdownCalls, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "stale", status: "active", lastHeartbeat: "2026-06-07T11:45:00.000Z" },
    ]);

    const envelope: ReaperEnvelope = await adapter.runReaper(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
      execute: true,
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.executed).toBe(true);
    expect(shutdownCalls.length).toBeGreaterThanOrEqual(1);
    expect(shutdownCalls[0].workerId).toBe("stale");
    const types = appended.map((e) => e.type);
    expect(types).toContain("reaper_planned");
    expect(types).toContain("reaper_executed");
  });

  it("reaper skips terminated workers", async () => {
    const { ports, shutdownCalls } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([
      { workerId: "term", status: "terminated", lastHeartbeat: "2026-06-07T11:00:00.000Z" },
    ]);

    const envelope: ReaperEnvelope = await adapter.runReaper(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
      execute: true,
    });

    expect(envelope.status).toBe("ok");
    expect(shutdownCalls).toHaveLength(0);
    expect(envelope.staleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Unified shutdown
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - shutdown", () => {
  it("shutdown produces shutdown_requested and shutdown_completed events", async () => {
    const { ports, appended, shutdownCalls } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1", status: "active" });

    const envelope: ShutdownEnvelope = await adapter.requestShutdown(worker, {
      now: NOW,
      reason: "test shutdown",
      execute: true,
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.workerId).toBe("w1");
    expect(envelope.executed).toBe(true);
    expect(shutdownCalls.length).toBe(1);
    const types = appended.map((e) => e.type);
    expect(types).toContain("shutdown_requested");
    expect(types).toContain("shutdown_completed");
  });

  it("shutdown dry-run produces plan without executing", async () => {
    const { ports, shutdownCalls, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1", status: "active" });

    const envelope: ShutdownEnvelope = await adapter.requestShutdown(worker, {
      now: NOW,
      reason: "test shutdown",
      execute: false,
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.executed).toBe(false);
    expect(shutdownCalls).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  it("shutdown fails for already terminated worker", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1", status: "terminated" });

    const envelope: ShutdownEnvelope = await adapter.requestShutdown(worker, {
      now: NOW,
      reason: "test shutdown",
      execute: true,
    });

    expect(envelope.status).toBe("error");
    expect(envelope.errorCode).toBe("ALREADY_TERMINATED");
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency from store duplicate semantics
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - idempotency", () => {
  it("duplicate append via same eventId returns ok without duplicate events", async () => {
    const { ports, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1" });

    // First call with explicit idempotencyKey -> becomes eventId
    const env1 = await adapter.recordHeartbeat(worker, [], {
      heartbeatNow: NOW,
      leaseDurationMs: 60000,
      idempotencyKey: "hb-key-1",
    });
    expect(env1.status).toBe("ok");
    const count1 = appended.length;

    // Second call with same idempotencyKey -> same eventId -> duplicate
    const env2 = await adapter.recordHeartbeat(worker, [], {
      heartbeatNow: NOW,
      leaseDurationMs: 60000,
      idempotencyKey: "hb-key-1",
    });
    expect(env2.status).toBe("ok");
    expect(appended.length).toBe(count1);
  });

  it("different idempotencyKeys produce distinct events", async () => {
    const { ports, appended } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "w1" });

    await adapter.recordHeartbeat(worker, [], {
      heartbeatNow: NOW,
      leaseDurationMs: 60000,
      idempotencyKey: "hb-1",
    });
    const count1 = appended.length;

    await adapter.recordHeartbeat(worker, [], {
      heartbeatNow: NOW,
      leaseDurationMs: 60000,
      idempotencyKey: "hb-2",
    });

    expect(appended.length).toBeGreaterThan(count1);
  });
});

// ---------------------------------------------------------------------------
// 6. Empty worker / error handling
// ---------------------------------------------------------------------------

describe("lifecycle-runtime-adapter - error handling", () => {
  it("recordHeartbeat with empty workerId returns error", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "" });

    const envelope = await adapter.recordHeartbeat(worker, [], {
      heartbeatNow: NOW,
      leaseDurationMs: 60000,
    });

    expect(envelope.status).toBe("error");
  });

  it("shutdown with empty workerId returns error", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const worker = makeWorker({ workerId: "" });

    const envelope = await adapter.requestShutdown(worker, {
      now: NOW,
      reason: "test",
      execute: true,
    });

    expect(envelope.status).toBe("error");
  });

  it("enumerateWorkers with empty snapshot handles gracefully", async () => {
    const { ports } = makeFakePorts();
    const adapter = createRuntimeAdapter(ports);
    const snapshot = makeTeamSnapshot([]);

    const facts = await adapter.enumerateWorkers(snapshot, {
      now: NOW,
      staleThresholdMs: 300000,
    });

    expect(facts.totalWorkers).toBe(0);
    expect(facts.workers).toHaveLength(0);
  });
});
