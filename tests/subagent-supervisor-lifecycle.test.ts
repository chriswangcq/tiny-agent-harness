import { describe, expect, it } from "vitest";
import {
  computeLifecycleState,
  evaluateLease,
  interpretHeartbeat,
  decideReaperAction,
  isGracePeriodActive,
  auditReason,
  type LifecycleInput,
  type LifecycleConfig,
  type LeaseRecord,
  type ProcessTableEntry,
  type WorkerLifecycleState,
  type HeartbeatInterpretation,
  type LeaseEvaluation,
  type LifecycleAuditReason,
} from "../src/subagent/supervisor-lifecycle.js";
import * as barrel from "../src/subagent/index.js";

// ---- Test helpers ----

const NOW = "2026-06-06T03:30:00.000Z";
const ONE_MIN_AGO = "2026-06-06T03:29:00.000Z";
const TEN_MIN_AGO = "2026-06-06T03:20:00.000Z";
const THIRTY_MIN_AGO = "2026-06-06T03:00:00.000Z";
const ONE_HOUR_AGO = "2026-06-06T02:30:00.000Z";

function makeConfig(overrides: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return {
    now: NOW,
    heartbeatMaxAgeMs: 300_000,      // 5 min
    evidenceMaxAgeMs: 600_000,       // 10 min
    leaseMaxAgeMs: 600_000,           // 10 min
    gracePeriodMs: 120_000,           // 2 min
    shutdownMaxAgeMs: 600_000,        // 10 min
    processMissingMaxAgeMs: 900_000,  // 15 min
    ...overrides,
  };
}

function makeInput(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    workerId: "coder-1",
    contactStatus: "active" as const,
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

// ---- Heartbeat interpretation ----

describe("interpretHeartbeat", () => {
  it("classifies recent heartbeat as healthy", () => {
    const result = interpretHeartbeat(ONE_MIN_AGO, NOW, makeConfig());
    expect(result.kind).toBe("healthy");
    expect(result.ageMs).toBe(60000);
  });

  it("classifies old heartbeat as stale", () => {
    const result = interpretHeartbeat(TEN_MIN_AGO, NOW, makeConfig());
    expect(result.kind).toBe("stale");
    expect(result.ageMs).toBe(600000);
  });

  it("classifies very old heartbeat as expired", () => {
    const result = interpretHeartbeat(ONE_HOUR_AGO, NOW, makeConfig());
    expect(result.kind).toBe("expired");
  });

  it("classifies undefined heartbeat as missing", () => {
    const result = interpretHeartbeat(undefined, NOW, makeConfig());
    expect(result.kind).toBe("missing");
    expect(result.ageMs).toBeUndefined();
  });

  it("classifies null heartbeat as missing", () => {
    const result = interpretHeartbeat(null as unknown as string | undefined, NOW, makeConfig());
    expect(result.kind).toBe("missing");
  });

  it("classifies borderline fresh heartbeat as healthy", () => {
    // Exactly at the threshold
    const config = makeConfig({ heartbeatMaxAgeMs: 300_000 });
    const atThreshold = "2026-06-06T03:25:00.000Z"; // exactly 5 min ago
    const result = interpretHeartbeat(atThreshold, NOW, config);
    expect(result.kind).toBe("healthy");
  });

  it("classifies just-past-threshold heartbeat as stale", () => {
    const config = makeConfig({ heartbeatMaxAgeMs: 300_000 });
    const pastThreshold = "2026-06-06T03:24:59.000Z"; // just over 5 min ago
    const result = interpretHeartbeat(pastThreshold, NOW, config);
    expect(result.kind).toBe("stale");
  });

  it("respects custom thresholds", () => {
    const config = makeConfig({ heartbeatMaxAgeMs: 60_000 }); // 1 min
    const result = interpretHeartbeat(TEN_MIN_AGO, NOW, config);
    expect(result.kind).toBe("expired");
  });
});

// ---- Lease evaluation ----

describe("evaluateLease", () => {
  it("classifies active unreleased lease as valid", () => {
    const lease = makeLease();
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.status).toBe("valid");
  });

  it("classifies released lease as released", () => {
    const lease = makeLease({ releasedAt: ONE_MIN_AGO });
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.status).toBe("released");
  });

  it("classifies expired lease as expired", () => {
    const lease = makeLease({
      acquiredAt: ONE_HOUR_AGO,
      expiresAt: THIRTY_MIN_AGO,
    });
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.status).toBe("expired");
  });

  it("classifies renewed lease as valid if new expiry is in future", () => {
    const lease = makeLease({
      renewedAt: ONE_MIN_AGO,
      expiresAt: "2026-06-06T03:35:00.000Z", // 5 min in future
    });
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.status).toBe("valid");
  });

  it("classifies missing expiresAt as invalid", () => {
    const lease = makeLease({ expiresAt: undefined as unknown as string });
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.status).toBe("invalid");
  });

  it("includes reason in evaluation", () => {
    const lease = makeLease({
      acquiredAt: ONE_HOUR_AGO,
      expiresAt: THIRTY_MIN_AGO,
    });
    const result = evaluateLease(lease, NOW, makeConfig());
    expect(result.reason).toBeDefined();
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---- Grace period ----

describe("isGracePeriodActive", () => {
  it("returns false when shutdownRequestedAt is undefined", () => {
    const input = makeInput({ shutdownRequestedAt: undefined });
    const config = makeConfig();
    const state = computeLifecycleState(input, config);
    expect(isGracePeriodActive(state, config)).toBe(false);
  });

  it("returns true when shutdown was requested within grace period", () => {
    const input = makeInput({
      shutdownRequestedAt: ONE_MIN_AGO, // 1 min ago, grace period 2 min
    });
    const config = makeConfig();
    const state = computeLifecycleState(input, config);
    expect(isGracePeriodActive(state, config)).toBe(true);
  });

  it("returns false when grace period has expired", () => {
    const input = makeInput({
      shutdownRequestedAt: TEN_MIN_AGO, // 10 min ago, grace period 2 min
    });
    const config = makeConfig();
    const state = computeLifecycleState(input, config);
    expect(isGracePeriodActive(state, config)).toBe(false);
  });

  it("returns true when shutdownRequestedAt equals now (age 0)", () => {
    const input = makeInput({
      shutdownRequestedAt: NOW, // age 0
    });
    const config = makeConfig();
    const state = computeLifecycleState(input, config);
    // ageMs is 0, should be <= gracePeriodMs, and state should be grace_period
    expect(state.state).toBe("grace_period");
    expect(state.evidence.ageMs).toBe(0);
    expect(isGracePeriodActive(state, config)).toBe(true);
  });
});

// ---- Lifecycle state computation ----

describe("computeLifecycleState", () => {
  it("returns terminated when contactStatus is terminated", () => {
    const input = makeInput({ contactStatus: "terminated" });
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("terminated");
  });

  it("returns shutdown when shutdownRequestedAt is set between grace and shutdown max", () => {
    const input = makeInput({ shutdownRequestedAt: "2026-06-06T03:25:00.000Z" }); // 5 min ago, past grace but within shutdown
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("shutdown");
  });

  it("returns grace_period when shutdown just requested", () => {
    const input = makeInput({ shutdownRequestedAt: "2026-06-06T03:25:00.000Z" }); // 5 min ago, past grace but within shutdown
    const config = makeConfig({ gracePeriodMs: 300_000 }); // 5 min grace
    const result = computeLifecycleState(input, config);
    expect(result.state).toBe("grace_period");
  });

  it("returns missing_process when process does not exist and threshold exceeded", () => {
    const input = makeInput({
      processExists: false,
      lastHeartbeat: THIRTY_MIN_AGO,
    });
    const config = makeConfig({ processMissingMaxAgeMs: 600_000 }); // 10 min
    const result = computeLifecycleState(input, config);
    expect(result.state).toBe("missing_process");
  });

  it("returns expired when heartbeat and evidence are very old", () => {
    const input = makeInput({
      lastHeartbeat: ONE_HOUR_AGO,
      lastEvidence: ONE_HOUR_AGO,
    });
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("expired");
  });

  it("returns stale when heartbeat is old but evidence is recent", () => {
    const input = makeInput({
      lastHeartbeat: TEN_MIN_AGO,
      lastEvidence: ONE_MIN_AGO,
    });
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("stale");
  });

  it("returns healthy when everything is recent", () => {
    const input = makeInput();
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("healthy");
  });

  it("returns terminated for offline contact with no heartbeat", () => {
    const input = makeInput({
      contactStatus: "offline",
      lastHeartbeat: undefined,
      lastEvidence: undefined,
    });
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("terminated");
  });

  it("returns healthy when heartbeat missing but process exists and run is recent", () => {
    const input = makeInput({
      lastHeartbeat: undefined,
      processExists: true,
      runLastStepAt: ONE_MIN_AGO,
    });
    const result = computeLifecycleState(input, makeConfig());
    expect(result.state).toBe("healthy");
  });

  it("includes reason in lifecycle result", () => {
    const input = makeInput();
    const result = computeLifecycleState(input, makeConfig());
    expect(result.reason).toBeDefined();
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("includes evidence in lifecycle result", () => {
    const input = makeInput();
    const result = computeLifecycleState(input, makeConfig());
    expect(result.evidence).toBeDefined();
    expect(result.evidence.heartbeatInterpretation).toBeDefined();
  });
});

// ---- Reaper decisions ----

describe("decideReaperAction", () => {
  it("returns none for healthy worker", () => {
    const input = makeInput();
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("none");
  });

  it("returns terminate for expired worker", () => {
    const input = makeInput({
      lastHeartbeat: ONE_HOUR_AGO,
      lastEvidence: ONE_HOUR_AGO,
    });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("terminate");
  });

  it("returns warn for stale worker", () => {
    const input = makeInput({
      lastHeartbeat: TEN_MIN_AGO,
      lastEvidence: ONE_MIN_AGO,
    });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("warn");
  });

  it("returns terminate for missing_process worker", () => {
    const input = makeInput({
      processExists: false,
      lastHeartbeat: THIRTY_MIN_AGO,
    });
    const config = makeConfig({ processMissingMaxAgeMs: 600_000 });
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("terminate");
  });

  it("returns none for shutdown worker (already shutting down)", () => {
    const input = makeInput({ shutdownRequestedAt: "2026-06-06T03:25:00.000Z" }); // 5 min ago, past grace but within shutdown
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("none");
  });

  it("returns none for terminated worker", () => {
    const input = makeInput({ contactStatus: "terminated" });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("none");
  });

  it("returns reassign for stale worker with open ledger problems", () => {
    const input = makeInput({
      lastHeartbeat: TEN_MIN_AGO,
      lastEvidence: TEN_MIN_AGO,
      ledgerOpenProblems: 3,
    });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.action).toBe("reassign");
  });

  it("includes reason in reaper decision", () => {
    const input = makeInput({ lastHeartbeat: ONE_HOUR_AGO, lastEvidence: ONE_HOUR_AGO });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result = decideReaperAction(input, lifecycle, config);
    expect(result.reason).toBeDefined();
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---- Audit reasons ----

describe("auditReason", () => {
  it("produces audit reason for state transition", () => {
    const reason = auditReason(NOW, 
      "stale",
      "healthy",
      "heartbeat_age_exceeded",
      { heartbeatAgeMs: 600_000, thresholdMs: 300_000 }
    );
    expect(reason.fromState).toBe("healthy");
    expect(reason.toState).toBe("stale");
    expect(reason.event).toBe("heartbeat_age_exceeded");
    expect(reason.decidedAt).toBeDefined();
    expect(reason.context).toEqual({ heartbeatAgeMs: 600_000, thresholdMs: 300_000 });
  });

  it("includes workerId when provided", () => {
    const reason = auditReason(NOW, "expired", "stale", "lease_expired", {}, "coder-1");
    expect(reason.workerId).toBe("coder-1");
  });

  it("handles empty context", () => {
    const reason = auditReason(NOW, "terminated", "shutdown", "shutdown_complete");
    expect(reason.fromState).toBe("shutdown");
    expect(reason.toState).toBe("terminated");
    expect(reason.context).toEqual({});
  });
});

// ---- Purity contract ----

describe("purity contract", () => {
  it("computeLifecycleState is deterministic with same inputs", () => {
    const input = makeInput();
    const config = makeConfig();
    const result1 = computeLifecycleState(input, config);
    const result2 = computeLifecycleState(input, config);
    expect(result1).toEqual(result2);
  });

  it("interpretHeartbeat is deterministic with same inputs", () => {
    const result1 = interpretHeartbeat(TEN_MIN_AGO, NOW, makeConfig());
    const result2 = interpretHeartbeat(TEN_MIN_AGO, NOW, makeConfig());
    expect(result1).toEqual(result2);
  });

  it("evaluateLease is deterministic with same inputs", () => {
    const lease = makeLease();
    const result1 = evaluateLease(lease, NOW, makeConfig());
    const result2 = evaluateLease(lease, NOW, makeConfig());
    expect(result1).toEqual(result2);
  });

  it("decideReaperAction is deterministic with same inputs", () => {
    const input = makeInput({ lastHeartbeat: TEN_MIN_AGO, lastEvidence: ONE_MIN_AGO });
    const config = makeConfig();
    const lifecycle = computeLifecycleState(input, config);
    const result1 = decideReaperAction(input, lifecycle, config);
    const result2 = decideReaperAction(input, lifecycle, config);
    expect(result1).toEqual(result2);
  });
});

// ---- Barrel export ----

describe("barrel export", () => {
  it("exports computeLifecycleState from index", () => {
    expect(barrel.computeLifecycleState).toBe(computeLifecycleState);
  });

  it("exports evaluateLease from index", () => {
    expect(barrel.evaluateLease).toBe(evaluateLease);
  });

  it("exports interpretHeartbeat from index", () => {
    expect(barrel.interpretHeartbeat).toBe(interpretHeartbeat);
  });

  it("exports decideReaperAction from index", () => {
    expect(barrel.decideReaperAction).toBe(decideReaperAction);
  });

  it("exports isGracePeriodActive from index", () => {
    expect(barrel.isGracePeriodActive).toBe(isGracePeriodActive);
  });

  it("exports auditReason from index", () => {
    expect(barrel.auditReason).toBe(auditReason);
  });
});
