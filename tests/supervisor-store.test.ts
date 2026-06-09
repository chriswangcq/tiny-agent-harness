import { describe, it, expect, beforeEach } from "vitest";
import {
  planRunScopedSupervisorPaths,
  createSupervisorLifecycleEvent,
  createSupervisorSnapshot,
  SUPERVISOR_SNAPSHOT_VERSION,
  appendLifecycleEvent,
  readAllLifecycleEvents,
  validateLifecycleEvent,
  createInMemorySupervisorPorts,
} from "../src/subagent/supervisor-store.js";
import type {
  SupervisorLifecycleEvent,
  SupervisorLifecycleEventType,
  SupervisorPaths,
  SupervisorPorts,
  SupervisorSnapshot,
  ReadLifecycleResult,
} from "../src/subagent/supervisor-store.js";

describe("planRunScopedSupervisorPaths", () => {
  it("returns paths under runs/<runId>/supervisor", () => {
    const paths = planRunScopedSupervisorPaths("/home/user/project", "run-001");
    expect(paths.supervisorDir).toBe(
      "/home/user/project/runs/run-001/supervisor",
    );
    expect(paths.eventsFile).toBe(
      "/home/user/project/runs/run-001/supervisor/lifecycle-events.jsonl",
    );
    expect(paths.snapshotFile).toBe(
      "/home/user/project/runs/run-001/supervisor/snapshot.json",
    );
  });

  it("strips trailing slashes from state root", () => {
    const paths = planRunScopedSupervisorPaths("/home/user/project/", "run-001");
    expect(paths.supervisorDir).toBe(
      "/home/user/project/runs/run-001/supervisor",
    );
  });

  it("rejects state roots containing .. that would escape", () => {
    expect(() =>
      planRunScopedSupervisorPaths("/home/user/../escape", "run-001"),
    ).toThrow(/path traversal/i);
  });

  it("rejects runId containing ..", () => {
    expect(() =>
      planRunScopedSupervisorPaths("/home/user/project", "../escape"),
    ).toThrow(/path traversal/i);
  });

  it("rejects runId with path separators", () => {
    expect(() =>
      planRunScopedSupervisorPaths("/home/user/project", "run/../escape"),
    ).toThrow(/path traversal/i);
  });

  it("allows normal paths and runIds", () => {
    expect(() =>
      planRunScopedSupervisorPaths("/home/user/project", "run-001"),
    ).not.toThrow();
    expect(() =>
      planRunScopedSupervisorPaths("/home/user/project", "run-1780792696584"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Event creation and validation tests
// ---------------------------------------------------------------------------

describe("createSupervisorLifecycleEvent", () => {
  it("creates a member_added event with required fields", () => {
    const event = createSupervisorLifecycleEvent("evt-001", "member_added", {
      workerId: "w1",
      role: "coder",
      workspace: "/home/w1",
      branch: "main",
      imChannel: "ch1",
    }, "2024-01-01T00:00:00.000Z");
    expect(event.eventId).toBe("evt-001");
    expect(event.type).toBe("member_added");
    expect(event.timestamp).toBeDefined();
    expect(typeof event.timestamp).toBe("string");
  });

  it("creates a member_status_changed event", () => {
    const event = createSupervisorLifecycleEvent(
      "evt-002",
      "member_status_changed",
      { workerId: "w1", status: "active", previousStatus: "idle" },
      "2024-01-01T00:00:00.000Z",
    );
    expect(event.type).toBe("member_status_changed");
  });

  it("creates a member_heartbeat event", () => {
    const event = createSupervisorLifecycleEvent("evt-003", "member_heartbeat", {
      workerId: "w1",
    }, "2024-01-01T00:00:00.000Z");
    expect(event.type).toBe("member_heartbeat");
  });

  it("creates a member_terminated event", () => {
    const event = createSupervisorLifecycleEvent(
      "evt-004",
      "member_terminated",
      { workerId: "w1", reason: "completed" },
      "2024-01-01T00:00:00.000Z",
    );
    expect(event.type).toBe("member_terminated");
  });

  // ---- Lease events ----
  it("creates a lease_requested event", () => {
    const event = createSupervisorLifecycleEvent("evt-005", "lease_requested", {
      workerId: "w1",
      leaseId: "lease-001",
      resource: "task-001",
      requestedAt: "2024-01-01T00:00:00.000Z",
    }, "2024-01-01T00:00:00.000Z");
    expect(event.type).toBe("lease_requested");
  });

  it("creates a lease_acquired event", () => {
    const event = createSupervisorLifecycleEvent("evt-010", "lease_acquired", {
      workerId: "w1",
      leaseId: "lease-001",
      resource: "task-001",
      acquiredAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2024-01-01T01:00:00.000Z",
    }, "2024-01-01T00:00:00.000Z");
    expect(event.type).toBe("lease_acquired");
  });

  it("creates a lease_renewed event", () => {
    const event = createSupervisorLifecycleEvent("evt-011", "lease_renewed", {
      workerId: "w1",
      leaseId: "lease-001",
      renewedAt: "2024-01-01T00:30:00.000Z",
      newExpiresAt: "2024-01-01T01:30:00.000Z",
    }, "2024-01-01T00:30:00.000Z");
    expect(event.type).toBe("lease_renewed");
  });

  it("creates a lease_released event", () => {
    const event = createSupervisorLifecycleEvent("evt-012", "lease_released", {
      workerId: "w1",
      leaseId: "lease-001",
      releasedAt: "2024-01-01T00:45:00.000Z",
    }, "2024-01-01T00:45:00.000Z");
    expect(event.type).toBe("lease_released");
  });

  it("creates a lease_expired event", () => {
    const event = createSupervisorLifecycleEvent("evt-013", "lease_expired", {
      workerId: "w1",
      leaseId: "lease-001",
      expiredAt: "2024-01-01T01:00:00.000Z",
    }, "2024-01-01T01:00:00.000Z");
    expect(event.type).toBe("lease_expired");
  });

  // ---- Heartbeat ----
  it("creates a heartbeat_recorded event", () => {
    const event = createSupervisorLifecycleEvent("evt-020", "heartbeat_recorded", {
      workerId: "w1",
      sequence: 5,
      cadenceMs: 60000,
    }, "2024-01-01T00:05:00.000Z");
    expect(event.type).toBe("heartbeat_recorded");
  });

  // ---- Shutdown ----
  it("creates a shutdown_requested event", () => {
    const event = createSupervisorLifecycleEvent("evt-030", "shutdown_requested", {
      phase: "draining",
      requestedBy: "master",
      reason: "maintenance window",
    }, "2024-01-01T00:00:00.000Z");
    expect(event.type).toBe("shutdown_requested");
  });

  it("creates a shutdown_draining event", () => {
    const event = createSupervisorLifecycleEvent("evt-031", "shutdown_draining", {
      remainingWorkers: 3,
    }, "2024-01-01T00:01:00.000Z");
    expect(event.type).toBe("shutdown_draining");
  });

  it("creates a shutdown_completed event", () => {
    const event = createSupervisorLifecycleEvent("evt-032", "shutdown_completed", {
      totalWorkersTerminated: 5,
    }, "2024-01-01T00:05:00.000Z");
    expect(event.type).toBe("shutdown_completed");
  });

  it("creates a shutdown_failed event", () => {
    const event = createSupervisorLifecycleEvent("evt-033", "shutdown_failed", {
      reason: "workers did not drain in time",
    }, "2024-01-01T00:10:00.000Z");
    expect(event.type).toBe("shutdown_failed");
  });

  // ---- Reaper ----
  it("creates a reaper_planned event", () => {
    const event = createSupervisorLifecycleEvent("evt-040", "reaper_planned", {
      candidateWorkerId: "w1",
      reason: "stale heartbeat > 5min",
      plannedAction: "terminate",
    }, "2024-01-01T00:10:00.000Z");
    expect(event.type).toBe("reaper_planned");
  });

  it("creates a reaper_executed event", () => {
    const event = createSupervisorLifecycleEvent("evt-041", "reaper_executed", {
      workerId: "w1",
      action: "terminate",
      reason: "stale heartbeat > 5min",
      affectedLeases: ["lease-001", "lease-002"],
    }, "2024-01-01T00:10:00.000Z");
    expect(event.type).toBe("reaper_executed");
  });

  it("creates a reaper_skipped event", () => {
    const event = createSupervisorLifecycleEvent("evt-042", "reaper_skipped", {
      candidateWorkerId: "w2",
      reason: "recent heartbeat, not stale",
    }, "2024-01-01T00:10:00.000Z");
    expect(event.type).toBe("reaper_skipped");
  });
});

describe("validateLifecycleEvent", () => {
  it("accepts a valid existing event", () => {
    const event = createSupervisorLifecycleEvent("evt-001", "member_heartbeat", {
      workerId: "w1",
    }, "2024-01-01T00:00:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a lease_acquired event", () => {
    const event = createSupervisorLifecycleEvent("evt-010", "lease_acquired", {
      workerId: "w1",
      leaseId: "lease-001",
      resource: "task-001",
      acquiredAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2024-01-01T01:00:00.000Z",
    }, "2024-01-01T00:00:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a heartbeat_recorded event", () => {
    const event = createSupervisorLifecycleEvent("evt-020", "heartbeat_recorded", {
      workerId: "w1",
      sequence: 5,
      cadenceMs: 60000,
    }, "2024-01-01T00:05:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a shutdown_requested event (no workerId)", () => {
    const event = createSupervisorLifecycleEvent("evt-030", "shutdown_requested", {
      phase: "draining",
      requestedBy: "master",
    }, "2024-01-01T00:00:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a shutdown_failed event (no workerId)", () => {
    const event = createSupervisorLifecycleEvent("evt-033", "shutdown_failed", {
      reason: "workers did not drain",
    }, "2024-01-01T00:10:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a reaper_planned event (candidateWorkerId)", () => {
    const event = createSupervisorLifecycleEvent("evt-040", "reaper_planned", {
      candidateWorkerId: "w1",
      reason: "stale",
      plannedAction: "warn",
    }, "2024-01-01T00:10:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a reaper_executed event (workerId)", () => {
    const event = createSupervisorLifecycleEvent("evt-041", "reaper_executed", {
      workerId: "w1",
      action: "terminate",
      reason: "stale heartbeat",
    }, "2024-01-01T00:10:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a reaper_skipped event (candidateWorkerId)", () => {
    const event = createSupervisorLifecycleEvent("evt-042", "reaper_skipped", {
      candidateWorkerId: "w2",
      reason: "not stale",
    }, "2024-01-01T00:10:00.000Z");
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects reaper_planned without candidateWorkerId", () => {
    const result = validateLifecycleEvent({
      eventId: "evt-040",
      type: "reaper_planned",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: { reason: "stale" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /candidateWorkerId/i.test(e))).toBe(true);
  });

  it("rejects null", () => {
    const result = validateLifecycleEvent(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing eventId", () => {
    const result = validateLifecycleEvent({
      type: "member_heartbeat",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: { workerId: "w1" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /eventId/i.test(e))).toBe(true);
  });

  it("rejects unknown type", () => {
    const result = validateLifecycleEvent({
      eventId: "evt-001",
      type: "unknown_type",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /type/i.test(e))).toBe(true);
  });

  it("rejects missing timestamp", () => {
    const result = validateLifecycleEvent({
      eventId: "evt-001",
      type: "member_heartbeat",
      payload: { workerId: "w1" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /timestamp/i.test(e))).toBe(true);
  });

  it("rejects member_heartbeat without workerId in payload", () => {
    const result = validateLifecycleEvent({
      eventId: "evt-001",
      type: "member_heartbeat",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /workerId/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Append and read tests (in-memory ports)
// ---------------------------------------------------------------------------

describe("appendLifecycleEvent and readAllLifecycleEvents", () => {
  let ports: SupervisorPorts;
  let runPaths: SupervisorPaths;
  let clockNow: string;

  beforeEach(() => {
    ports = createInMemorySupervisorPorts();
    runPaths = planRunScopedSupervisorPaths("/test/project", "run-001");
    clockNow = "2024-06-01T12:00:00.000Z";
  });

  it("appends and reads back a single event", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    const appendResult = await appendLifecycleEvent(ports, runPaths, event);
    expect(appendResult.status).toBe("appended");

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.validEvents[0].eventId).toBe("evt-001");
    expect(readResult.parseErrors).toHaveLength(0);
  });

  it("appends and reads back multiple events round-trip", async () => {
    const events = [
      createSupervisorLifecycleEvent(
        "evt-001",
        "member_added",
        { workerId: "w1", role: "coder", workspace: "/w1", branch: "main", imChannel: "ch1" },
        clockNow,
      ),
      createSupervisorLifecycleEvent(
        "evt-002",
        "member_status_changed",
        { workerId: "w1", status: "active", previousStatus: "idle" },
        clockNow,
      ),
      createSupervisorLifecycleEvent(
        "evt-003",
        "member_heartbeat",
        { workerId: "w1" },
        clockNow,
      ),
    ];

    for (const event of events) {
      const result = await appendLifecycleEvent(ports, runPaths, event);
      expect(result.status).toBe("appended");
    }

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(3);
    expect(readResult.parseErrors).toHaveLength(0);
    expect(readResult.validEvents.map((e) => e.eventId)).toEqual([
      "evt-001",
      "evt-002",
      "evt-003",
    ]);
  });

  it("rejects duplicate event IDs", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, event);

    const event2 = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    const result = await appendLifecycleEvent(ports, runPaths, event2);
    expect(result.status).toBe("duplicate");
  });

  it("rejects invalid events and does not write them to JSONL", async () => {
    const invalidEvent = {
      eventId: "evt-bad",
      type: "unknown_type",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: {},
    } as SupervisorLifecycleEvent;

    const result = await appendLifecycleEvent(ports, runPaths, invalidEvent);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Invalid");
    }

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(0);
  });

  it("reads valid events alongside malformed lines", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, event);

    const eventsPath = runPaths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      (await ports.fs.readFile(eventsPath)) + "this is not json\n",
    );

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.validEvents[0].eventId).toBe("evt-001");
    expect(readResult.parseErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("skips empty lines in the JSONL file", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, event);

    const eventsPath = runPaths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      (await ports.fs.readFile(eventsPath)) + "\n\n",
    );

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.parseErrors).toHaveLength(0);
  });

  it("reports validation errors for events with wrong shape", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, event);

    const eventsPath = runPaths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      (await ports.fs.readFile(eventsPath)) +
        JSON.stringify({ eventId: "bad", type: "unknown", timestamp: "x", payload: {} }) + "\n",
    );

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.parseErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves idempotency across restarts by tracking event IDs in snapshot", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, event);

    const snapshot = createSupervisorSnapshot(
      { eventIds: ["evt-001"] },
      clockNow,
    );

    await ports.fs.writeFile(
      runPaths.snapshotFile,
      JSON.stringify(snapshot),
    );

    const event2 = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );

    const appendResult = await appendLifecycleEvent(
      ports,
      runPaths,
      event2,
      { loadSnapshot: true },
    );
    expect(appendResult.status).toBe("duplicate");
  });

  it("can read from an empty file (no events)", async () => {
    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(0);
    expect(readResult.parseErrors).toHaveLength(0);
  });

  // ---- Run-scoped append/read tests ----
  it("appends and reads from run-scoped paths", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-r001",
      "lease_acquired",
      {
        workerId: "w1",
        leaseId: "lease-001",
        resource: "task-001",
        acquiredAt: clockNow,
        expiresAt: "2024-06-01T13:00:00.000Z",
      },
      clockNow,
    );
    const appendResult = await appendLifecycleEvent(ports, runPaths, event);
    expect(appendResult.status).toBe("appended");

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.validEvents[0].type).toBe("lease_acquired");
    expect(readResult.parseErrors).toHaveLength(0);
  });

  it("isolates separate run-scoped stores", async () => {
    const otherRunPaths = planRunScopedSupervisorPaths("/test/project", "run-002");
    const firstRunEvent = createSupervisorLifecycleEvent(
      "evt-001",
      "member_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, runPaths, firstRunEvent);

    const runEvent = createSupervisorLifecycleEvent(
      "evt-r001",
      "lease_acquired",
      {
        workerId: "w1",
        leaseId: "lease-001",
        resource: "task-001",
        acquiredAt: clockNow,
        expiresAt: "2024-06-01T13:00:00.000Z",
      },
      clockNow,
    );
    await appendLifecycleEvent(ports, otherRunPaths, runEvent);

    const firstRead = await readAllLifecycleEvents(ports, runPaths);
    expect(firstRead.validEvents).toHaveLength(1);
    expect(firstRead.validEvents[0].type).toBe("member_heartbeat");

    const secondRead = await readAllLifecycleEvents(ports, otherRunPaths);
    expect(secondRead.validEvents).toHaveLength(1);
    expect(secondRead.validEvents[0].type).toBe("lease_acquired");
  });

  it("round-trips all new event types through append and read", async () => {
    const events: SupervisorLifecycleEvent[] = [
      // Leases
      createSupervisorLifecycleEvent("evt-005", "lease_requested", {
        workerId: "w1", leaseId: "l1", resource: "t1",
        requestedAt: clockNow,
      }, clockNow),
      createSupervisorLifecycleEvent("evt-010", "lease_acquired", {
        workerId: "w1", leaseId: "l1", resource: "t1",
        acquiredAt: clockNow, expiresAt: "2024-06-01T13:00:00.000Z",
      }, clockNow),
      createSupervisorLifecycleEvent("evt-011", "lease_renewed", {
        workerId: "w1", leaseId: "l1",
        renewedAt: clockNow, newExpiresAt: "2024-06-01T14:00:00.000Z",
      }, clockNow),
      createSupervisorLifecycleEvent("evt-012", "lease_released", {
        workerId: "w1", leaseId: "l1", releasedAt: clockNow,
      }, clockNow),
      createSupervisorLifecycleEvent("evt-013", "lease_expired", {
        workerId: "w1", leaseId: "l1", expiredAt: clockNow,
      }, clockNow),
      // Heartbeat
      createSupervisorLifecycleEvent("evt-020", "heartbeat_recorded", {
        workerId: "w1", sequence: 1, cadenceMs: 60000,
      }, clockNow),
      // Shutdown (supervisor-level, no workerId)
      createSupervisorLifecycleEvent("evt-030", "shutdown_requested", {
        phase: "draining", requestedBy: "master",
      }, clockNow),
      createSupervisorLifecycleEvent("evt-031", "shutdown_draining", {
        remainingWorkers: 3,
      }, clockNow),
      createSupervisorLifecycleEvent("evt-032", "shutdown_completed", {
        totalWorkersTerminated: 5,
      }, clockNow),
      createSupervisorLifecycleEvent("evt-033", "shutdown_failed", {
        reason: "workers did not drain",
      }, clockNow),
      // Reaper
      createSupervisorLifecycleEvent("evt-040", "reaper_planned", {
        candidateWorkerId: "w1", reason: "stale", plannedAction: "terminate",
      }, clockNow),
      createSupervisorLifecycleEvent("evt-041", "reaper_executed", {
        workerId: "w1", action: "terminate", reason: "stale",
      }, clockNow),
      createSupervisorLifecycleEvent("evt-042", "reaper_skipped", {
        candidateWorkerId: "w2", reason: "not stale",
      }, clockNow),
    ];

    for (const event of events) {
      const result = await appendLifecycleEvent(ports, runPaths, event);
      expect(result.status).toBe("appended");
    }

    const readResult = await readAllLifecycleEvents(ports, runPaths);
    expect(readResult.validEvents).toHaveLength(13);
    expect(readResult.parseErrors).toHaveLength(0);

    const types = readResult.validEvents.map((e) => e.type);
    expect(types).toEqual([
      "lease_requested",
      "lease_acquired",
      "lease_renewed",
      "lease_released",
      "lease_expired",
      "heartbeat_recorded",
      "shutdown_requested",
      "shutdown_draining",
      "shutdown_completed",
      "shutdown_failed",
      "reaper_planned",
      "reaper_executed",
      "reaper_skipped",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------

describe("createSupervisorSnapshot", () => {
  it("creates a snapshot with schema version and timestamps", () => {
    const snapshot = createSupervisorSnapshot(
      { eventIds: ["evt-001", "evt-002"] },
      "2024-06-01T12:00:00.000Z",
    );
    expect(snapshot.schemaVersion).toBe(SUPERVISOR_SNAPSHOT_VERSION);
    expect(snapshot.state.eventIds).toEqual(["evt-001", "evt-002"]);
    expect(snapshot.createdAt).toBe("2024-06-01T12:00:00.000Z");
    expect(snapshot.updatedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("preserves createdAt on rewrite", () => {
    const snapshot = createSupervisorSnapshot(
      { eventIds: ["evt-001"] },
      "2024-06-01T12:00:00.000Z",
      "2024-06-01T11:00:00.000Z",
    );
    expect(snapshot.createdAt).toBe("2024-06-01T11:00:00.000Z");
    expect(snapshot.updatedAt).toBe("2024-06-01T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// In-memory ports tests
// ---------------------------------------------------------------------------

describe("createInMemorySupervisorPorts", () => {
  it("provides readable fs port that throws ENOENT for missing files", async () => {
    const ports = createInMemorySupervisorPorts();
    await expect(ports.fs.readFile("/nonexistent")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("provides writable fs port with mkdir", async () => {
    const ports = createInMemorySupervisorPorts();
    await ports.fs.mkdir("/test/dir");
    await ports.fs.writeFile("/test/dir/file.txt", "hello");
    const content = await ports.fs.readFile("/test/dir/file.txt");
    expect(content).toBe("hello");
  });

  it("provides clock port that returns configured time", () => {
    const ports = createInMemorySupervisorPorts("2024-01-01T00:00:00.000Z");
    expect(ports.clock.now()).toBe("2024-01-01T00:00:00.000Z");
  });
});
