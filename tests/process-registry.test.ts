import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonProcessRegistryStore,
  classifyProcessFreshness,
  createRunProcessRecord,
  createRuntimeProcess,
  migrateRuntimeProcessSnapshot,
  markProcessCrashed,
  markProcessExited,
  markProcessRunning,
  markProcessStarting,
  markRunProcessRunning,
  recordProcessHeartbeat,
  runProcessId,
  type RuntimeProcessRecord,
  type RuntimeProcessSnapshot,
} from "../src/runtime/index.js";

const NOW = "2026-06-11T00:00:00.000Z";
const LATER = "2026-06-11T00:00:10.000Z";

function makeProcess() {
  return createRuntimeProcess({
    id: "proc-terminal-host",
    kind: "terminal-host",
    owner: { scope: "run", runId: "run-1" },
    command: {
      executable: "tiny-agent",
      args: ["terminal-host", "--run-id", "run-1"],
      cwd: "/repo",
      envKeys: ["TAH_STATE_DIR"],
    },
    now: NOW,
    statePath: "/state/processes.json",
    logPath: "/state/terminal-host.log",
  });
}

describe("process registry transitions", () => {
  it("creates planned process records from explicit input", () => {
    const process = makeProcess();

    expect(process).toMatchObject({
      schemaVersion: 1,
      id: "proc-terminal-host",
      kind: "terminal-host",
      status: "planned",
      createdAt: NOW,
      updatedAt: NOW,
      owner: { scope: "run", runId: "run-1" },
    });
    expect(process.command.args).toEqual([
      "terminal-host",
      "--run-id",
      "run-1",
    ]);
  });

  it("moves planned processes through starting, running, heartbeat, and exited", () => {
    const starting = markProcessStarting(makeProcess(), {
      now: "2026-06-11T00:00:01.000Z",
      pid: 101,
    });
    const running = markProcessRunning(starting, {
      now: "2026-06-11T00:00:02.000Z",
      pid: 101,
    });
    const heartbeat = recordProcessHeartbeat(running, { now: LATER });
    const exited = markProcessExited(heartbeat, {
      now: "2026-06-11T00:00:11.000Z",
      exitCode: 0,
    });

    expect(exited.status).toBe("exited");
    expect(exited.pid).toBe(101);
    expect(exited.startedAt).toBe("2026-06-11T00:00:02.000Z");
    expect(exited.lastHeartbeatAt).toBe(LATER);
    expect(exited.exit).toEqual({
      exitedAt: "2026-06-11T00:00:11.000Z",
      exitCode: 0,
      signal: null,
    });
  });

  it("rejects invalid transitions from terminal states", () => {
    const crashed = markProcessCrashed(makeProcess(), {
      now: LATER,
      message: "spawn failed",
    });

    expect(() =>
      markProcessRunning(crashed, {
        now: "2026-06-11T00:00:11.000Z",
        pid: 1,
      }),
    ).toThrow(/already crashed/);
  });

  it("classifies heartbeat freshness from explicit clock input", () => {
    const running = markProcessRunning(makeProcess(), {
      now: "2026-06-11T00:00:00.000Z",
      pid: 101,
    });

    expect(
      classifyProcessFreshness({
        process: running,
        nowEpochMs: Date.parse("2026-06-11T00:00:04.000Z"),
        staleAfterMs: 5000,
      }),
    ).toEqual({ status: "fresh", ageMs: 4000 });

    expect(
      classifyProcessFreshness({
        process: running,
        nowEpochMs: Date.parse("2026-06-11T00:00:06.000Z"),
        staleAfterMs: 5000,
      }),
    ).toEqual({ status: "stale", ageMs: 6000 });
  });

  it("migrates unsupported durable process records out of the current snapshot", () => {
    const current = makeProcess();
    const obsolete = {
      ...current,
      id: "project-runtime-host:project-1",
      kind: "project-runtime-host",
      owner: { scope: "project", projectId: "project-1" },
      status: "running",
    } as unknown as RuntimeProcessRecord;
    const invalidStatus = {
      ...current,
      id: "runtime-replica:bad-status",
      kind: "runtime-replica",
      status: "paused",
    } as unknown as RuntimeProcessRecord;
    const snapshot: RuntimeProcessSnapshot = {
      schemaVersion: 1,
      version: 7,
      updatedAt: NOW,
      processes: [obsolete, current, invalidStatus],
    };

    const migration = migrateRuntimeProcessSnapshot({
      snapshot,
      now: LATER,
    });

    expect(migration).toMatchObject({
      changed: true,
      droppedProcessIds: [
        "project-runtime-host:project-1",
        "runtime-replica:bad-status",
      ],
      snapshot: {
        version: 8,
        updatedAt: LATER,
      },
    });
    expect(migration.snapshot.processes).toEqual([current]);
  });
});

describe("run process helpers", () => {
  it("creates direct run process records through the shared run helper", () => {
    const record = createRunProcessRecord({
      runId: "run-1",
      owner: { scope: "run", runId: "run-1" },
      command: {
        executable: "tiny-agent",
        args: ["run", "--resume", "run-1"],
        cwd: "/repo",
      },
      now: NOW,
      statePath: "/state/runs/run-1/state.json",
      metadata: { source: "cli" },
    });

    expect(record).toMatchObject({
      id: "run:run-1",
      kind: "run",
      owner: { scope: "run", runId: "run-1" },
      status: "planned",
      command: {
        executable: "tiny-agent",
        args: ["run", "--resume", "run-1"],
        cwd: "/repo",
      },
      statePath: "/state/runs/run-1/state.json",
      metadata: { source: "cli" },
    });
  });

  it("creates team-member-owned run process records without a worker-specific kind", () => {
    const owner = {
      scope: "team-member" as const,
      teamId: "team-main",
      memberId: "coder-1",
      runId: "run-worker",
    };
    const record = markRunProcessRunning({
      runId: "run-worker",
      owner,
      command: {
        executable: "tiny-agent",
        args: ["run", "--task", "fix tests"],
        cwd: "/repo-worker",
      },
      now: NOW,
      pid: 4242,
      startedAt: LATER,
      metadata: { assignmentId: "A-001" },
    });

    expect(runProcessId({ runId: "run-worker", owner })).toBe(
      "team-member-run:team-main:coder-1:run-worker",
    );
    expect(record).toMatchObject({
      id: "team-member-run:team-main:coder-1:run-worker",
      kind: "run",
      owner,
      status: "running",
      pid: 4242,
      metadata: { assignmentId: "A-001" },
    });
  });

  it("rejects mismatched run owner ids", () => {
    expect(() =>
      runProcessId({
        runId: "run-actual",
        owner: { scope: "run", runId: "run-other" },
      }),
    ).toThrow(/does not match/);
  });
});

describe("JsonProcessRegistryStore", () => {
  it("persists process snapshots through an injected clock boundary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-store-"));
    try {
      const store = new JsonProcessRegistryStore({
        filePath: path.join(tmpDir, "processes.json"),
        nowIso: () => LATER,
      });

      const snapshot = store.upsert(makeProcess());

      expect(snapshot.version).toBe(2);
      expect(snapshot.updatedAt).toBe(LATER);
      expect(store.find("proc-terminal-host")?.kind).toBe("terminal-host");

      const raw = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "processes.json"), "utf-8"),
      );
      expect(raw.processes).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists a one-shot migration that removes unsupported durable process records", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-store-migration-"));
    const filePath = path.join(tmpDir, "processes.json");
    try {
      const current = makeProcess();
      const obsolete = {
        ...current,
        id: "project-runtime-host:project-1",
        kind: "project-runtime-host",
        owner: { scope: "project", projectId: "project-1" },
      };
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          version: 3,
          updatedAt: NOW,
          processes: [obsolete, current],
        }, null, 2),
        "utf-8",
      );

      const store = new JsonProcessRegistryStore({
        filePath,
        nowIso: () => LATER,
      });

      const loaded = store.load();
      expect(loaded.version).toBe(4);
      expect(loaded.updatedAt).toBe(LATER);
      expect(loaded.processes).toHaveLength(1);
      expect(loaded.processes[0]).toMatchObject({
        id: current.id,
        kind: current.kind,
      });
      const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(persisted).toMatchObject({
        version: 4,
        updatedAt: LATER,
      });
      expect(persisted.processes).toHaveLength(1);
      expect(persisted.processes[0]).toMatchObject({
        id: current.id,
        kind: current.kind,
      });
      expect(store.find("project-runtime-host:project-1")).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
