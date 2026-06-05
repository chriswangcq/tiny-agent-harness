import { describe, expect, it } from "vitest";
import {
  projectWorkerStatus,
  type ProjectorInput,
  type WorkerStatusProjection,
  type WorkerStatusCode,
} from "../src/subagent/status-projector.js";
import { projectWorkerStatus as projectFromBarrel } from "../src/subagent/index.js";

// Test helpers
// Default timestamps are close to "now" (03:30) to avoid unintended stale flags.
function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    workerId: "coder-1",
    role: "coder",
    workspace: "/ws/p6",
    branch: "codex/p6/05",
    imChannel: "p6-05",
    allowedActions: ["read", "write", "test"],
    status: "active" as const,
    lastHeartbeat: "2026-06-06T03:29:00.000Z",
    lastEvidence: "2026-06-06T03:28:00.000Z",
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    now: "2026-06-06T03:30:00.000Z",
    heartbeatMaxAgeMs: 300_000, // 5 minutes
    evidenceMaxAgeMs: 600_000, // 10 minutes
    imSilenceMaxAgeMs: 900_000, // 15 minutes
    ledgerStallMaxAgeMs: 900_000,
    runStallMaxAgeMs: 600_000,
    ...overrides,
  };
}

describe("status projector", () => {
  it("classifies terminated worker", () => {
    const contact = makeContact({ status: "terminated", lastHeartbeat: undefined, lastEvidence: undefined });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("terminated");
    expect(result.reason).toContain("terminated");
    expect(result.riskFlags).toEqual([]);
  });

  it("classifies offline worker", () => {
    const contact = makeContact({ status: "offline", lastHeartbeat: undefined });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("offline");
    expect(result.reason).toContain("offline");
  });

  it("classifies healthy active worker with recent heartbeat and evidence", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      runSnapshot: { status: "running", lastStepAt: "2026-06-06T03:29:30.000Z" },
      imSnapshot: { lastImSentAt: "2026-06-06T03:27:00.000Z" },
    };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("healthy");
    expect(result.reason).toContain("healthy");
    expect(result.riskFlags).toEqual([]);
    expect(result.evidence.heartbeat).toBeDefined();
    expect(result.evidence.heartbeat?.timestamp).toBe("2026-06-06T03:29:00.000Z");
    expect(result.evidence.heartbeat?.ageMs).toBeLessThan(300_000);
  });

  it("classifies idle healthy worker", () => {
    const contact = makeContact({
      status: "idle",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("idle");
    expect(result.reason).toContain("idle");
  });

  it("flags stale heartbeat", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:20:00.000Z", // 10 min ago
      lastEvidence: "2026-06-06T03:20:00.000Z",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("degraded");
    expect(result.riskFlags).toContain("stale_heartbeat");
    expect(result.evidence.heartbeat?.ageMs).toBeGreaterThan(300_000);
  });

  it("flags missing heartbeat", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: undefined,
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("degraded");
    expect(result.riskFlags).toContain("missing_heartbeat");
  });

  it("flags missing evidence", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: undefined,
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("missing_evidence");
  });

  it("flags IM silence", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      imSnapshot: { lastImSentAt: "2026-06-06T03:10:00.000Z" }, // 20 min ago
    };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("im_silence");
    expect(result.status).toBe("degraded");
  });

  it("flags run stall", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      runSnapshot: { status: "waiting_for_io", lastStepAt: "2026-06-06T03:15:00.000Z" },
    };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("run_stall");
    expect(result.status).toBe("degraded");
  });

  it("flags ledger stall", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      ledgerSnapshot: {
        ledgerId: "L001",
        lastActivityAt: "2026-06-06T03:10:00.000Z",
        openProblemCount: 3,
      },
    };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("ledger_stall");
  });

  it("classifies stuck worker with multiple risk flags", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T02:00:00.000Z", // 90 min ago
      lastEvidence: "2026-06-06T02:00:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      runSnapshot: { status: "waiting_for_io", lastStepAt: "2026-06-06T02:00:00.000Z" },
      imSnapshot: { lastImSentAt: "2026-06-06T02:00:00.000Z" },
      ledgerSnapshot: {
        ledgerId: "L001",
        lastActivityAt: "2026-06-06T02:00:00.000Z",
        openProblemCount: 5,
      },
    };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("stuck");
    expect(result.riskFlags.length).toBeGreaterThanOrEqual(4);
  });

  it("classifies done worker (all work complete)", () => {
    const contact = makeContact({
      status: "idle",
      lastHeartbeat: "2026-06-06T03:28:00.000Z",
      lastEvidence: "2026-06-06T03:25:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      runSnapshot: { status: "finished", lastStepAt: "2026-06-06T03:25:00.000Z" },
      imSnapshot: { lastImSentAt: "2026-06-06T03:27:00.000Z" },
      ledgerSnapshot: {
        ledgerId: "L001",
        lastActivityAt: "2026-06-06T03:27:00.000Z",
        openProblemCount: 0,
      },
    };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("done");
    expect(result.reason).toContain("complete");
  });

  it("avoids false done from single IM event", () => {
    // Run is still active, just an IM was sent
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      runSnapshot: { status: "running", lastStepAt: "2026-06-06T03:29:00.000Z" },
      imSnapshot: { lastImSentAt: "2026-06-06T03:29:30.000Z" }, // IM just sent
      ledgerSnapshot: {
        ledgerId: "L001",
        lastActivityAt: "2026-06-06T03:25:00.000Z",
        openProblemCount: 3, // still has open problems
      },
    };
    const result = projectWorkerStatus(input);

    // Should NOT be "done" — run is still running and ledger has open problems
    expect(result.status).not.toBe("done");
    expect(result.status).toBe("healthy");
  });

  it("returns unknown for worker with unrecognized status", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    // Monkey-patch to an unrecognized status value
    const weirdContact = { ...contact, status: "bogus" as never };
    const input: ProjectorInput = { contact: weirdContact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBe("unknown");
  });

  it("computes correct age from timestamps", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:25:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig({ now: "2026-06-06T03:30:00.000Z" }),
    };
    const result = projectWorkerStatus(input);

    expect(result.evidence.heartbeat?.ageMs).toBe(300_000); // exactly 5 min
  });

  it("handles missing optional snapshots gracefully", () => {
    const contact = makeContact({ status: "active" });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.status).toBeDefined();
    expect(result.projectedAt).toBe(makeConfig().now);
  });

  it("accepts lifecycle template to adjust thresholds", () => {
    const contact = makeContact({
      status: "active",
      role: "master",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      lifecycle: {
        role: "master",
        expectedHeartbeatIntervalMs: 600_000, // master checks in every 10 min
      },
    };
    const result = projectWorkerStatus(input);

    // Master with 10-min expected interval should still be healthy at 1 min
    expect(result.status).toBe("healthy");
  });

  it("stale worker detected with tight lifecycle thresholds", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:10:00.000Z", // 20 min ago
      lastEvidence: "2026-06-06T03:10:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      lifecycle: {
        role: "coder",
        expectedHeartbeatIntervalMs: 60_000, // expected every 1 min
      },
    };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("stale_heartbeat");
  });

  it("exports from barrel", () => {
    expect(projectFromBarrel).toBe(projectWorkerStatus);
  });
});

// Age computation purity contract
describe("purity contract", () => {
  it("produces same output for same inputs", () => {
    const contact = makeContact({ status: "active" });
    const config = makeConfig();
    const input: ProjectorInput = { contact, config };

    const r1 = projectWorkerStatus(input);
    const r2 = projectWorkerStatus(input);

    expect(r1).toEqual(r2);
  });

  it("does not call Date.now (verified by deterministic age)", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:00:00.000Z",
    });
    const config = makeConfig({ now: "2026-06-06T03:30:00.000Z" });
    const result = projectWorkerStatus({ contact, config });

    // Age should be exactly 30 minutes = 1,800,000 ms
    expect(result.evidence.heartbeat?.ageMs).toBe(1_800_000);
  });
});
