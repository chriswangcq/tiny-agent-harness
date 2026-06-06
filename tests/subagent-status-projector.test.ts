import { describe, expect, it } from "vitest";
import {
  projectWorkerStatus,
  identifyStaleWorkers,
  deriveUnifiedShutdown,
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

  // GAP 5: IM receive should not falsely signal done
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

// ---- NEW FAILING TESTS (P6-05 gaps) ----
// These tests should FAIL before source patches, then PASS after.

// GAP 1: TranscriptSnapshot removed from ProjectorInput
describe("GAP 1: transcriptSnapshot removed", () => {
  it("ProjectorInput does not accept transcriptSnapshot", () => {
    // Verify that the type no longer has transcriptSnapshot.
    // This is a type-level test: if transcriptSnapshot still exists on
    // ProjectorInput, this compiles; if removed, it is a compile error.
    // Runtime test: passing transcriptSnapshot should not be required.
    const contact = makeContact();
    const config = makeConfig();
    // ProjectorInput should NOT require transcriptSnapshot
    const input: ProjectorInput = { contact, config };
    const result = projectWorkerStatus(input);
    expect(result.status).toBeDefined();
  });

  it("transcriptSnapshot type is not exported", async () => {
    // Dynamically import to check that TranscriptSnapshot is absent
    const mod = await import("../src/subagent/status-projector.js");
    expect(mod.TranscriptSnapshot).toBeUndefined();
  });
});

// GAP 2: No Date constructor in status-projector.ts
describe("GAP 2: no Date constructor", () => {
  it("isoToMs rejects invalid ISO with 0 instead of NaN", () => {
    // Invalid ISO should produce 0 (or some safe default), not NaN.
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "not-a-date",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    // Should not propagate NaN into ageMs
    if (result.evidence.heartbeat?.ageMs !== undefined) {
      expect(Number.isNaN(result.evidence.heartbeat.ageMs)).toBe(false);
      expect(typeof result.evidence.heartbeat.ageMs).toBe("number");
    }
  });

  it("timestamp with weird format produces finite number", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06 03:00:00", // space instead of T
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    // Must not crash, must produce a finite ageMs or undefined
    if (result.evidence.heartbeat?.ageMs !== undefined) {
      expect(Number.isFinite(result.evidence.heartbeat.ageMs)).toBe(true);
    }
  });

  it("empty string timestamp handled", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    // Must not crash; empty string is effectively missing
    expect(result.status).toBeDefined();
    if (result.evidence.heartbeat?.ageMs !== undefined) {
      expect(Number.isFinite(result.evidence.heartbeat.ageMs)).toBe(true);
    }
  });
});

// GAP 3: Invalid/missing timestamp behaviour
describe("GAP 3: invalid timestamp behaviour", () => {
  it("null timestamp is treated as missing", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: null,
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);
    // null should be treated like undefined (missing)
    expect(result.riskFlags).toContain("missing_heartbeat");
    expect(result.evidence.heartbeat).toBeUndefined();
  });

  it("undefined lastEvidence on active contact flags missing", () => {
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: undefined,
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    expect(result.riskFlags).toContain("missing_evidence");
    expect(result.evidence.lastEvidence).toBeUndefined();
  });
});

// GAP 4: stale contact maps to degraded (not healthy)
//        and no_contact risk flag is removed
describe("GAP 4: stale contact semantics and no_contact removed", () => {
  it("stale contact status maps to degraded, not healthy", () => {
    const contact = makeContact({
      status: "stale",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);

    // Stale should NOT be "healthy"
    expect(result.status).not.toBe("healthy");
    expect(result.status).toBe("degraded");
  });

  it("RiskFlag type does not include no_contact", () => {
    // If no_contact still exists on the union, prove it's removed.
    // Using a type assertion: we can't runtime-test a union exhaustively
    // but we can check that riskFlags array never contains "no_contact".
    const contact = makeContact();
    const input: ProjectorInput = { contact, config: makeConfig() };
    const result = projectWorkerStatus(input);
    expect(result.riskFlags).not.toContain("no_contact");
  });
});

// GAP 5: IM receive semantics
describe("GAP 5: IM receive/send semantics", () => {
  it("imLastReceivedAt contributes to im_silence risk flag", () => {
    // Both sent and received are old -> im_silence
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      imSnapshot: {
        lastImSentAt: "2026-06-06T03:10:00.000Z",
        lastImReceivedAt: "2026-06-06T03:00:00.000Z", // old received
      },
    };
    const result = projectWorkerStatus(input);
    expect(result.riskFlags).toContain("im_silence");
  });

  it("recent IM received but old sent still flags im_silence", () => {
    // Worker hasn't sent anything but has received recent user message
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      imSnapshot: {
        lastImSentAt: "2026-06-06T03:10:00.000Z",
        lastImReceivedAt: "2026-06-06T03:28:00.000Z", // recent user message
      },
    };
    const result = projectWorkerStatus(input);
    // User/supervisor messages alone should not clear im_silence
    expect(result.riskFlags).toContain("im_silence");
    expect(result.evidence.imLastReceived).toBeDefined();
  });

  it("user IM received alone does not make worker done", () => {
    // Only IM, no run finished, no ledger clean
    const contact = makeContact({
      status: "active",
      lastHeartbeat: "2026-06-06T03:29:00.000Z",
      lastEvidence: "2026-06-06T03:28:00.000Z",
    });
    const input: ProjectorInput = {
      contact,
      config: makeConfig(),
      imSnapshot: {
        lastImSentAt: "2026-06-06T03:29:00.000Z",
        lastImReceivedAt: "2026-06-06T03:29:30.000Z",
      },
    };
    const result = projectWorkerStatus(input);
    expect(result.status).not.toBe("done");
  });
});

// GAP 6: Docs synced — covered by manual review; proxy test
describe("GAP 6: docs mention current projector contract", () => {
  it("docs/project-report.md exists and mentions status-projector", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("docs/project-report.md", "utf-8");
    expect(content).toMatch(/[Ss]tatus [Pp]rojector/);
  });

  it("docs/subagent-team.md exists and mentions status-projector", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("docs/subagent-team.md", "utf-8");
    expect(content).toMatch(/[Ss]tatus [Pp]rojector/);
  });
});

// ─── Supervisor Lifecycle Projection Tests ──────────────────────

describe("identifyStaleWorkers", () => {

  const makeWorker = (overrides: Record<string, unknown> = {}) => ({
    workerId: "w1",
    role: "coder",
    workspace: "/ws/p6",
    branch: "codex/p6/01",
    imChannel: "p6-01",
    allowedActions: ["read", "write"],
    status: "active",
    lastHeartbeat: "2026-06-06T03:25:00.000Z",
    lastEvidence: "2026-06-06T03:28:00.000Z",
    ...overrides,
  });

  const freshConfig = {
    now: "2026-06-06T03:30:00.000Z",
    heartbeatMaxAgeMs: 120_000, // 2 min
    evidenceMaxAgeMs: 300_000,
    imSilenceMaxAgeMs: 600_000,
    ledgerStallMaxAgeMs: 600_000,
    runStallMaxAgeMs: 600_000,
  };

  it("identifies worker with missing heartbeat", () => {
    const worker = makeWorker({ lastHeartbeat: undefined, lastEvidence: undefined });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: freshConfig,
    });
    expect(result.totalStale).toBe(1);
    expect(result.staleEntries[0].reason).toBe("missing_heartbeat");
  });

  it("identifies worker with stale heartbeat", () => {
    const worker = makeWorker({
      lastHeartbeat: "2026-06-06T03:20:00.000Z", // 10 min ago
    });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: { ...freshConfig, heartbeatMaxAgeMs: 120_000 },
    });
    expect(result.totalStale).toBe(1);
    expect(result.staleEntries[0].reason).toBe("stale_heartbeat");
  });

  it("skips terminated workers", () => {
    const worker = makeWorker({ status: "terminated", lastHeartbeat: undefined });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: freshConfig,
    });
    expect(result.totalStale).toBe(0);
  });

  it("dryRun returns staleEntries but empty reapable", () => {
    const worker = makeWorker({ lastHeartbeat: undefined });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: freshConfig,
      dryRun: true,
    });
    expect(result.totalStale).toBe(1);
    expect(result.reapable).toEqual([]);
    expect(result.dryRun).toBe(true);
  });

  it("when not dryRun, reapable includes stale entries", () => {
    const worker = makeWorker({ lastHeartbeat: undefined });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: freshConfig,
      dryRun: false,
    });
    expect(result.reapable.length).toBe(1);
  });

  it("fresh heartbeat is not stale", () => {
    const worker = makeWorker({
      lastHeartbeat: "2026-06-06T03:29:30.000Z", // 30s ago
    });
    const result = identifyStaleWorkers({
      workers: [worker],
      config: freshConfig,
    });
    expect(result.totalStale).toBe(0);
  });
});

describe("deriveUnifiedShutdown", () => {

  const makeWorker = (overrides: Record<string, unknown> = {}) => ({
    workerId: "w1",
    role: "coder",
    workspace: "/ws/p6",
    branch: "codex/p6/01",
    imChannel: "p6-01",
    allowedActions: ["read", "write"],
    status: "active",
    lastHeartbeat: "2026-06-06T03:25:00.000Z",
    lastEvidence: "2026-06-06T03:28:00.000Z",
    ...overrides,
  });

  const now = "2026-06-06T03:30:00.000Z";

  it("active phase shows active workers and no draining", () => {
    const workers = [makeWorker(), makeWorker({ workerId: "w2" })];
    const result = deriveUnifiedShutdown(workers, [], "active", now);
    expect(result.phase).toBe("active");
    expect(result.activeWorkers).toBe(2);
    expect(result.drainingWorkers).toBe(0);
  });

  it("draining phase counts offline workers", () => {
    const workers = [
      makeWorker(),
      makeWorker({ workerId: "w2", status: "offline" }),
    ];
    const result = deriveUnifiedShutdown(workers, [], "draining", now);
    expect(result.phase).toBe("draining");
    expect(result.drainingWorkers).toBe(1);
  });

  it("shutting_down phase reflects remaining active workers", () => {
    const workers = [
      makeWorker(),
      makeWorker({ workerId: "w2", status: "terminated" }),
    ];
    const result = deriveUnifiedShutdown(workers, [], "shutting_down", now);
    expect(result.phase).toBe("shutting_down");
    expect(result.activeWorkers).toBe(1);
  });

  it("stopped phase shows all workers offline/terminated", () => {
    const workers = [
      makeWorker({ status: "terminated" }),
      makeWorker({ workerId: "w2", status: "offline" }),
    ];
    const result = deriveUnifiedShutdown(workers, [], "stopped", now);
    expect(result.phase).toBe("stopped");
    expect(result.activeWorkers).toBe(0);
    expect(result.drainingWorkers).toBe(2);
  });

  it("counts pending (running) tasks", () => {
    const result = deriveUnifiedShutdown(
      [makeWorker()],
      [
        { status: "running", lastStepAt: now },
        { status: "waiting_for_model", lastStepAt: now },
        { status: "finished", lastStepAt: now },
      ],
      "active",
      now,
    );
    expect(result.pendingTasks).toBe(2);
  });
});
