import { describe, expect, it } from "vitest";
import {
  buildRuntimeRecoverySnapshot,
  createRuntimeProcess,
  markProcessCrashed,
  markProcessRunning,
  processExitedOrCrashedEvent,
  processHeartbeatEvent,
  processStartedEvent,
  capabilityLifecycleEvent,
} from "../src/runtime/index.js";

const NOW = "2026-06-11T00:00:00.000Z";

function planned(kind: "run" | "terminal-host", id: string) {
  return createRuntimeProcess({
    id,
    kind,
    owner: { scope: "project", projectId: "project-1" },
    command: { executable: "tiny-agent", args: [] },
    now: NOW,
  });
}

describe("runtime events", () => {
  it("builds process lifecycle events from explicit process records", () => {
    const running = markProcessRunning(planned("run", "proc-run"), {
      now: NOW,
      pid: 123,
    });

    expect(processStartedEvent({
      id: "event-1",
      timestamp: NOW,
      producer: "test",
    }, running)).toMatchObject({
      type: "process_started",
      process: {
        id: "proc-run",
        status: "running",
      },
    });

    expect(processHeartbeatEvent({
      id: "event-2",
      timestamp: NOW,
      producer: "test",
    }, running)).toMatchObject({
      type: "process_heartbeat",
      processId: "proc-run",
      pid: 123,
      kind: "run",
      heartbeatAt: NOW,
    });
  });

  it("rejects terminal process events without exit payloads", () => {
    expect(() =>
      processExitedOrCrashedEvent({
        id: "event-3",
        timestamp: NOW,
        producer: "test",
      }, planned("run", "proc-run")),
    ).toThrow(/no exit payload|not terminal/);

    const crashed = markProcessCrashed(planned("run", "proc-run"), {
      now: NOW,
      message: "boom",
    });
    expect(processExitedOrCrashedEvent({
      id: "event-4",
      timestamp: NOW,
      producer: "test",
    }, crashed)).toMatchObject({
      type: "process_crashed",
      processId: "proc-run",
      exit: {
        message: "boom",
      },
    });
  });

  it("records capability lifecycle facts", () => {
    expect(capabilityLifecycleEvent({
      id: "event-5",
      timestamp: NOW,
      producer: "test",
    }, {
      capability: "terminal-host",
      processId: "proc-terminal",
      status: "ready",
    })).toMatchObject({
      type: "capability_lifecycle",
      capability: "terminal-host",
      processId: "proc-terminal",
      status: "ready",
    });
  });
});

describe("runtime recovery snapshot", () => {
  it("projects process registry records into recovery state", () => {
    const running = markProcessRunning(planned("run", "proc-run"), {
      now: NOW,
      pid: 123,
    });
    const crashed = markProcessCrashed(planned("terminal-host", "proc-terminal"), {
      now: NOW,
      message: "lost heartbeat",
    });

    expect(buildRuntimeRecoverySnapshot({
      processes: [crashed, running],
      recoveredAt: "2026-06-11T00:00:01.000Z",
      eventOffset: 42,
    })).toMatchObject({
      schemaVersion: 1,
      totalProcesses: 2,
      processesByStatus: {
        running: 1,
        crashed: 1,
      },
      processesByKind: {
        run: 1,
        "terminal-host": 1,
      },
      activeProcessIds: ["proc-run"],
      terminalProcessIds: ["proc-terminal"],
      eventOffset: 42,
    });
  });

  it("ignores unsupported process records instead of adding unknown counters", () => {
    const current = markProcessRunning(planned("run", "proc-run"), {
      now: NOW,
      pid: 123,
    });
    const obsolete = {
      ...current,
      id: "project-runtime-host:project-1",
      kind: "project-runtime-host",
      owner: { scope: "project", projectId: "project-1" },
    };

    const snapshot = buildRuntimeRecoverySnapshot({
      processes: [obsolete as any, current],
      recoveredAt: "2026-06-11T00:00:01.000Z",
      eventOffset: 42,
    });

    expect(snapshot.totalProcesses).toBe(1);
    expect(snapshot.processesByKind).toMatchObject({ run: 1 });
    expect(snapshot.processesByKind).not.toHaveProperty("project-runtime-host");
    expect(snapshot.activeProcessIds).toEqual(["proc-run"]);
  });
});
