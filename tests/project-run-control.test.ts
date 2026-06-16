import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectRunControl } from "../src/runtime/project-run-control.js";
import {
  createRuntimeProcess,
  markProcessRunning,
  RunSupervisor,
  type ProcessSpawnerPort,
  type ProcessControlPort,
  type RuntimeProcessKind,
  type RuntimeProcessRecord,
  type SpawnedProcessPort,
} from "../src/runtime/index.js";

class MemoryProcessStore {
  private readonly records = new Map<string, RuntimeProcessRecord>();

  find(id: string): RuntimeProcessRecord | undefined {
    return this.records.get(id);
  }

  list(): RuntimeProcessRecord[] {
    return [...this.records.values()];
  }

  upsert(record: RuntimeProcessRecord): void {
    this.records.set(record.id, record);
  }
}

class FakeChild extends EventEmitter implements SpawnedProcessPort {
  pid = 4321;
  killed = false;
  unrefCalled = false;
  exitCode: number | null = null;
  stdout = null;
  stderr = null;
  killSignal: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

class FakeProcessControl implements ProcessControlPort {
  readonly livePids = new Set<number>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  constructor(livePids: readonly number[] = []) {
    for (const pid of livePids) {
      this.livePids.add(pid);
    }
  }

  isAlive(pid: number): boolean {
    return this.livePids.has(pid);
  }

  signal(pid: number, signal: NodeJS.Signals): boolean {
    this.signals.push({ pid, signal });
    return this.livePids.delete(pid);
  }
}

function makeStateRoot(): { baseDir: string; runsDir: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-run-control-"));
  const runsDir = path.join(baseDir, "runs");
  const runDir = path.join(runsDir, "run-123");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      runId: "run-123",
      status: "running",
      task: "test",
      cwd: "/repo",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      stepIndex: 0,
      transcriptPath: path.join(runDir, "transcript.jsonl"),
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(runsDir, "latest.json"),
    JSON.stringify({ runId: "run-123" }),
    "utf-8",
  );
  return { baseDir, runsDir };
}

function runningProcess(input: {
  id: string;
  kind: RuntimeProcessKind;
  runId: string;
  pid: number;
}): RuntimeProcessRecord {
  const planned = createRuntimeProcess({
    id: input.id,
    kind: input.kind,
    owner: { scope: "run", runId: input.runId },
    command: {
      executable: "node",
      args: ["tiny-agent", input.kind, input.runId],
    },
    now: "2026-06-11T00:00:00.000Z",
    metadata: { runId: input.runId },
  });
  return markProcessRunning(planned, {
    now: "2026-06-11T00:00:00.000Z",
    pid: input.pid,
  });
}

function projectOwnedProcessMentioningRun(input: {
  id: string;
  kind: RuntimeProcessKind;
  runId: string;
  pid: number;
}): RuntimeProcessRecord {
  const planned = createRuntimeProcess({
    id: input.id,
    kind: input.kind,
    owner: { scope: "project", projectId: "project-1" },
    command: {
      executable: "node",
      args: ["tiny-agent", input.kind, "--inspect-run", input.runId],
    },
    now: "2026-06-11T00:00:00.000Z",
  });
  return markProcessRunning(planned, {
    now: "2026-06-11T00:00:00.000Z",
    pid: input.pid,
  });
}

describe("createProjectRunControl", () => {
  it("returns alreadyRunning only for a live active run process", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    store.upsert(
      runningProcess({
        id: "live-run",
        kind: "run",
        runId: "run-123",
        pid: 111,
      }),
    );
    store.upsert(
      runningProcess({
        id: "stale-sibling-run",
        kind: "run",
        runId: "run-123",
        pid: 222,
      }),
    );
    let spawnCount = 0;
    const supervisor = new RunSupervisor({
      store,
      spawner: {
        spawn() {
          spawnCount++;
          return new FakeChild();
        },
      },
      nowIso: () => "2026-06-11T00:00:00.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:00.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:01.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:01.000Z"),
        processControl: new FakeProcessControl([111]),
        newProcessId: () => "ui-run-resume-1",
      });

      await expect(control.startRun({ runId: "run-123" })).resolves.toEqual({
        runId: "run-123",
        alreadyRunning: true,
      });
      expect(spawnCount).toBe(0);
      expect(store.find("live-run")?.status).toBe("running");
      expect(store.find("stale-sibling-run")?.status).toBe("crashed");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("marks stale run records, cleans run-owned hosts, and resumes", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    store.upsert(
      runningProcess({
        id: "stale-run",
        kind: "run",
        runId: "run-123",
        pid: 111,
      }),
    );
    store.upsert(
      runningProcess({
        id: "stale-terminal",
        kind: "terminal-host",
        runId: "run-123",
        pid: 222,
      }),
    );
    const processControl = new FakeProcessControl([222]);
    const child = new FakeChild();
    child.pid = 333;
    const supervisor = new RunSupervisor({
      store,
      spawner: {
        spawn() {
          return child;
        },
      },
      nowIso: () => "2026-06-11T00:00:02.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:02.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:03.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:03.000Z"),
        processControl,
        newProcessId: () => "ui-run-resume-1",
      });

      await expect(control.startRun({ runId: "run-123" })).resolves.toEqual({
        runId: "run-123",
      });
      expect(store.find("stale-run")?.status).toBe("crashed");
      expect(store.find("stale-terminal")?.status).toBe("exited");
      expect(processControl.signals).toEqual([
        { pid: 222, signal: "SIGTERM" },
      ]);
      expect(store.find("ui-run-resume-1")?.status).toBe("running");
      expect(store.find("ui-run-resume-1")?.owner).toEqual({
        scope: "run",
        runId: "run-123",
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("starts run detached and requests stop through process registry pid", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    const child = new FakeChild();
    const processControl = new FakeProcessControl([child.pid]);
    let spawnOptions: Parameters<ProcessSpawnerPort["spawn"]>[2] | undefined;
    const spawner: ProcessSpawnerPort = {
      spawn(_executable, _args, options) {
        spawnOptions = options;
        return child;
      },
    };
    const supervisor = new RunSupervisor({
      store,
      spawner,
      nowIso: () => "2026-06-11T00:00:00.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:00.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:01.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:01.000Z"),
        processControl,
        newProcessId: () => "ui-run-resume-1",
      });

      await control.startRun({ runId: "run-123" });
      const result = await control.stopRun({ runId: "run-123" });

      expect(result).toEqual({
        runId: "run-123",
        stopped: true,
        processId: "ui-run-resume-1",
      });
      expect(spawnOptions).toMatchObject({
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      expect(child.unrefCalled).toBe(true);
      expect(child.killed).toBe(false);
      expect(child.killSignal).toBeUndefined();
      expect(processControl.signals).toEqual([
        { pid: child.pid, signal: "SIGTERM" },
      ]);
      expect(store.find("ui-run-resume-1")?.status).toBe("stopping");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("cleans stale run-owned hosts when stopping a dead run record", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    store.upsert(
      runningProcess({
        id: "dead-run",
        kind: "run",
        runId: "run-123",
        pid: 111,
      }),
    );
    store.upsert(
      runningProcess({
        id: "orphan-terminal",
        kind: "terminal-host",
        runId: "run-123",
        pid: 222,
      }),
    );
    const processControl = new FakeProcessControl([222]);
    const supervisor = new RunSupervisor({
      store,
      spawner: {
        spawn() {
          return new FakeChild();
        },
      },
      nowIso: () => "2026-06-11T00:00:00.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:00.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:01.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:01.000Z"),
        processControl,
      });

      await expect(control.stopRun({ runId: "run-123" })).resolves.toEqual({
        runId: "run-123",
        stopped: true,
        processId: "dead-run",
      });
      expect(store.find("dead-run")?.status).toBe("crashed");
      expect(store.find("orphan-terminal")?.status).toBe("exited");
      expect(processControl.signals).toEqual([
        { pid: 222, signal: "SIGTERM" },
      ]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not clean project-owned processes that merely mention the run id", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    store.upsert(
      runningProcess({
        id: "dead-run",
        kind: "run",
        runId: "run-123",
        pid: 111,
      }),
    );
    store.upsert(
      runningProcess({
        id: "orphan-terminal",
        kind: "terminal-host",
        runId: "run-123",
        pid: 222,
      }),
    );
    store.upsert(
      projectOwnedProcessMentioningRun({
        id: "project-runtime-observer",
        kind: "runtime-replica",
        runId: "run-123",
        pid: 333,
      }),
    );
    const processControl = new FakeProcessControl([222, 333]);
    const supervisor = new RunSupervisor({
      store,
      spawner: {
        spawn() {
          return new FakeChild();
        },
      },
      nowIso: () => "2026-06-11T00:00:00.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:00.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:01.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:01.000Z"),
        processControl,
      });

      await expect(control.stopRun({ runId: "run-123" })).resolves.toEqual({
        runId: "run-123",
        stopped: true,
        processId: "dead-run",
      });
      expect(store.find("dead-run")?.status).toBe("crashed");
      expect(store.find("orphan-terminal")?.status).toBe("exited");
      expect(store.find("project-runtime-observer")?.status).toBe("running");
      expect(processControl.signals).toEqual([
        { pid: 222, signal: "SIGTERM" },
      ]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports not-running when a run has no active process record", async () => {
    const { baseDir, runsDir } = makeStateRoot();
    const store = new MemoryProcessStore();
    const supervisor = new RunSupervisor({
      store,
      spawner: {
        spawn() {
          return new FakeChild();
        },
      },
      nowIso: () => "2026-06-11T00:00:00.000Z",
      nowEpochMs: () => Date.parse("2026-06-11T00:00:00.000Z"),
    });
    try {
      const control = createProjectRunControl({
        stateDir: baseDir,
        runsDir,
        projectId: "project-1",
        supervisor,
        processStore: store,
        executable: "node",
        execArgv: [],
        mainScript: "dist/cli/main.js",
        cwd: "/repo",
        env: {},
        nowIso: () => "2026-06-11T00:00:01.000Z",
        nowEpochMs: () => Date.parse("2026-06-11T00:00:01.000Z"),
        processControl: new FakeProcessControl(),
      });

      await expect(control.stopRun({ runId: "latest" })).resolves.toEqual({
        runId: "run-123",
        stopped: false,
        reason: "not-running",
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
