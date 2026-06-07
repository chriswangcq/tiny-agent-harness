import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTeam } from "../src/cli/team-run.js";
import {
  applyContactRegistryEvent,
  createContactRegistryState,
  type ContactRegistryState,
  type WorkerContact,
} from "../src/subagent/contact-registry.js";
import {
  createTeamDirectorySnapshot,
  planRunScopedTeamPaths,
} from "../src/subagent/directory-store.js";
import {
  createLifecycleCliAdapterPorts,
  executeLifecycleAdapterCommand,
  type LifecycleAdapterFsPort,
} from "../src/subagent/lifecycle-cli-adapter.js";
import {
  planRunScopedSupervisorPaths,
  type SupervisorLifecycleEvent,
} from "../src/subagent/supervisor-store.js";

const NOW = "2026-06-07T12:00:00.000Z";
const LATER = "2026-06-07T12:01:00.000Z";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tah-lifecycle-adapter-"));
  tmpRoots.push(root);
  return root;
}

function makeWorker(overrides: Partial<WorkerContact> = {}): WorkerContact {
  return {
    workerId: "worker-1",
    role: "coder",
    workspace: "/tmp/worker-1",
    branch: "codex/p6/worker-1",
    imChannel: "worker-1",
    allowedActions: ["code"],
    status: "active",
    ...overrides,
  };
}

function registryWithWorkers(workers: WorkerContact[]): ContactRegistryState {
  let state = createContactRegistryState("registry-test");
  for (const worker of workers) {
    const registered = applyContactRegistryEvent(state, {
      kind: "worker_registered",
      eventId: `reg-${worker.workerId}`,
      workerId: worker.workerId,
      role: worker.role,
      workspace: worker.workspace,
      branch: worker.branch,
      imChannel: worker.imChannel,
      allowedActions: worker.allowedActions,
    });
    state = registered.state;

    if (worker.status !== "idle") {
      state = applyContactRegistryEvent(state, {
        kind: "worker_status_changed",
        eventId: `status-${worker.workerId}`,
        workerId: worker.workerId,
        status: worker.status,
      }).state;
    }

    if (worker.lastHeartbeat) {
      state = applyContactRegistryEvent(state, {
        kind: "worker_heartbeat",
        eventId: `heartbeat-${worker.workerId}`,
        workerId: worker.workerId,
        timestamp: worker.lastHeartbeat,
      }).state;
    }
  }
  return state;
}

async function writeRunRegistry(
  projectRoot: string,
  runId: string,
  workers: WorkerContact[],
): Promise<void> {
  const paths = planRunScopedTeamPaths(projectRoot, runId);
  await fsPort.mkdir(paths.runTeamDir);
  const state = registryWithWorkers(workers);
  const snapshot = createTeamDirectorySnapshot(state, NOW);
  await fsPort.writeFile(paths.runRegistryFile, JSON.stringify(snapshot, null, 2));
}

async function writeWorkerState(
  projectRoot: string,
  runId: string,
  workerId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const workerDir = path.join(
    projectRoot,
    ".tiny-agent",
    "runs",
    runId,
    "workers",
    workerId,
  );
  await fsPort.mkdir(workerDir);
  await fsPort.writeFile(
    path.join(workerDir, "state.json"),
    JSON.stringify(state, null, 2),
  );
}

async function readLifecycleEvents(
  projectRoot: string,
  runId: string,
): Promise<SupervisorLifecycleEvent[]> {
  const paths = planRunScopedSupervisorPaths(projectRoot, runId);
  const raw = await readFile(paths.eventsFile, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SupervisorLifecycleEvent);
}

async function readRegistrySnapshot(
  projectRoot: string,
  runId: string,
): Promise<{ registry: ContactRegistryState }> {
  const paths = planRunScopedTeamPaths(projectRoot, runId);
  return JSON.parse(await readFile(paths.runRegistryFile, "utf-8"));
}

const fsPort: LifecycleAdapterFsPort = {
  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf-8");
  },
  async writeFile(filePath: string, data: string): Promise<void> {
    await writeFile(filePath, data, "utf-8");
  },
  async mkdir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  },
  async exists(filePath: string): Promise<boolean> {
    try {
      await readFile(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

function makePorts(shutdownCalls: Array<{ pid: number; workerId: string }> = []) {
  return createLifecycleCliAdapterPorts({
    fs: fsPort,
    nowIso: () => NOW,
    newEventId: (prefix, seed) => `${prefix}-${seed}-${shutdownCalls.length}`,
    shutdownProcess: async (pid, workerId) => {
      shutdownCalls.push({ pid, workerId });
    },
    listRunIds: async () => ["run-1"],
  });
}

describe("lifecycle CLI adapter", () => {
  it("records heartbeat and lease into run-scoped supervisor events", async () => {
    const projectRoot = await makeProject();
    await writeRunRegistry(projectRoot, "run-1", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1", "--run", "run-1", "--expiry-ms", "60000"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("lease");
    expect(result.runId).toBe("run-1");

    const events = await readLifecycleEvents(projectRoot, "run-1");
    expect(events.map((event) => event.type)).toEqual([
      "heartbeat_recorded",
      "lease_acquired",
    ]);

    const registry = await readRegistrySnapshot(projectRoot, "run-1");
    expect(registry.registry.workers["worker-1"]?.lastHeartbeat).toBe(NOW);
  });

  it("derives the latest run when run id is omitted", async () => {
    const projectRoot = await makeProject();
    await writeRunRegistry(projectRoot, "run-1", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.runId).toBe("run-1");

    const events = await readLifecycleEvents(projectRoot, "run-1");
    expect(events.map((event) => event.type)).toEqual([
      "heartbeat_recorded",
      "lease_acquired",
    ]);
  });

  it("reaper dry-run enumerates stale run-scoped workers without shutdown", async () => {
    const projectRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeRunRegistry(projectRoot, "run-1", [
      makeWorker({ workerId: "fresh", lastHeartbeat: LATER }),
      makeWorker({ workerId: "stale", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["reaper", "--run", "run-1"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("reaper");
    expect(result.envelope).toMatchObject({
      dryRun: true,
      executed: false,
      staleCount: 1,
    });
    expect(shutdownCalls).toEqual([]);
  });

  it("reaper execute reads worker pid state and appends shutdown audit events", async () => {
    const projectRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeRunRegistry(projectRoot, "run-1", [
      makeWorker({ workerId: "stale", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    await writeWorkerState(projectRoot, "run-1", "stale", { pid: 12345 });

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["reaper", "--run", "run-1", "--execute"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(true);
    expect(shutdownCalls).toEqual([{ pid: 12345, workerId: "stale" }]);

    const eventTypes = (await readLifecycleEvents(projectRoot, "run-1")).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("reaper_planned");
    expect(eventTypes).toContain("shutdown_requested");
    expect(eventTypes).toContain("shutdown_completed");
    expect(eventTypes).toContain("reaper_executed");
  });

  it("shutdown execute reports missing pid as structured failure", async () => {
    const projectRoot = await makeProject();
    await writeRunRegistry(projectRoot, "run-1", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["shutdown", "worker-1", "--run", "run-1", "--execute"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("SHUTDOWN_FAILED");
    expect(result.error).toContain("Missing worker pid");

    const eventTypes = (await readLifecycleEvents(projectRoot, "run-1")).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("shutdown_requested");
    expect(eventTypes).toContain("shutdown_failed");
  });

  it("team-run lifecycle branch reads run-scoped registry instead of empty state", async () => {
    const projectRoot = await makeProject();
    await writeRunRegistry(projectRoot, "run-1", [makeWorker()]);
    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write;
    const writes: string[] = [];

    process.chdir(projectRoot);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runTeam(["lifecycle", "lease", "worker-1", "--run", "run-1"]);
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }

    const output = JSON.parse(writes.join(""));
    expect(output.ok).toBe(true);
    expect(output.command).toBe("lease");
    expect(output.workerId).toBe("worker-1");
  });

  it("returns a usage envelope for missing flag values", async () => {
    const projectRoot = await makeProject();

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1", "--run"],
      { projectRoot, cwd: projectRoot },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("USAGE");
    expect(result.error).toContain("Missing value for --run");
  });
});
