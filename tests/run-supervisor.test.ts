import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  JsonProcessRegistryStore,
  RunSupervisor,
  markProcessRunning,
  createRuntimeProcess,
  type RuntimeEvent,
  type ProcessSpawnerPort,
  type SpawnedProcessPort,
} from "../src/runtime/index.js";

class MemoryProcessStore {
  private readonly records = new Map<string, ReturnType<typeof createRuntimeProcess>>();

  find(id: string) {
    return this.records.get(id);
  }

  list() {
    return [...this.records.values()];
  }

  upsert(record: ReturnType<typeof createRuntimeProcess>) {
    this.records.set(record.id, record);
    return {
      schemaVersion: 1 as const,
      version: this.records.size,
      updatedAt: record.updatedAt,
      processes: this.list(),
    };
  }
}

class FakeChild extends EventEmitter implements SpawnedProcessPort {
  pid = 1234;
  killed = false;
  exitCode: number | null = null;
  stdout = null;
  stderr = null;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

function makeSupervisor(options?: {
  now?: () => string;
  nowMs?: () => number;
  child?: FakeChild;
  events?: RuntimeEvent[];
}) {
  const store = new MemoryProcessStore();
  const child = options?.child ?? new FakeChild();
  const spawner: ProcessSpawnerPort = {
    spawn() {
      return child;
    },
  };
  const supervisor = new RunSupervisor({
    store,
    spawner,
    nowIso: options?.now ?? (() => "2026-06-11T00:00:00.000Z"),
    nowEpochMs:
      options?.nowMs ?? (() => Date.parse("2026-06-11T00:00:00.000Z")),
    events: options?.events
      ? {
          append(event) {
            options.events!.push(event);
          },
        }
      : undefined,
    newEventId: (() => {
      let sequence = 0;
      return () => `event-${++sequence}`;
    })(),
    eventProducer: "test-supervisor",
  });
  return { supervisor, store, child };
}

describe("RunSupervisor", () => {
  it("records started run process state through the process registry", () => {
    const { supervisor, store } = makeSupervisor();

    const started = supervisor.startRunProcess({
      processId: "proc-run",
      owner: { scope: "project", projectId: "proj-1" },
      executable: "node",
      args: ["dist/cli/main.js", "run"],
      cwd: "/repo",
      env: { TAH_STATE_DIR: "/state" },
      logPath: "/state/launcher/run.log",
    });

    expect(started.process).toMatchObject({
      id: "proc-run",
      kind: "run",
      status: "running",
      pid: 1234,
      logPath: "/state/launcher/run.log",
    });
    expect(store.find("proc-run")?.status).toBe("running");
  });

  it("attaches the concrete run id after launcher observes latest run", () => {
    const { supervisor, store } = makeSupervisor();
    supervisor.startRunProcess({
      processId: "proc-run",
      owner: { scope: "project", projectId: "proj-1" },
      executable: "node",
      args: ["dist/cli/main.js", "run"],
      cwd: "/repo",
      env: {},
    });

    const attached = supervisor.attachRunId({
      processId: "proc-run",
      runId: "run-123",
      runDir: "/state/runs/run-123",
    });

    expect(attached.owner).toEqual({ scope: "run", runId: "run-123" });
    expect(attached.statePath).toBe("/state/runs/run-123");
    expect(store.find("proc-run")?.metadata).toMatchObject({ runId: "run-123" });
  });

  it("updates process state when the child exits", () => {
    const child = new FakeChild();
    const { supervisor, store } = makeSupervisor({ child });
    supervisor.startRunProcess({
      processId: "proc-run",
      owner: { scope: "project", projectId: "proj-1" },
      executable: "node",
      args: [],
      cwd: "/repo",
      env: {},
    });

    child.emitExit(1, null);

    expect(store.find("proc-run")).toMatchObject({
      status: "crashed",
      exit: {
        exitCode: 1,
        signal: null,
      },
    });
  });

  it("emits runtime lifecycle events when an event sink is provided", () => {
    const child = new FakeChild();
    const events: RuntimeEvent[] = [];
    const { supervisor } = makeSupervisor({ child, events });
    supervisor.startRunProcess({
      processId: "proc-run",
      owner: { scope: "run", runId: "run-1" },
      executable: "node",
      args: [],
      cwd: "/repo",
      env: {},
    });
    supervisor.heartbeat("proc-run");
    child.emitExit(0, null);

    expect(events.map((event) => event.type)).toEqual([
      "process_planned",
      "process_started",
      "process_heartbeat",
      "process_exited",
    ]);
    expect(events[0]).toMatchObject({
      producer: "test-supervisor",
      runId: "run-1",
      correlationId: "proc-run",
    });
  });

  it("heartbeats and reaps stale process records from explicit clocks", () => {
    let now = "2026-06-11T00:00:00.000Z";
    const { supervisor, store } = makeSupervisor({
      now: () => now,
      nowMs: () => Date.parse(now),
    });
    supervisor.startRunProcess({
      processId: "proc-run",
      owner: { scope: "project", projectId: "proj-1" },
      executable: "node",
      args: [],
      cwd: "/repo",
      env: {},
    });
    now = "2026-06-11T00:00:04.000Z";
    supervisor.heartbeat("proc-run");
    expect(store.find("proc-run")?.lastHeartbeatAt).toBe(now);

    now = "2026-06-11T00:00:10.000Z";
    const reaped = supervisor.reapStale({ staleAfterMs: 5_000 });

    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({
      id: "proc-run",
      status: "crashed",
    });
  });
});
