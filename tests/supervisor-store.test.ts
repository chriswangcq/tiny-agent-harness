import { describe, it, expect, beforeEach } from "vitest";
import {
  planSupervisorPaths,
  createSupervisorLifecycleEvent,
  createSupervisorSnapshot,
  SUPERVISOR_SNAPSHOT_VERSION,
  appendLifecycleEvent,
  readAllLifecycleEvents,
  validateLifecycleEvent,
  createInMemorySupervisorPorts,
} from "../src/supervisor/supervisor-store.js";
import type {
  SupervisorLifecycleEvent,
  SupervisorLifecycleEventType,
  SupervisorPaths,
  SupervisorPorts,
  SupervisorSnapshot,
  ReadLifecycleResult,
} from "../src/supervisor/supervisor-store.js";

// ---------------------------------------------------------------------------
// Path planner tests
// ---------------------------------------------------------------------------

describe("planSupervisorPaths", () => {
  it("returns paths under .tiny-agent/supervisor", () => {
    const paths = planSupervisorPaths("/home/user/project");
    expect(paths.supervisorDir).toBe("/home/user/project/.tiny-agent/supervisor");
    expect(paths.eventsFile).toBe(
      "/home/user/project/.tiny-agent/supervisor/lifecycle-events.jsonl",
    );
    expect(paths.snapshotFile).toBe(
      "/home/user/project/.tiny-agent/supervisor/snapshot.json",
    );
  });

  it("strips trailing slashes from project root", () => {
    const paths = planSupervisorPaths("/home/user/project/");
    expect(paths.supervisorDir).toBe("/home/user/project/.tiny-agent/supervisor");
  });

  it("rejects project roots containing .. that would escape", () => {
    expect(() => planSupervisorPaths("/home/user/../escape")).toThrow(
      /path traversal/i,
    );
  });

  it("rejects project roots with .. in the middle", () => {
    expect(() => planSupervisorPaths("/home/../user/project")).toThrow(
      /path traversal/i,
    );
  });

  it("allows normal paths without traversal", () => {
    expect(() => planSupervisorPaths("/home/user/project")).not.toThrow();
    expect(() => planSupervisorPaths("/")).not.toThrow();
    expect(() =>
      planSupervisorPaths("/home/user/project.with.dots"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Event creation and validation tests
// ---------------------------------------------------------------------------

describe("createSupervisorLifecycleEvent", () => {
  it("creates a worker_registered event with required fields", () => {
    const event = createSupervisorLifecycleEvent("evt-001", "worker_registered", {
      workerId: "w1",
      role: "coder",
      workspace: "/home/w1",
      branch: "main",
      imChannel: "ch1",
    });
    expect(event.eventId).toBe("evt-001");
    expect(event.type).toBe("worker_registered");
    expect(event.timestamp).toBeDefined();
    expect(typeof event.timestamp).toBe("string");
  });

  it("creates a worker_status_changed event", () => {
    const event = createSupervisorLifecycleEvent(
      "evt-002",
      "worker_status_changed",
      { workerId: "w1", status: "active", previousStatus: "idle" },
    );
    expect(event.type).toBe("worker_status_changed");
  });

  it("creates a worker_heartbeat event", () => {
    const event = createSupervisorLifecycleEvent("evt-003", "worker_heartbeat", {
      workerId: "w1",
    });
    expect(event.type).toBe("worker_heartbeat");
  });

  it("creates a worker_terminated event", () => {
    const event = createSupervisorLifecycleEvent(
      "evt-004",
      "worker_terminated",
      { workerId: "w1", reason: "completed" },
    );
    expect(event.type).toBe("worker_terminated");
  });
});

describe("validateLifecycleEvent", () => {
  it("accepts a valid event", () => {
    const event = createSupervisorLifecycleEvent("evt-001", "worker_heartbeat", {
      workerId: "w1",
    });
    const result = validateLifecycleEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null", () => {
    const result = validateLifecycleEvent(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing eventId", () => {
    const result = validateLifecycleEvent({
      type: "worker_heartbeat",
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
      type: "worker_heartbeat",
      payload: { workerId: "w1" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /timestamp/i.test(e))).toBe(true);
  });

  it("rejects worker_heartbeat without workerId in payload", () => {
    const result = validateLifecycleEvent({
      eventId: "evt-001",
      type: "worker_heartbeat",
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
  let paths: SupervisorPaths;
  let clockNow: string;

  beforeEach(() => {
    ports = createInMemorySupervisorPorts();
    paths = planSupervisorPaths("/test/project");
    clockNow = "2024-06-01T12:00:00.000Z";
  });

  it("appends and reads back a single event", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    const appendResult = await appendLifecycleEvent(
      ports,
      paths,
      event,
    );
    expect(appendResult.status).toBe("appended");

    const readResult = await readAllLifecycleEvents(ports, paths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.validEvents[0].eventId).toBe("evt-001");
    expect(readResult.parseErrors).toHaveLength(0);
  });

  it("appends and reads back multiple events round-trip", async () => {
    const events = [
      createSupervisorLifecycleEvent(
        "evt-001",
        "worker_registered",
        { workerId: "w1", role: "coder", workspace: "/w1", branch: "main", imChannel: "ch1" },
        clockNow,
      ),
      createSupervisorLifecycleEvent(
        "evt-002",
        "worker_status_changed",
        { workerId: "w1", status: "active", previousStatus: "idle" },
        clockNow,
      ),
      createSupervisorLifecycleEvent(
        "evt-003",
        "worker_heartbeat",
        { workerId: "w1" },
        clockNow,
      ),
    ];

    for (const event of events) {
      const result = await appendLifecycleEvent(ports, paths, event);
      expect(result.status).toBe("appended");
    }

    const readResult = await readAllLifecycleEvents(ports, paths);
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
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, paths, event);

    const event2 = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    const result = await appendLifecycleEvent(ports, paths, event2);
    expect(result.status).toBe("duplicate");
  });

  it("reads valid events alongside malformed lines", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, paths, event);

    // Write a malformed line directly into the file
    const eventsPath = paths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      (await ports.fs.readFile(eventsPath)) + "this is not json\n",
    );

    const readResult = await readAllLifecycleEvents(ports, paths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.validEvents[0].eventId).toBe("evt-001");
    expect(readResult.parseErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("skips empty lines in the JSONL file", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, paths, event);

    // Add empty lines
    const eventsPath = paths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      // Use the current content (appendLifecycleEvent writes valid JSONL)
      (await ports.fs.readFile(eventsPath)) + "\n\n",
    );

    const readResult = await readAllLifecycleEvents(ports, paths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.parseErrors).toHaveLength(0);
  });

  it("reports validation errors for events with wrong shape", async () => {
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, paths, event);

    // Write a line that parses as JSON but fails validation
    const eventsPath = paths.eventsFile;
    await ports.fs.writeFile(
      eventsPath,
      (await ports.fs.readFile(eventsPath)) +
        JSON.stringify({ eventId: "bad", type: "unknown", timestamp: "x", payload: {} }) + "\n",
    );

    const readResult = await readAllLifecycleEvents(ports, paths);
    expect(readResult.validEvents).toHaveLength(1);
    expect(readResult.parseErrors.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves idempotency across restarts by tracking event IDs in snapshot", async () => {
    // Append an event
    const event = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );
    await appendLifecycleEvent(ports, paths, event);

    // Simulate a restart: create new ports (but same in-memory store)
    // Since in-memory store persists across port creation, we need to
    // verify that duplicate rejection works via snapshot replay.
    // The snapshot tracks seen event IDs.
    const snapshot = createSupervisorSnapshot(
      { eventIds: ["evt-001"] },
      clockNow,
    );

    // Write the snapshot
    await ports.fs.writeFile(
      paths.snapshotFile,
      JSON.stringify(snapshot),
    );

    // Attempt append again - should be duplicate
    const event2 = createSupervisorLifecycleEvent(
      "evt-001",
      "worker_heartbeat",
      { workerId: "w1" },
      clockNow,
    );

    // Load snapshot first to seed seen event IDs
    const appendResult = await appendLifecycleEvent(
      ports,
      paths,
      event2,
      { loadSnapshot: true },
    );
    expect(appendResult.status).toBe("duplicate");
  });

  it("can read from an empty file (no events)", async () => {
    const readResult = await readAllLifecycleEvents(ports, paths);
    expect(readResult.validEvents).toHaveLength(0);
    expect(readResult.parseErrors).toHaveLength(0);
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
