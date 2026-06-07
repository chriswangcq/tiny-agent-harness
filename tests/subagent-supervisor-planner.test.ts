import { describe, expect, it } from "vitest";
import {
  computeSupervisorPlan,
  buildSnapshot,
  type PlannerSnapshot,
  type PlannerConfig,
  type PlannedAction,
  type PlannedActionKind,
} from "../src/subagent/supervisor-planner.js";
import {
  type LifecycleInput,
  type LifecycleConfig,
  type LeaseRecord,
  type WorkerLifecycleState,
} from "../src/subagent/supervisor-lifecycle.js";
import type { WorkerContact } from "../src/subagent/contact-registry.js";
import * as barrel from "../src/subagent/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-06T03:30:00.000Z";
const ONE_MIN_AGO = "2026-06-06T03:29:00.000Z";
const TEN_MIN_AGO = "2026-06-06T03:20:00.000Z";
const THIRTY_MIN_AGO = "2026-06-06T03:00:00.000Z";
const ONE_HOUR_AGO = "2026-06-06T02:30:00.000Z";

function makeLifecycleConfig(
  overrides: Partial<LifecycleConfig> = {},
): LifecycleConfig {
  return {
    now: NOW,
    heartbeatMaxAgeMs: 300_000, // 5 min
    evidenceMaxAgeMs: 600_000, // 10 min
    leaseMaxAgeMs: 600_000, // 10 min
    gracePeriodMs: 120_000, // 2 min
    shutdownMaxAgeMs: 600_000, // 10 min
    processMissingMaxAgeMs: 900_000, // 15 min
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    now: NOW,
    lifecycleConfig: makeLifecycleConfig(),
    leaseRenewalEnabled: true,
    reapingEnabled: true,
    shutdownEnabled: true,
    includeTerminated: false,
    ...overrides,
  };
}

function makeContact(overrides: Partial<WorkerContact> = {}): WorkerContact {
  return {
    workerId: "coder-1",
    role: "coder",
    workspace: "/tmp/workspace",
    branch: "feature/test",
    imChannel: "coder-1",
    status: "active" as const,
    allowedActions: ["terminal_write", "session_focus"],
    lastHeartbeat: ONE_MIN_AGO,
    lastEvidence: ONE_MIN_AGO,
    ...overrides,
  };
}

function makeLifecycleInput(
  overrides: Partial<LifecycleInput> = {},
): LifecycleInput {
  return {
    workerId: "coder-1",
    contactStatus: "active",
    lastHeartbeat: ONE_MIN_AGO,
    lastEvidence: ONE_MIN_AGO,
    runStatus: "running",
    runLastStepAt: ONE_MIN_AGO,
    ledgerOpenProblems: 0,
    ledgerLastActivityAt: ONE_MIN_AGO,
    processExists: true,
    processStartTime: ONE_MIN_AGO,
    shutdownRequestedAt: undefined,
    terminatedAt: undefined,
    ...overrides,
  };
}

function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    leaseId: "lease-1",
    workerId: "coder-1",
    taskId: "task-1",
    acquiredAt: ONE_MIN_AGO,
    expiresAt: "2026-06-06T03:40:00.000Z",
    renewedAt: undefined,
    releasedAt: undefined,
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<PlannerSnapshot> = {},
): PlannerSnapshot {
  const contact = overrides.contact ?? makeContact();
  const lifecycleInput = overrides.lifecycleInput ?? makeLifecycleInput();
  const lease = overrides.lease;
  return {
    workerId: contact.workerId,
    contact,
    lifecycleInput,
    lease,
    processExists: lifecycleInput.processExists,
    pid: overrides.pid,
    processStartTime: overrides.processStartTime,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Barrel export checks
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports computeSupervisorPlan", () => {
    expect(typeof barrel.computeSupervisorPlan).toBe("function");
  });
  it("exports buildSnapshot", () => {
    expect(typeof barrel.buildSnapshot).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// computeSupervisorPlan
// ---------------------------------------------------------------------------

describe("computeSupervisorPlan", () => {
  it("returns correct structure for empty snapshots", () => {
    const config = makeConfig();
    const result = computeSupervisorPlan([], config);

    expect(result.config).toBe(config);
    expect(result.actions).toEqual([]);
    expect(result.totalWorkers).toBe(0);
    expect(result.terminatedWorkers).toBe(0);
    expect(result.plannedAt).toBe(NOW);
    // Summary should be all zeros
    for (const count of Object.values(result.summary)) {
      expect(count).toBe(0);
    }
  });

  it("classifies a healthy worker as noop", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot();
    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("noop");
    expect(result.actions[0].lifecycleState).toBe("healthy");
    expect(result.actions[0].workerId).toBe("coder-1");
    expect(result.summary.noop).toBe(1);
  });

  it("detects expired heartbeat and plans reap_terminate", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("reap_terminate");
    expect(result.actions[0].lifecycleState).toBe("expired");
    expect(result.summary.reap_terminate).toBe(1);
  });

  it("detects stale heartbeat with open ledger problems -> reap_reassign", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: TEN_MIN_AGO,
        lastEvidence: TEN_MIN_AGO,
        ledgerOpenProblems: 3,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("reap_reassign");
    expect(result.actions[0].lifecycleState).toBe("stale");
    expect(result.summary.reap_reassign).toBe(1);
  });

  it("detects stale heartbeat without open problems -> reap_warn", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: TEN_MIN_AGO,
        lastEvidence: ONE_MIN_AGO,
        ledgerOpenProblems: 0,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("reap_warn");
    expect(result.actions[0].lifecycleState).toBe("stale");
    expect(result.summary.reap_warn).toBe(1);
  });

  it("detects terminated worker and returns noop (excludeTerminated)", () => {
    const config = makeConfig({ includeTerminated: false });
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        contactStatus: "terminated",
        terminatedAt: ONE_MIN_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("noop");
    expect(result.actions[0].lifecycleState).toBe("terminated");
    expect(result.terminatedWorkers).toBe(1);
    expect(result.summary.noop).toBe(1);
  });

  it("marks terminated worker when includeTerminated is true", () => {
    const config = makeConfig({ includeTerminated: true });
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        contactStatus: "terminated",
        terminatedAt: ONE_MIN_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("mark_terminated");
    expect(result.actions[0].lifecycleState).toBe("terminated");
    expect(result.terminatedWorkers).toBe(1);
    expect(result.summary.mark_terminated).toBe(1);
  });

  it("detects missing process -> escalate_missing_process", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        processExists: false,
        lastHeartbeat: THIRTY_MIN_AGO,
        lastEvidence: THIRTY_MIN_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("escalate_missing_process");
    expect(result.actions[0].lifecycleState).toBe("missing_process");
    expect(result.summary.escalate_missing_process).toBe(1);
  });

  it("handles shutdown request within grace period -> skip_shutdown", () => {
    const config = makeConfig();
    // Shutdown 30s ago, grace period is 120s
    const shutdownTime = "2026-06-06T03:29:30.000Z";
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        shutdownRequestedAt: shutdownTime,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("skip_shutdown");
    expect(result.actions[0].lifecycleState).toBe("grace_period");
    expect(result.summary.skip_shutdown).toBe(1);
  });

  it("handles shutdown request beyond grace period -> request_shutdown", () => {
    const config = makeConfig();
    // Shutdown 5 min ago, grace period is 2 min, shutdown max is 10 min
    const shutdownTime = ONE_MIN_AGO; // 1 min ago but grace is 2 min...let's use 5 min ago
    const FIVE_MIN_AGO = "2026-06-06T03:25:00.000Z";
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        shutdownRequestedAt: FIVE_MIN_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("request_shutdown");
    expect(result.actions[0].lifecycleState).toBe("shutdown");
    expect(result.summary.request_shutdown).toBe(1);
  });

  it("skips shutdown when shutdownEnabled is false", () => {
    const config = makeConfig({ shutdownEnabled: false });
    // Shutdown 5 min ago -> would be "shutdown" state normally
    const FIVE_MIN_AGO = "2026-06-06T03:25:00.000Z";
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        shutdownRequestedAt: FIVE_MIN_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions[0].kind).toBe("skip_shutdown");
    expect(result.actions[0].reason).toContain("Shutdown disabled");
    expect(result.summary.skip_shutdown).toBe(1);
  });

  it("skips reaping when reapingEnabled is false", () => {
    const config = makeConfig({ reapingEnabled: false });
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    // Even though heartbeat is expired, reaping is disabled -> should fall through to noop
    expect(result.actions[0].kind).toBe("noop");
    // But the lifecycle state is still "expired"
    expect(result.actions[0].lifecycleState).toBe("expired");
  });

  it("renews lease when close to expiry", () => {
    const config = makeConfig();
    // Lease expires in 1 min (10 min lease max, < 25% remaining = 2.5 min threshold)
    const lease = makeLease({
      expiresAt: "2026-06-06T03:31:00.000Z", // 1 min from now
    });
    const snapshot = makeSnapshot({ lease });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("renew_lease");
    expect(result.actions[0].leaseEvaluation?.status).toBe("valid");
    expect(result.summary.renew_lease).toBe(1);
  });

  it("releases lease when expired", () => {
    const config = makeConfig();
    const lease = makeLease({
      expiresAt: ONE_MIN_AGO, // already expired
    });
    const snapshot = makeSnapshot({ lease });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].kind).toBe("release_lease");
    expect(result.actions[0].leaseEvaluation?.status).toBe("expired");
    expect(result.summary.release_lease).toBe(1);
  });

  it("does not renew lease when leaseRenewalEnabled is false", () => {
    const config = makeConfig({ leaseRenewalEnabled: false });
    const lease = makeLease({
      expiresAt: "2026-06-06T03:31:00.000Z", // 1 min from now, close to expiry
    });
    const snapshot = makeSnapshot({ lease });

    const result = computeSupervisorPlan([snapshot], config);

    // Lease renewal disabled -> should be noop (worker is healthy)
    expect(result.actions[0].kind).toBe("noop");
    expect(result.actions[0].leaseEvaluation?.status).toBe("valid");
  });

  it("sorts multiple workers by priority", () => {
    const config = makeConfig();
    const snapshots: PlannerSnapshot[] = [
      // Healthy worker -> noop (priority 10)
      makeSnapshot({
        workerId: "coder-1",
        contact: makeContact({ workerId: "coder-1" }),
        lifecycleInput: makeLifecycleInput({ workerId: "coder-1" }),
      }),
      // Missing process -> escalate (priority 1)
      makeSnapshot({
        workerId: "coder-2",
        contact: makeContact({ workerId: "coder-2" }),
        lifecycleInput: makeLifecycleInput({
          workerId: "coder-2",
          processExists: false,
          lastHeartbeat: THIRTY_MIN_AGO,
          lastEvidence: THIRTY_MIN_AGO,
        }),
      }),
      // Expired -> reap_terminate (priority 2)
      makeSnapshot({
        workerId: "coder-3",
        contact: makeContact({ workerId: "coder-3" }),
        lifecycleInput: makeLifecycleInput({
          workerId: "coder-3",
          lastHeartbeat: ONE_HOUR_AGO,
          lastEvidence: ONE_HOUR_AGO,
        }),
      }),
      // Shutdown needed -> request_shutdown (priority 4)
      makeSnapshot({
        workerId: "coder-4",
        contact: makeContact({ workerId: "coder-4" }),
        lifecycleInput: makeLifecycleInput({
          workerId: "coder-4",
          shutdownRequestedAt: "2026-06-06T03:25:00.000Z",
          lastHeartbeat: "2026-06-06T03:20:00.000Z",
        }),
      }),
    ];

    const result = computeSupervisorPlan(snapshots, config);

    expect(result.actions).toHaveLength(4);
    // Should be sorted by priority ascending
    expect(result.actions[0].kind).toBe("escalate_missing_process"); // priority 1
    expect(result.actions[0].workerId).toBe("coder-2");
    expect(result.actions[1].kind).toBe("reap_terminate"); // priority 2
    expect(result.actions[1].workerId).toBe("coder-3");
    expect(result.actions[2].kind).toBe("request_shutdown"); // priority 4
    expect(result.actions[2].workerId).toBe("coder-4");
    expect(result.actions[3].kind).toBe("noop"); // priority 10
    expect(result.actions[3].workerId).toBe("coder-1");

    expect(result.totalWorkers).toBe(4);
    expect(result.summary.escalate_missing_process).toBe(1);
    expect(result.summary.reap_terminate).toBe(1);
    expect(result.summary.request_shutdown).toBe(1);
    expect(result.summary.noop).toBe(1);
  });

  it("handles offline worker with old heartbeat -> terminated", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        contactStatus: "offline",
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
        processExists: false,
      }),
    });

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions[0].lifecycleState).toBe("terminated");
    expect(result.actions[0].kind).toBe("noop"); // excludeTerminated by default
    expect(result.terminatedWorkers).toBe(1);
  });

  it("plans correctly when reaping is enabled but reaper says none", () => {
    // A healthy worker with reaping enabled -> reaper says none -> falls to noop
    const config = makeConfig({ reapingEnabled: true });
    const snapshot = makeSnapshot(); // fully healthy

    const result = computeSupervisorPlan([snapshot], config);

    expect(result.actions[0].kind).toBe("noop");
    expect(result.actions[0].lifecycleState).toBe("healthy");
  });

  it("buildSnapshot helper creates correct snapshot", () => {
    const contact = makeContact({ workerId: "test-worker" });
    const lifecycleInput = makeLifecycleInput({ workerId: "test-worker" });
    const lease = makeLease({ workerId: "test-worker" });

    const snapshot = buildSnapshot(contact, lifecycleInput, lease, 1234, ONE_MIN_AGO);

    expect(snapshot.workerId).toBe("test-worker");
    expect(snapshot.contact).toBe(contact);
    expect(snapshot.lifecycleInput).toBe(lifecycleInput);
    expect(snapshot.lease).toBe(lease);
    expect(snapshot.processExists).toBe(true);
    expect(snapshot.pid).toBe(1234);
    expect(snapshot.processStartTime).toBe(ONE_MIN_AGO);
  });

  it("includes correct context and audit fields in actions", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot();

    const result = computeSupervisorPlan([snapshot], config);
    const action = result.actions[0];

    expect(action.workerId).toBe("coder-1");
    expect(action.reason).toBeTruthy();
    expect(action.priority).toBeGreaterThanOrEqual(1);
    expect(action.context).toBeDefined();
    expect(action.context.lifecycle).toBeDefined();
    expect(action.context.riskFlags).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Master review acceptance: idempotencyKey, execution intent, severity/riskFlags
// ---------------------------------------------------------------------------

describe("PlannedAction audit contract", () => {
  const config = makeConfig();
  const snapshot = makeSnapshot();

  it("every action has an idempotencyKey", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action).toHaveProperty("idempotencyKey");
      expect(typeof action.idempotencyKey).toBe("string");
      expect(action.idempotencyKey.length).toBeGreaterThan(0);
    }
  });

  it("idempotencyKey is stable for the same plan inputs", () => {
    const result1 = computeSupervisorPlan([snapshot], config);
    const result2 = computeSupervisorPlan([snapshot], config);
    expect(result1.actions[0].idempotencyKey).toBe(
      result2.actions[0].idempotencyKey,
    );
  });

  it("every action has execution intent with executable field", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action).toHaveProperty("execution");
      expect(typeof action.execution).toBe("object");
      expect(action.execution).toHaveProperty("executable");
      expect(typeof action.execution.executable).toBe("boolean");
    }
  });

  it("noop and mark_terminated actions are not executable", () => {
    const noopResult = computeSupervisorPlan([snapshot], config);
    expect(noopResult.actions[0].kind).toBe("noop");
    expect(noopResult.actions[0].execution.executable).toBe(false);

    // Terminated worker
    const termSnapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        contactStatus: "terminated",
        terminatedAt: ONE_MIN_AGO,
      }),
    });
    const termResult = computeSupervisorPlan([termSnapshot], makeConfig({ includeTerminated: true }));
    expect(termResult.actions[0].kind).toBe("mark_terminated");
    expect(termResult.actions[0].execution.executable).toBe(false);
  });

  it("reap, shutdown, and lease actions are executable", () => {
    // reap_terminate case
    const reapSnapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
      }),
    });
    const reapResult = computeSupervisorPlan([reapSnapshot], config);
    expect(reapResult.actions[0].kind).toBe("reap_terminate");
    expect(reapResult.actions[0].execution.executable).toBe(true);

    // request_shutdown case
    const shutdownSnapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        shutdownRequestedAt: "2026-06-06T03:25:00.000Z",
      }),
    });
    const shutdownResult = computeSupervisorPlan([shutdownSnapshot], config);
    expect(shutdownResult.actions[0].kind).toBe("request_shutdown");
    expect(shutdownResult.actions[0].execution.executable).toBe(true);

    // renew_lease case
    const leaseSnapshot = makeSnapshot({
      lease: makeLease({ expiresAt: "2026-06-06T03:31:00.000Z" }),
    });
    const leaseResult = computeSupervisorPlan([leaseSnapshot], config);
    expect(leaseResult.actions[0].kind).toBe("renew_lease");
    expect(leaseResult.actions[0].execution.executable).toBe(true);
  });

  it("execution intent has dryRun default guard", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action.execution).toHaveProperty("dryRun");
      // By default, planner output is always dryRun: true — caller must opt-in
      expect(action.execution.dryRun).toBe(true);
    }
  });

  it("every action exposes severity as a stable typed field", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action).toHaveProperty("severity");
      expect(["info", "warning", "critical"]).toContain(action.severity);
    }
  });

  it("noop has severity info, reap_terminate has severity critical", () => {
    const noopResult = computeSupervisorPlan([snapshot], config);
    expect(noopResult.actions[0].severity).toBe("info");

    const reapSnapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
      }),
    });
    const reapResult = computeSupervisorPlan([reapSnapshot], config);
    expect(reapResult.actions[0].severity).toBe("critical");
  });

  it("every action exposes riskFlags as a stable top-level typed field", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action).toHaveProperty("riskFlags");
      expect(Array.isArray(action.riskFlags)).toBe(true);
    }
  });

  it("riskFlags are strings and match lifecycle risk flags", () => {
    const reapSnapshot = makeSnapshot({
      lifecycleInput: makeLifecycleInput({
        lastHeartbeat: ONE_HOUR_AGO,
        lastEvidence: ONE_HOUR_AGO,
      }),
    });
    const reapResult = computeSupervisorPlan([reapSnapshot], config);
    expect(reapResult.actions[0].riskFlags).toContain("stale_heartbeat");
  });

  it("execution intent includes the planned action kind as intent", () => {
    const result = computeSupervisorPlan([snapshot], config);
    for (const action of result.actions) {
      expect(action.execution).toHaveProperty("intent");
      expect(action.execution.intent).toBe(action.kind);
    }
  });
});
