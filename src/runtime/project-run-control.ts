import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessControlPort } from "./process-control.js";
import type { RunSupervisor, SpawnedProcessPort } from "./run-supervisor.js";
import {
  markProcessCrashed,
  markProcessExited,
  markProcessStopping,
  type RuntimeProcessRecord,
} from "./process-registry.js";

type ProcessRegistryStorePort = {
  find(id: string): RuntimeProcessRecord | undefined;
  list(): RuntimeProcessRecord[];
  upsert(process: RuntimeProcessRecord): unknown;
};

export type ProjectRunControlPort = {
  createRun(input: { task?: string }): Promise<{ runId: string }>;
  startRun(input: {
    runId: string;
  }): Promise<{ runId: string; alreadyRunning?: boolean }>;
  stopRun(input: {
    runId: string;
  }): Promise<{
    runId: string;
    stopped: boolean;
    processId?: string;
    reason?: "not-running";
  }>;
};

export type ProjectRunControlDeps = {
  stateDir: string;
  runsDir: string;
  projectId: string;
  supervisor: RunSupervisor;
  processStore: ProcessRegistryStorePort;
  executable: string;
  execArgv: readonly string[];
  mainScript: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nowIso: () => string;
  nowEpochMs: () => number;
  processControl: ProcessControlPort;
  newProcessId?: (action: "create" | "resume") => string;
  waitMs?: (ms: number) => Promise<void>;
  runCreationTimeoutMs?: number;
};

export function createProjectRunControl(
  deps: ProjectRunControlDeps,
): ProjectRunControlPort {
  const waitMs = deps.waitMs ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runCreationTimeoutMs = deps.runCreationTimeoutMs ?? 10_000;
  return {
    async createRun(input) {
      const previousRunId = readLatestRunId(deps.runsDir);
      const { processId, child } = startManagedRunProcess(deps, {
        action: "create",
        args: [
          ...deps.execArgv,
          deps.mainScript,
          "run",
          "--state-dir",
          deps.stateDir,
          ...(input.task ? ["--task", input.task] : []),
        ],
        metadata: {
          action: "create",
          task: input.task ?? null,
        },
      });
      const runId = await waitForNewLatestRun({
        runsDir: deps.runsDir,
        previousRunId,
        child,
        timeoutMs: runCreationTimeoutMs,
        nowEpochMs: deps.nowEpochMs,
        waitMs,
      });
      deps.supervisor.attachRunId({
        processId,
        runId,
        runDir: path.join(deps.runsDir, runId),
      });
      return { runId };
    },

    async startRun(input) {
      const runId = resolveRunId(deps.runsDir, input.runId);
      const recovery = reconcileRunProcessState({
        runId,
        processes: deps.supervisor.list(),
        processStore: deps.processStore,
        processControl: deps.processControl,
        nowIso: deps.nowIso,
        signal: "SIGTERM",
        cleanupHostsWhenNoLiveRun: true,
      });
      if (recovery.liveRun) {
        return { runId, alreadyRunning: true };
      }
      const { processId, child } = startManagedRunProcess(deps, {
        action: "resume",
        args: [
          ...deps.execArgv,
          deps.mainScript,
          "resume",
          runId,
          "--state-dir",
          deps.stateDir,
        ],
        metadata: {
          action: "resume",
          runId,
        },
      });
      deps.supervisor.attachRunId({
        processId,
        runId,
        runDir: path.join(deps.runsDir, runId),
      });
      return { runId };
    },

    async stopRun(input) {
      const runId = resolveRunId(deps.runsDir, input.runId);
      const recovery = reconcileRunProcessState({
        runId,
        processes: deps.processStore.list(),
        processStore: deps.processStore,
        processControl: deps.processControl,
        nowIso: deps.nowIso,
        signal: "SIGTERM",
        cleanupHostsWhenNoLiveRun: true,
      });
      const active = recovery.liveRun;
      if (!active) {
        if (recovery.cleanedProcessIds.length > 0) {
          return {
            runId,
            stopped: true,
            processId: recovery.cleanedProcessIds[0],
          };
        }
        return { runId, stopped: false, reason: "not-running" };
      }

      deps.processStore.upsert(
        markProcessStopping(active, { now: deps.nowIso() }),
      );

      const signal: NodeJS.Signals = "SIGTERM";
      const signaled = signalPid(active, signal, deps.processControl);

      if (!signaled) {
        throw new Error(`Failed to signal process ${active.id} for run ${runId}`);
      }
      return { runId, stopped: true, processId: active.id };
    },
  };
}

export function readLatestRunId(runsDir: string): string | undefined {
  const latestJsonPath = path.join(runsDir, "latest.json");
  if (fs.existsSync(latestJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(latestJsonPath, "utf-8")) as {
        runId?: string;
      };
      if (data.runId) {
        return data.runId;
      }
    } catch {
      // Fall through to directory scan.
    }
  }

  if (!fs.existsSync(runsDir)) {
    return undefined;
  }
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => entry.name)
    .sort();
  return dirs.at(-1);
}

function startManagedRunProcess(
  deps: ProjectRunControlDeps,
  input: {
    action: "create" | "resume";
    args: readonly string[];
    metadata: Record<string, string | number | boolean | null>;
  },
): { processId: string; child: SpawnedProcessPort } {
  const processId =
    deps.newProcessId?.(input.action) ??
    `project-run-${input.action}-${deps.nowEpochMs()}`;
  const { child } = deps.supervisor.startProcess({
    processId,
    kind: "run",
    owner: { scope: "project", projectId: deps.projectId },
    executable: deps.executable,
    args: input.args,
    cwd: deps.cwd,
    env: deps.env,
    statePath: deps.stateDir,
    metadata: input.metadata,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref?.();
  return { processId, child };
}

async function waitForNewLatestRun(options: {
  runsDir: string;
  previousRunId?: string;
  child: SpawnedProcessPort;
  timeoutMs: number;
  nowEpochMs: () => number;
  waitMs: (ms: number) => Promise<void>;
}): Promise<string> {
  let childExit:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined;

  options.child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const startedAt = options.nowEpochMs();
  while (options.nowEpochMs() - startedAt < options.timeoutMs) {
    const runId = readLatestRunId(options.runsDir);
    if (runId && runId !== options.previousRunId) {
      return runId;
    }

    if (childExit) {
      throw new Error(
        `agent run exited before creating a run (code=${childExit.code}, signal=${childExit.signal})`,
      );
    }

    await options.waitMs(100);
  }

  throw new Error("timed out waiting for agent run to create latest run");
}

function resolveRunId(runsDir: string, runIdOrLatest: string): string {
  const runId =
    runIdOrLatest === "latest" ? readLatestRunId(runsDir) : runIdOrLatest;
  if (!runId) {
    throw new Error("No latest run is available.");
  }
  const statePath = path.join(runsDir, runId, "state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error(`Run ${runId} is not available at ${statePath}.`);
  }
  return runId;
}

function signalPid(
  processRecord: RuntimeProcessRecord,
  signal: NodeJS.Signals,
  processControl: ProcessControlPort,
): boolean {
  if (typeof processRecord.pid !== "number" || processRecord.pid <= 0) {
    throw new Error(`Run process ${processRecord.id} has no pid to signal`);
  }
  return processControl.signal(processRecord.pid, signal);
}

type RunProcessRecovery = {
  liveRun?: RuntimeProcessRecord;
  cleanedProcessIds: string[];
};

function reconcileRunProcessState(input: {
  runId: string;
  processes: readonly RuntimeProcessRecord[];
  processStore: ProcessRegistryStorePort;
  processControl: ProcessControlPort;
  nowIso: () => string;
  signal: NodeJS.Signals;
  cleanupHostsWhenNoLiveRun: boolean;
}): RunProcessRecovery {
  const cleanedProcessIds: string[] = [];
  const runProcesses = input.processes.filter(
    (process) =>
      process.kind === "run" &&
      isPotentiallyActiveProcessStatus(process.status) &&
      processBelongsToRun(process, input.runId),
  );

  let liveRun: RuntimeProcessRecord | undefined;
  for (const process of runProcesses) {
    if (isProcessRecordAlive(process, input.processControl)) {
      liveRun ??= process;
      continue;
    }
    input.processStore.upsert(
      markProcessCrashed(process, {
        now: input.nowIso(),
        message: "stale run process record cleaned before run-control action",
      }),
    );
    cleanedProcessIds.push(process.id);
  }

  if (liveRun) {
    return { liveRun, cleanedProcessIds };
  }

  if (!input.cleanupHostsWhenNoLiveRun) {
    return { cleanedProcessIds };
  }

  for (const process of input.processes) {
    if (
      process.kind === "run" ||
      !isPotentiallyActiveProcessStatus(process.status) ||
      !processBelongsToRun(process, input.runId)
    ) {
      continue;
    }
    if (isProcessRecordAlive(process, input.processControl)) {
      const signaled = signalProcessRecord(
        process,
        input.signal,
        input.processControl,
      );
      if (!signaled) {
        throw new Error(
          `Failed to signal stale ${process.kind} process ${process.id} for run ${input.runId}`,
        );
      }
    }
    input.processStore.upsert(
      markProcessExited(process, {
        now: input.nowIso(),
        signal: input.signal,
      }),
    );
    cleanedProcessIds.push(process.id);
  }

  return { cleanedProcessIds };
}

function processBelongsToRun(
  process: RuntimeProcessRecord,
  runId: string,
): boolean {
  if (
    (process.owner.scope === "run" ||
      process.owner.scope === "session" ||
      process.owner.scope === "team-member") &&
    process.owner.runId === runId
  ) {
    return true;
  }
  if (process.metadata?.runId === runId) {
    return true;
  }
  return false;
}

function isPotentiallyActiveProcessStatus(
  status: RuntimeProcessRecord["status"],
): boolean {
  return (
    status === "planned" ||
    status === "starting" ||
    status === "running" ||
    status === "stopping"
  );
}

function isProcessRecordAlive(
  processRecord: RuntimeProcessRecord,
  processControl: ProcessControlPort,
): boolean {
  return (
    typeof processRecord.pid === "number" &&
    processRecord.pid > 0 &&
    processControl.isAlive(processRecord.pid)
  );
}

function signalProcessRecord(
  processRecord: RuntimeProcessRecord,
  signal: NodeJS.Signals,
  processControl: ProcessControlPort,
): boolean {
  if (typeof processRecord.pid !== "number" || processRecord.pid <= 0) {
    return false;
  }
  return processControl.signal(processRecord.pid, signal);
}
