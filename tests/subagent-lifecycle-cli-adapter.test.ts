import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTeam } from "../src/cli/team-run.js";
import {
  applyTeamRosterEvent,
  createTeamRosterState,
  type TeamRosterState,
  type TeamMember,
} from "../src/subagent/team-roster.js";
import {
  createTeamDirectorySnapshot,
  planTeamScopedDirectoryLayout,
} from "../src/subagent/directory-store.js";
import {
  createLifecycleCliAdapterPorts,
  executeLifecycleAdapterCommand,
  LIFECYCLE_HELP,
  type LifecycleAdapterFsPort,
} from "../src/subagent/lifecycle-cli-adapter.js";
import {
  planTeamScopedSupervisorPaths,
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

function makeWorker(
  overrides: Partial<TeamMember> & { workerId?: string } = {},
): TeamMember {
  const memberId = overrides.memberId ?? overrides.workerId ?? "worker-1";
  const { workerId: _workerId, memberId: _memberId, ...rest } = overrides;
  return {
    memberId,
    role: "coder",
    channel: "worker-1",
    metadata: {
      workspace: "/tmp/worker-1",
      branch: "codex/p6/worker-1",
      allowedActions: "code",
    },
    status: "active",
    ...rest,
  };
}

function rosterWithWorkers(workers: TeamMember[]): TeamRosterState {
  let state = createTeamRosterState("team-test");
  for (const worker of workers) {
    const registered = applyTeamRosterEvent(state, {
      kind: "member_added",
      eventId: `reg-${worker.memberId}`,
      memberId: worker.memberId,
      role: worker.role,
      channel: worker.channel,
      metadata: worker.metadata,
    });
    state = registered.state;

    if (worker.status !== "idle") {
      state = applyTeamRosterEvent(state, {
        kind: "member_status_changed",
        eventId: `status-${worker.memberId}`,
        memberId: worker.memberId,
        status: worker.status,
      }).state;
    }

    if (worker.lastHeartbeat) {
      state = applyTeamRosterEvent(state, {
        kind: "member_heartbeat",
        eventId: `heartbeat-${worker.memberId}`,
        memberId: worker.memberId,
        timestamp: worker.lastHeartbeat,
      }).state;
    }
  }
  return state;
}

async function writeTeamRoster(
  stateRoot: string,
  teamId: string,
  workers: TeamMember[],
): Promise<void> {
  const paths = planTeamScopedDirectoryLayout(stateRoot, teamId);
  await fsPort.mkdir(paths.teamDir);
  const state = rosterWithWorkers(workers);
  const snapshot = createTeamDirectorySnapshot(
    state,
    NOW,
  );
  await fsPort.writeFile(paths.stateFile, JSON.stringify(snapshot, null, 2));
}

async function writeWorkerState(
  stateRoot: string,
  teamId: string,
  memberId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const workerDir = path.join(
    stateRoot,
    "teams",
    teamId,
    "members",
    memberId,
  );
  await fsPort.mkdir(workerDir);
  await fsPort.writeFile(
    path.join(workerDir, "state.json"),
    JSON.stringify(state, null, 2),
  );
}
async function readWorkerState(
  stateRoot: string,
  teamId: string,
  memberId: string,
): Promise<Record<string, unknown>> {
  const workerDir = path.join(
    stateRoot,
    "teams",
    teamId,
    "members",
    memberId,
  );
  const raw = await readFile(path.join(workerDir, "state.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readLifecycleEvents(
  stateRoot: string,
  teamId: string,
): Promise<SupervisorLifecycleEvent[]> {
  const paths = planTeamScopedSupervisorPaths(stateRoot, teamId);
  const raw = await readFile(paths.eventsFile, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SupervisorLifecycleEvent);
}

async function readRosterSnapshot(
  stateRoot: string,
  teamId: string,
): Promise<{ roster: TeamRosterState }> {
  const paths = planTeamScopedDirectoryLayout(stateRoot, teamId);
  return JSON.parse(await readFile(paths.stateFile, "utf-8"));
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
  });
}

describe("lifecycle CLI adapter", () => {
  it("returns lifecycle help for --help without touching runtime state", async () => {
    const stateRoot = await makeProject();

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["--help"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: "USAGE",
      details: { helpText: LIFECYCLE_HELP },
    });
    expect(LIFECYCLE_HELP).toContain("lifecycle-status");
    expect(LIFECYCLE_HELP).toContain("lease");
    expect(LIFECYCLE_HELP).toContain("reaper");
    expect(LIFECYCLE_HELP).toContain("shutdown");
  });

  it("records heartbeat and lease into team-scoped supervisor events", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1", "--team", "team-test", "--run", "run-1", "--expiry-ms", "60000"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("lease");
    expect(result.teamId).toBe("team-test");

    const events = await readLifecycleEvents(stateRoot, "team-test");
    expect(events.map((event) => event.type)).toEqual([
      "heartbeat_recorded",
      "lease_acquired",
    ]);

    const roster = await readRosterSnapshot(stateRoot, "team-test");
    expect(roster.roster.members["worker-1"]?.lastHeartbeat).toBe(NOW);
  });

  it("records lease when run id is omitted", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1", "--team", "team-test"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.teamId).toBe("team-test");

    const events = await readLifecycleEvents(stateRoot, "team-test");
    expect(events.map((event) => event.type)).toEqual([
      "heartbeat_recorded",
      "lease_acquired",
    ]);
  });

  it("reaper dry-run enumerates stale team-scoped workers without shutdown", async () => {
    const stateRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "fresh", lastHeartbeat: LATER }),
      makeWorker({ workerId: "stale", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["reaper", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
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
    const stateRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "stale", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    await writeWorkerState(stateRoot, "team-test", "stale", { pid: 12345 });

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["reaper", "--team", "team-test", "--run", "run-1", "--execute"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(shutdownCalls).toEqual([{ pid: 12345, workerId: "stale" }]);

    const eventTypes = (await readLifecycleEvents(stateRoot, "team-test")).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("reaper_planned");
    expect(eventTypes).toContain("shutdown_requested");
    expect(eventTypes).toContain("shutdown_completed");
    expect(eventTypes).toContain("reaper_executed");

    // Verify terminal state was written after shutdown
    const workerState = await readWorkerState(stateRoot, "team-test", "stale");
    expect(workerState.status).toBe("terminated");
    expect(workerState.endedAt).toBe(NOW);
    expect(workerState.exitSignal).toBe("SIGTERM");
    expect(workerState.pid).toBe(12345);
  });

  it("shutdown execute reports missing pid as structured failure", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [makeWorker()]);

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["shutdown", "worker-1", "--team", "team-test", "--run", "run-1", "--execute"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("SHUTDOWN_FAILED");
    expect(result.error).toContain("Missing worker pid");

    const eventTypes = (await readLifecycleEvents(stateRoot, "team-test")).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("shutdown_requested");
    expect(eventTypes).toContain("shutdown_failed");
  });

  it("shutdown execute skips terminal worker state and does not call shutdownProcess", async () => {
    const stateRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeTeamRoster(stateRoot, "team-test", [makeWorker()]);
    // Write worker state with a terminal status that should be skipped
    await writeWorkerState(stateRoot, "team-test", "worker-1", {
      pid: 12345,
      status: "terminated",
      endedAt: "2026-06-07T11:00:00.000Z",
      exitSignal: "SIGTERM",
    });

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["shutdown", "worker-1", "--team", "team-test", "--run", "run-1", "--execute"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("SHUTDOWN_FAILED");
    expect(result.error).toContain("Missing worker pid");
    expect(shutdownCalls).toEqual([]);

    const eventTypes = (await readLifecycleEvents(stateRoot, "team-test")).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("shutdown_requested");
    expect(eventTypes).toContain("shutdown_failed");
  });

  it("team-run lifecycle branch reads explicit team-scoped roster", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [makeWorker()]);
    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write;
    const originalProjectStateDir = process.env.TAH_PROJECT_STATE_DIR;
    const writes: string[] = [];

    process.chdir(stateRoot);
    process.env.TAH_PROJECT_STATE_DIR = stateRoot;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runTeam(["lifecycle", "lease", "worker-1", "--team", "team-test", "--run", "run-1"]);
    } finally {
      process.stdout.write = originalWrite;
      if (originalProjectStateDir === undefined) {
        delete process.env.TAH_PROJECT_STATE_DIR;
      } else {
        process.env.TAH_PROJECT_STATE_DIR = originalProjectStateDir;
      }
      process.chdir(originalCwd);
    }

    const output = JSON.parse(writes.join(""));
    expect(output.ok).toBe(true);
    expect(output.command).toBe("lease");
    expect(output.workerId).toBe("worker-1");
  });

  it("team-run lifecycle help returns lifecycle help envelope", async () => {
    const originalWrite = process.stdout.write;
    const writes: string[] = [];

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runTeam(["lifecycle", "--help"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(writes.join(""));
    expect(output).toMatchObject({
      ok: false,
      errorCode: "USAGE",
      details: { helpText: LIFECYCLE_HELP },
    });
  });

  it("returns a usage envelope for missing flag values", async () => {
    const stateRoot = await makeProject();

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lease", "worker-1", "--run"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("USAGE");
    expect(result.error).toContain("Missing value for --run");
  });

  it("lifecycle-status surfaces missing_process via processExistence false for terminal-state worker", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "term", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    // Write terminal worker state
    await writeWorkerState(stateRoot, "team-test", "term", {
      pid: 99999,
      status: "exited",
      endedAt: "2026-06-07T11:00:00.000Z",
    });

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lifecycle-status", "term", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("lifecycle-status");
    expect(result.fact.lifecycleState).toBe("missing_process");
    expect(result.fact.riskFlags).toContain("missing_process");
  });

  it("lifecycle-status surfaces missing_process via injected checkProcessExists returning false", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "gone", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    await writeWorkerState(stateRoot, "team-test", "gone", {
      pid: 12345,
      status: "running",
    });

    let checkCalled: Array<{ pid: number; workerId: string }> = [];
    const ports = createLifecycleCliAdapterPorts({
      fs: fsPort,
      nowIso: () => NOW,
      newEventId: (prefix: string, seed: string) => `${prefix}-${seed}-gone`,
      shutdownProcess: async () => {},
      checkProcessExists: async (input: { pid: number; memberId: string }) => {
        checkCalled.push({ pid: input.pid, workerId: input.memberId });
        return false;
      },
    });

    const result = await executeLifecycleAdapterCommand(
      ports,
      ["lifecycle-status", "gone", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(checkCalled).toEqual([{ pid: 12345, workerId: "gone" }]);
    expect(result.fact.lifecycleState).toBe("missing_process");
    expect(result.fact.riskFlags).toContain("missing_process");
  });

  it("reaper dry-run lists missing_process workers from terminal-state worker", async () => {
    const stateRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "fresh", lastHeartbeat: LATER }),
      makeWorker({ workerId: "gone", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    // Write terminal state for the stale worker
    await writeWorkerState(stateRoot, "team-test", "gone", {
      pid: 12345,
      status: "exited",
      endedAt: "2026-06-07T11:30:00.000Z",
    });

    const result = await executeLifecycleAdapterCommand(
      makePorts(shutdownCalls),
      ["reaper", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("reaper");
    expect(result.envelope.dryRun).toBe(true);
    expect(result.envelope.executed).toBe(false);
    // The gone worker is both stale and missing_process
    expect(result.envelope.staleCount).toBeGreaterThanOrEqual(1);
    const goneAction = result.envelope.plannedActions?.find(
      (a: { workerId: string }) => a.workerId === "gone"
    );
    expect(goneAction).toBeDefined();
    expect(goneAction.action).toBe("terminate");
    expect(shutdownCalls).toEqual([]);
  });

  it("reaper dry-run lists missing_process workers from injected checkProcessExists returning false", async () => {
    const stateRoot = await makeProject();
    const shutdownCalls: Array<{ pid: number; workerId: string }> = [];
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "gone", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    await writeWorkerState(stateRoot, "team-test", "gone", {
      pid: 12345,
      status: "running",
    });

    let checkCalled: Array<{ pid: number; workerId: string }> = [];
    const ports = createLifecycleCliAdapterPorts({
      fs: fsPort,
      nowIso: () => NOW,
      newEventId: (prefix: string, seed: string) => `${prefix}-${seed}-gone-reaper`,
      shutdownProcess: async (pid: number, workerId: string) => {
        shutdownCalls.push({ pid, workerId });
      },
      checkProcessExists: async (input: { pid: number; memberId: string }) => {
        checkCalled.push({ pid: input.pid, workerId: input.memberId });
        return false;
      },
    });

    const result = await executeLifecycleAdapterCommand(
      ports,
      ["reaper", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(result.command).toBe("reaper");
    expect(checkCalled).toEqual([{ pid: 12345, workerId: "gone" }]);
    expect(result.envelope.dryRun).toBe(true);
    const goneAction = result.envelope.plannedActions?.find(
      (a: { workerId: string }) => a.workerId === "gone"
    );
    expect(goneAction).toBeDefined();
    expect(goneAction.action).toBe("terminate");
    expect(shutdownCalls).toEqual([]);
  });

  it("lifecycle-status uses default true when worker has running pid but no checkProcessExists port", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "ok", lastHeartbeat: LATER }),
    ]);
    await writeWorkerState(stateRoot, "team-test", "ok", {
      pid: 12345,
      status: "running",
    });

    const result = await executeLifecycleAdapterCommand(
      makePorts(),
      ["lifecycle-status", "ok", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    // Without checkProcessExists, process is assumed to exist
    expect(result.fact.lifecycleState).toBe("healthy");
    expect(result.fact.riskFlags).not.toContain("missing_process");
  });

  it("default checkProcessExists returns true for EPERM (process exists but cannot signal)", async () => {
    const stateRoot = await makeProject();
    await writeTeamRoster(stateRoot, "team-test", [
      makeWorker({ workerId: "eperm", lastHeartbeat: "2026-06-07T11:00:00.000Z" }),
    ]);
    await writeWorkerState(stateRoot, "team-test", "eperm", {
      pid: 99999,
      status: "running",
    });

    // Inject a checker that simulates EPERM
    let checkCalled: Array<{ pid: number; workerId: string }> = [];
    const ports = createLifecycleCliAdapterPorts({
      fs: fsPort,
      nowIso: () => NOW,
      newEventId: (prefix: string, seed: string) => `${prefix}-${seed}-eperm`,
      shutdownProcess: async () => {},
      checkProcessExists: async (input: { pid: number; memberId: string }) => {
        checkCalled.push({ pid: input.pid, workerId: input.memberId });
        // Simulate EPERM: process exists but we cannot signal it
        const err = new Error("EPERM: operation not permitted") as Error & { code: string };
        err.code = "EPERM";
        throw err;
      },
    });

    const result = await executeLifecycleAdapterCommand(
      ports,
      ["lifecycle-status", "eperm", "--team", "team-test", "--run", "run-1"],
      { stateRoot, cwd: stateRoot },
    );

    expect(result.ok).toBe(true);
    expect(checkCalled).toEqual([{ pid: 99999, workerId: "eperm" }]);
    // EPERM means process exists, so lifecycle should be healthy or stale, NOT missing_process
    expect(result.fact.lifecycleState).not.toBe("missing_process");
    expect(result.fact.riskFlags).not.toContain("missing_process");
  });
});
