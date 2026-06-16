import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
} from "../im/run-endpoints.js";
import type { PublicImService } from "../im/service.js";
import {
  createDefaultRuntimeImService,
  handleRuntimeImRequest,
  parseRuntimeImRequest,
  parseRuntimeImResponse,
  runtimeImErrorResponse,
  type RuntimeImRequest,
  type RuntimeImResponse,
} from "../im/protocol.js";
import { StateRootResolver } from "../state/root.js";
import {
  createProjectRunControl,
  type ProjectRunControlPort,
} from "./project-run-control.js";
import {
  ProjectSnapshotProjector,
  type ProjectSnapshotResult,
} from "./project-snapshot.js";
import {
  ProjectWorkbenchService,
  parseWorkbenchRequest,
  parseWorkbenchServerMessage,
  workbenchErrorResponse,
  type WorkbenchBackendPort,
  type WorkbenchClientPort,
  type WorkbenchRequest,
  type WorkbenchResponse,
  type WorkbenchServerMessage,
} from "./project-workbench.js";
import { JsonlRuntimeEventSink } from "./event-store.js";
import { JsonProcessRegistryStore } from "./process-store.js";
import {
  nodeProcessControl,
  nodeProcessSpawner,
  type ProcessControlPort,
} from "./process-control.js";
import {
  listenResidentHostSocket,
  requestResidentHostJson,
  RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
  type ResidentHostSocketConnectionPort,
} from "./resident-host.js";
import {
  markProcessExited,
  markProcessCrashed,
  type RuntimeProcessOwner,
  type RuntimeProcessRecord,
} from "./process-registry.js";
import { RunSupervisor, type SpawnedProcessPort } from "./run-supervisor.js";

export type RuntimeReplicaPaths = {
  processId: string;
  socketPath: string;
  statePath: string;
  logPath: string;
};

export type RuntimeReplicaIdentity =
  | {
      mode: "run";
      runId: string;
    }
  | {
      mode: "edge";
      edgeId: string;
    };

export type RuntimeHealthRequest = {
  schemaVersion: 1;
  id: string;
  type: "runtime.health";
};

export type RuntimeCapabilitiesRequest = {
  schemaVersion: 1;
  id: string;
  type: "runtime.capabilities";
};

export type RuntimeShutdownRequest = {
  schemaVersion: 1;
  id: string;
  type: "runtime.shutdown";
  reason?: string;
};

export type ProjectSnapshotRequest = {
  schemaVersion: 1;
  id: string;
  type: "project.snapshot";
  selectedRunId?: string;
};

export type RunCreateRequest = {
  schemaVersion: 1;
  id: string;
  type: "run.create";
  task?: string;
};

export type RunResumeRequest = {
  schemaVersion: 1;
  id: string;
  type: "run.resume";
  runId: string;
};

export type RunStopRequest = {
  schemaVersion: 1;
  id: string;
  type: "run.stop";
  runId?: string;
};

export type RuntimeRequest =
  | RuntimeHealthRequest
  | RuntimeCapabilitiesRequest
  | RuntimeShutdownRequest
  | ProjectSnapshotRequest
  | RunCreateRequest
  | RunResumeRequest
  | RunStopRequest;

export type RuntimeProjectServices = {
  snapshot(input: { selectedRunId?: string }): Promise<ProjectSnapshotResult>;
  dispose?: () => void;
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

export type RuntimeResponse =
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "runtime.result";
      command: Exclude<RuntimeRequest["type"], "runtime.shutdown">;
      data: Record<string, unknown>;
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: true;
      type: "runtime.shutdown.result";
    }
  | {
      schemaVersion: 1;
      id: string;
      ok: false;
      type: "runtime.error";
      error: {
        code: "BAD_REQUEST" | "RUNTIME_ERROR";
        message: string;
      };
    };

export type RuntimeReplicaRequest = RuntimeRequest | RuntimeImRequest | WorkbenchRequest;
export type RuntimeReplicaResponse =
  | RuntimeResponse
  | RuntimeImResponse
  | WorkbenchResponse;

export type LaunchedRuntimeReplica = RuntimeReplicaPaths & {
  started: boolean;
  dispose: () => Promise<void>;
};

export type ProjectUiEdgeRuntimeReplicaCleanupResult = {
  processId: string;
  edgeId: string;
  ownerPid: number;
  replicaPid?: number;
  shutdownRequested: boolean;
  exitedAfterShutdown: boolean;
  signalled: boolean;
  exitedAfterSignal: boolean;
  forceSignalled: boolean;
  exitedAfterForceSignal: boolean;
};

type StaleProjectUiEdgeRuntimeReplica = Omit<
  ProjectUiEdgeRuntimeReplicaCleanupResult,
  | "shutdownRequested"
  | "exitedAfterShutdown"
  | "signalled"
  | "exitedAfterSignal"
  | "forceSignalled"
  | "exitedAfterForceSignal"
> & {
  socketPath?: string;
};

export type LaunchRuntimeReplicaInput = {
  supervisor: Pick<RunSupervisor, "startProcess">;
  processId: string;
  identity: RuntimeReplicaIdentity;
  owner: RuntimeProcessOwner;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  statePath: string;
  logPath: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
};

export const RUNTIME_HOST_SOCKET_ENV = "TAH_RUNTIME_HOST_SOCKET";
export const DEFAULT_WORKBENCH_REFRESH_INTERVAL_MS = 100;

export function runtimeReplicaProcessId(runId: string): string {
  assertNonEmpty("runId", runId);
  return `runtime-replica:${runId}`;
}

export function edgeRuntimeReplicaProcessId(edgeId: string): string {
  assertNonEmpty("edgeId", edgeId);
  return `runtime-replica:edge:${edgeId}`;
}

export function runtimeReplicaPaths(input: {
  runDir: string;
  runId: string;
  socketRoot: string;
  socketScope: string;
}): RuntimeReplicaPaths {
  assertNonEmpty("runDir", input.runDir);
  assertNonEmpty("socketRoot", input.socketRoot);
  assertNonEmpty("socketScope", input.socketScope);
  const processId = runtimeReplicaProcessId(input.runId);
  const digest = createHash("sha256")
    .update(input.socketScope)
    .update("\0")
    .update(input.runId)
    .update("\0")
    .update("runtime-replica")
    .digest("hex")
    .slice(0, 16);
  const socketPath = path.join(input.socketRoot, `runtime-${digest}.sock`);
  assertSocketPathBudget(socketPath);
  return {
    processId,
    socketPath,
    statePath: path.join(input.runDir, "runtime-replica.json"),
    logPath: path.join(input.runDir, "runtime-replica.stderr.log"),
  };
}

export function edgeRuntimeReplicaPaths(input: {
  stateDir: string;
  edgeId: string;
  socketRoot: string;
  socketScope: string;
}): RuntimeReplicaPaths {
  assertNonEmpty("stateDir", input.stateDir);
  assertNonEmpty("edgeId", input.edgeId);
  assertNonEmpty("socketRoot", input.socketRoot);
  assertNonEmpty("socketScope", input.socketScope);
  const processId = edgeRuntimeReplicaProcessId(input.edgeId);
  const digest = createHash("sha256")
    .update(input.socketScope)
    .update("\0")
    .update(input.edgeId)
    .update("\0")
    .update("runtime-replica-edge")
    .digest("hex")
    .slice(0, 16);
  const socketPath = path.join(input.socketRoot, `runtime-edge-${digest}.sock`);
  assertSocketPathBudget(socketPath);
  const edgeDir = path.join(
    input.stateDir,
    "runtime",
    "edges",
    safePathSegment(input.edgeId),
  );
  return {
    processId,
    socketPath,
    statePath: path.join(edgeDir, "runtime-replica.json"),
    logPath: path.join(edgeDir, "runtime-replica.stderr.log"),
  };
}

export async function ensureRuntimeReplica(input: {
  paths: RuntimeReplicaPaths;
  runId: string;
  stateDir: string;
  supervisor: Pick<RunSupervisor, "startProcess">;
  executable: string;
  execArgv: readonly string[];
  mainScript: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
}): Promise<LaunchedRuntimeReplica> {
  if (
    await isRuntimeReplicaResponsive({
      socketPath: input.paths.socketPath,
      timeoutMs: input.requestTimeoutMs ?? 500,
      expectedIdentity: { mode: "run", runId: input.runId },
    })
  ) {
    return {
      ...input.paths,
      started: false,
      dispose: async () => undefined,
    };
  }

  return await launchRuntimeReplica({
    supervisor: input.supervisor,
    processId: input.paths.processId,
    identity: { mode: "run", runId: input.runId },
    owner: { scope: "run", runId: input.runId },
    executable: input.executable,
    args: [
      ...input.execArgv,
      input.mainScript,
      "runtime",
      "replica",
      "--mode",
      "run",
      "--run-id",
      input.runId,
      "--socket",
      input.paths.socketPath,
      "--state-dir",
      input.stateDir,
    ],
    cwd: input.cwd,
    env: input.env,
    socketPath: input.paths.socketPath,
    statePath: input.paths.statePath,
    logPath: input.paths.logPath,
    startupTimeoutMs: input.startupTimeoutMs,
    nowEpochMs: input.nowEpochMs,
    wait: input.wait,
    isSocketReady: input.isSocketReady,
  });
}

export async function ensureEdgeRuntimeReplica(input: {
  paths: RuntimeReplicaPaths;
  edgeId: string;
  projectId: string;
  stateDir: string;
  supervisor: Pick<RunSupervisor, "startProcess">;
  executable: string;
  execArgv: readonly string[];
  mainScript: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
}): Promise<LaunchedRuntimeReplica> {
  if (
    await isRuntimeReplicaResponsive({
      socketPath: input.paths.socketPath,
      timeoutMs: input.requestTimeoutMs ?? 500,
      expectedIdentity: { mode: "edge", edgeId: input.edgeId },
    })
  ) {
    return {
      ...input.paths,
      started: false,
      dispose: async () => undefined,
    };
  }

  return await launchRuntimeReplica({
    supervisor: input.supervisor,
    processId: input.paths.processId,
    identity: { mode: "edge", edgeId: input.edgeId },
    owner: { scope: "project", projectId: input.projectId },
    executable: input.executable,
    args: [
      ...input.execArgv,
      input.mainScript,
      "runtime",
      "replica",
      "--mode",
      "edge",
      "--edge-id",
      input.edgeId,
      "--socket",
      input.paths.socketPath,
      "--state-dir",
      input.stateDir,
    ],
    cwd: input.cwd,
    env: input.env,
    socketPath: input.paths.socketPath,
    statePath: input.paths.statePath,
    logPath: input.paths.logPath,
    startupTimeoutMs: input.startupTimeoutMs,
    nowEpochMs: input.nowEpochMs,
    wait: input.wait,
    isSocketReady: input.isSocketReady,
  });
}

export async function cleanupProjectUiEdgeRuntimeReplicas(input: {
  store: Pick<JsonProcessRegistryStore, "list" | "upsert">;
  processControl: ProcessControlPort;
  projectId: string;
  currentEdgeId: string;
  nowIso: () => string;
  nowEpochMs?: () => number;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  requestTimeoutMs?: number;
  exitWaitMs?: number;
  forceExitWaitMs?: number;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  uiEdgeIdPrefix?: string;
}): Promise<ProjectUiEdgeRuntimeReplicaCleanupResult[]> {
  const signal = input.signal ?? "SIGTERM";
  const forceSignal = input.forceSignal ?? "SIGKILL";
  const prefix = input.uiEdgeIdPrefix ?? "project-ui-";
  const exitWaitMs = input.exitWaitMs ?? 1_000;
  const forceExitWaitMs = input.forceExitWaitMs ?? 500;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowEpochMs = input.nowEpochMs ?? Date.now;
  let requestSequence = 0;
  const cleaned: ProjectUiEdgeRuntimeReplicaCleanupResult[] = [];

  for (const process of input.store.list()) {
    const stale = classifyProjectUiEdgeRuntimeReplica({
      process,
      projectId: input.projectId,
      currentEdgeId: input.currentEdgeId,
      uiEdgeIdPrefix: prefix,
      processControl: input.processControl,
    });
    if (!stale) {
      continue;
    }

    const { socketPath, ...publicStale } = stale;
    const shutdownRequested = await requestStaleRuntimeReplicaShutdown({
      socketPath,
      timeoutMs: input.requestTimeoutMs ?? 100,
      requestId: `runtime-cleanup-${nowEpochMs()}-${++requestSequence}`,
    });
    const exitedAfterShutdown =
      shutdownRequested &&
      (stale.replicaPid === undefined ||
        (await waitForPidExit({
          pid: stale.replicaPid,
          processControl: input.processControl,
          timeoutMs: exitWaitMs,
          pollIntervalMs,
          wait,
          nowEpochMs,
        })));
    let signalled = false;
    let exitedAfterSignal = false;
    let forceSignalled = false;
    let exitedAfterForceSignal = false;
    if (!exitedAfterShutdown && stale.replicaPid !== undefined) {
      signalled = input.processControl.signal(stale.replicaPid, signal);
      if (signalled) {
        exitedAfterSignal = await waitForPidExit({
          pid: stale.replicaPid,
          processControl: input.processControl,
          timeoutMs: exitWaitMs,
          pollIntervalMs,
          wait,
          nowEpochMs,
        });
      }
      if (!exitedAfterSignal && signal !== forceSignal) {
        forceSignalled = input.processControl.signal(stale.replicaPid, forceSignal);
        if (forceSignalled) {
          exitedAfterForceSignal = await waitForPidExit({
            pid: stale.replicaPid,
            processControl: input.processControl,
            timeoutMs: forceExitWaitMs,
            pollIntervalMs,
            wait,
            nowEpochMs,
          });
        }
      }
    }
    const cleanupSignal = forceSignalled
      ? forceSignal
      : signalled
        ? signal
        : null;
    input.store.upsert(
      exitedAfterShutdown
        ? markProcessExited(process, {
            now: input.nowIso(),
            exitCode: 0,
            signal: null,
          })
        : markRuntimeReplicaCleanupCrashed(process, {
            now: input.nowIso(),
            signal: cleanupSignal,
            message: `project UI owner pid ${stale.ownerPid} is not alive`,
          }),
    );
    cleaned.push({
      ...publicStale,
      shutdownRequested,
      exitedAfterShutdown,
      signalled,
      exitedAfterSignal,
      forceSignalled,
      exitedAfterForceSignal,
    });
  }

  return cleaned;
}

export async function launchRuntimeReplica(
  input: LaunchRuntimeReplicaInput,
): Promise<LaunchedRuntimeReplica> {
  const { child } = input.supervisor.startProcess({
    processId: input.processId,
    kind: "runtime-replica",
    owner: input.owner,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    statePath: input.statePath,
    logPath: input.logPath,
    stdio: ["ignore", "pipe", "pipe"],
    metadata: {
      mode: input.identity.mode,
      ...(input.identity.mode === "run"
        ? { runId: input.identity.runId }
        : { edgeId: input.identity.edgeId }),
      socketPath: input.socketPath,
    },
  });

  let logStream: fs.WriteStream | undefined;
  if (child.stderr) {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
    logStream = fs.createWriteStream(input.logPath, { flags: "a" });
    logStream.on("error", () => undefined);
    child.stderr.pipe(logStream);
  }

  try {
    await waitForSocket({
      child,
      socketPath: input.socketPath,
      timeoutMs: input.startupTimeoutMs ?? 5_000,
      pollIntervalMs: input.pollIntervalMs ?? 25,
      nowEpochMs: input.nowEpochMs ?? Date.now,
      wait: input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      isSocketReady: input.isSocketReady ?? isSocketPathReady,
    });
  } catch (error) {
    if (logStream && child.stderr) {
      child.stderr.unpipe(logStream);
      await closeLogStream(logStream);
    }
    killChild(child);
    throw error;
  }

  return {
    processId: input.processId,
    socketPath: input.socketPath,
    statePath: input.statePath,
    logPath: input.logPath,
    started: true,
    dispose: async () => {
      await requestRuntimeReplica({
        socketPath: input.socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: `runtime-dispose-${Date.now()}`,
          type: "runtime.shutdown",
          reason: "owner_dispose",
        },
      }).catch(() => undefined);
      if (logStream && child.stderr) {
        child.stderr.unpipe(logStream);
        await closeLogStream(logStream);
      }
      killChild(child);
    },
  };
}

export async function listenRuntimeReplicaSocket(options: {
  socketPath: string;
  stateRoot: string;
  identity: RuntimeReplicaIdentity;
  imService?: PublicImService;
  projectServices?: RuntimeProjectServices;
  workbenchService?: ProjectWorkbenchService;
  workbenchRefreshIntervalMs?: number;
  onShutdown?: () => Promise<void> | void;
}) {
  const imService = options.imService ?? createDefaultRuntimeImService();
  const projectServices =
    options.projectServices ??
    lazyRuntimeProjectServices({
      stateRoot: options.stateRoot,
      imService,
    });
  const workbenchService =
    options.workbenchService ??
    createDefaultProjectWorkbenchService({
      stateRoot: options.stateRoot,
      imService,
      projectServices,
    });
  const server = await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line, connection) => {
      const { request, response, afterResponse } =
        await handleRuntimeReplicaSocketLine({
        line,
        stateRoot: options.stateRoot,
        identity: options.identity,
        imService,
        projectServices,
        workbenchService,
        connection,
      });
      if (request?.type === "runtime.shutdown") {
        await options.onShutdown?.();
      }
      return {
        responseLine: JSON.stringify(response),
        afterResponse,
        close: request?.type === "runtime.shutdown",
      };
    },
  });
  const stopWorkbenchRefresh = startRuntimeWorkbenchRefreshLoop({
    workbenchService,
    intervalMs: options.workbenchRefreshIntervalMs ?? DEFAULT_WORKBENCH_REFRESH_INTERVAL_MS,
  });
  server.once("close", () => {
    stopWorkbenchRefresh();
    projectServices.dispose?.();
  });
  return server;
}

export function lazyRuntimeProjectServices(input: {
  stateRoot: string;
  imService: PublicImService;
}): RuntimeProjectServices {
  let services: RuntimeProjectServices | undefined;
  const getServices = () => {
    services ??= createDefaultRuntimeProjectServices(input);
    return services;
  };
  return {
    snapshot(request) {
      return getServices().snapshot(request);
    },
    dispose() {
      services?.dispose?.();
    },
    createRun(request) {
      return getServices().createRun(request);
    },
    startRun(request) {
      return getServices().startRun(request);
    },
    stopRun(request) {
      return getServices().stopRun(request);
    },
  };
}

export function createDefaultRuntimeProjectServices(input: {
  stateRoot: string;
  imService: PublicImService;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executable?: string;
  execArgv?: readonly string[];
  mainScript?: string;
  nowIso?: () => string;
  nowEpochMs?: () => number;
}): RuntimeProjectServices {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const nowEpochMs = input.nowEpochMs ?? Date.now;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const mainScript = input.mainScript ?? process.argv[1];
  if (!mainScript) {
    throw new Error("Runtime project services require a main script path");
  }

  const stateRootInfo = new StateRootResolver({
    env,
    cwd: () => cwd,
    nowIso,
  }).resolve({ stateDir: input.stateRoot });
  const runsDir = path.join(stateRootInfo.stateDir, "runs");
  const processStore = new JsonProcessRegistryStore({
    filePath: path.join(stateRootInfo.stateDir, "processes.json"),
    nowIso,
  });
  const supervisor = new RunSupervisor({
    store: processStore,
    spawner: nodeProcessSpawner,
    nowIso,
    nowEpochMs,
    events: new JsonlRuntimeEventSink({
      filePath: path.join(stateRootInfo.stateDir, "runtime", "events.jsonl"),
    }),
    newEventId: createRuntimeEventIdFactory("runtime-replica"),
    eventProducer: "tiny-agent-runtime-replica",
  });
  let processSequence = 0;
  const projectRunControl: ProjectRunControlPort = createProjectRunControl({
    stateDir: stateRootInfo.stateDir,
    runsDir,
    projectId: stateRootInfo.projectConfig.projectId,
    supervisor,
    processStore,
    executable: input.executable ?? process.execPath,
    execArgv: input.execArgv ?? process.execArgv,
    mainScript,
    cwd,
    env,
    nowIso,
    nowEpochMs,
    processControl: nodeProcessControl,
    newProcessId: (action) =>
      `runtime-run-${action}-${nowEpochMs()}-${++processSequence}`,
  });

  const snapshotProjector = new ProjectSnapshotProjector({
    stateRoot: stateRootInfo.stateDir,
    imService: input.imService,
  });

  return {
    snapshot(request) {
      return snapshotProjector.snapshot(request);
    },
    dispose() {
      snapshotProjector.dispose();
    },
    createRun(request) {
      return projectRunControl.createRun(request);
    },
    startRun(request) {
      return projectRunControl.startRun(request);
    },
    stopRun(request) {
      return projectRunControl.stopRun(request);
    },
  };
}

export function createDefaultProjectWorkbenchService(input: {
  stateRoot: string;
  imService: PublicImService;
  projectServices: RuntimeProjectServices;
  nowIso?: () => string;
  newClientId?: () => string;
  newEventId?: () => string;
  maxEventLogSize?: number;
}): ProjectWorkbenchService {
  let clientSequence = 0;
  let eventSequence = 0;
  let imSequence = 0;
  const backend: WorkbenchBackendPort = {
    snapshot(request) {
      return input.projectServices.snapshot(request);
    },
    async postUserMessage(request) {
      const response = await handleRuntimeImRequest(
        input.imService,
        { stateRoot: input.stateRoot },
        {
          schemaVersion: 1,
          id: `workbench-im-post-${++imSequence}`,
          type: "im.post",
          from: request.from,
          to: request.to,
          text: request.text,
          metadata: request.metadata,
        },
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return isRecord(response.data)
        ? response.data
        : { value: response.data };
    },
    createRun(request) {
      return input.projectServices.createRun(request);
    },
    startRun(request) {
      return input.projectServices.startRun(request);
    },
    stopRun(request) {
      return input.projectServices.stopRun(request);
    },
  };

  return new ProjectWorkbenchService({
    backend,
    userEndpoint: DEFAULT_RUN_USER_ENDPOINT,
    runEndpoint: createRunImSelfEndpoint,
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
    newClientId:
      input.newClientId ?? (() => `workbench-client-${++clientSequence}`),
    newEventId:
      input.newEventId ?? (() => `workbench-event-${++eventSequence}`),
    maxEventLogSize: input.maxEventLogSize,
  });
}

function startRuntimeWorkbenchRefreshLoop(input: {
  workbenchService: ProjectWorkbenchService;
  intervalMs: number;
}): () => void {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    return () => undefined;
  }
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    void input.workbenchService
      .refreshSubscribedViews({ reason: "refresh" })
      .then((deliveries) => {
        for (const delivery of deliveries) {
          delivery.port.send(delivery.event);
        }
      })
      .catch(() => {
        // Background projection refresh is best-effort; explicit commands still report errors.
      })
      .finally(() => {
        refreshing = false;
      });
  }, input.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function requestRuntimeReplica(
  options: {
    socketPath: string;
    request: RuntimeRequest;
    timeoutMs: number;
  },
): Promise<RuntimeResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseRuntimeResponse(raw, options.request.id),
  });
}

export async function requestRuntimeReplicaIm(
  options: {
    socketPath: string;
    request: RuntimeImRequest;
    timeoutMs: number;
  },
): Promise<RuntimeImResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseRuntimeImResponse(raw, options.request.id),
  });
}

export async function requestRuntimeReplicaAny(
  options: {
    socketPath: string;
    request: RuntimeReplicaRequest;
    timeoutMs: number;
  },
): Promise<RuntimeReplicaResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) =>
      options.request.type.startsWith("im.")
        ? parseRuntimeImResponse(raw, options.request.id)
        : options.request.type.startsWith("workbench.")
          ? parseRuntimeReplicaWorkbenchResponse(raw, options.request.id)
        : parseRuntimeResponse(raw, options.request.id),
  });
}

export async function runRuntimeCli(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(runtimeUsage());
    return 0;
  }

  if (command === "replica") {
    const options = parseRuntimeReplicaCliOptions(argv.slice(1));
    if (!options.socketPath || !options.stateRoot || !options.identity) {
      throw new Error(
        "Usage: tiny-agent runtime replica --mode <run|edge> (--run-id <runId>|--edge-id <edgeId>) --socket <path> --state-dir <dir>",
      );
    }
    const server = await listenRuntimeReplicaSocket({
      socketPath: options.socketPath,
      stateRoot: options.stateRoot,
      identity: options.identity,
    });
    await Promise.race([
      new Promise<void>((resolve) => server.once("close", resolve)),
      new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      }),
    ]);
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return 0;
  }

  if (
    command !== "health" &&
    command !== "capabilities" &&
    command !== "shutdown"
  ) {
    throw new Error(runtimeUsage());
  }

  const { flags } = parseRuntimeArgs(argv.slice(1));
  const socketPath = flags["runtime-host-socket"] ?? process.env[RUNTIME_HOST_SOCKET_ENV];
  if (!socketPath) {
    throw new Error(
      `tiny-agent runtime ${command} requires ${RUNTIME_HOST_SOCKET_ENV} or --runtime-host-socket <path>`,
    );
  }
  const timeoutMs =
    flags["host-timeout-ms"] === undefined
      ? 30_000
      : Number.parseInt(flags["host-timeout-ms"], 10);
  const requestId = `runtime-cli-${Date.now()}`;
  if (command === "health") {
    const response = await requestRuntimeReplica({
      socketPath,
      timeoutMs,
      request: { schemaVersion: 1, id: requestId, type: "runtime.health" },
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  }
  if (command === "capabilities") {
    const response = await requestRuntimeReplica({
      socketPath,
      timeoutMs,
      request: { schemaVersion: 1, id: requestId, type: "runtime.capabilities" },
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  }
  if (command === "shutdown") {
    const response = await requestRuntimeReplica({
      socketPath,
      timeoutMs,
      request: { schemaVersion: 1, id: requestId, type: "runtime.shutdown" },
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  }

  throw new Error(runtimeUsage());
}

async function handleRuntimeReplicaSocketLine(options: {
  line: string;
  stateRoot: string;
  identity: RuntimeReplicaIdentity;
  imService: PublicImService;
  projectServices: RuntimeProjectServices;
  workbenchService: ProjectWorkbenchService;
  connection: ResidentHostSocketConnectionPort;
}): Promise<{
  request?: RuntimeReplicaRequest;
  response: RuntimeReplicaResponse;
  afterResponse?: () => Promise<void> | void;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.line);
  } catch (error) {
    return {
      response: runtimeErrorResponse({
        id: "unknown",
        code: "BAD_REQUEST",
        message: `Invalid runtime replica request JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return {
      response: runtimeErrorResponse({
        id: requestIdFromUnknown(parsed),
        code: "BAD_REQUEST",
        message: "Invalid runtime replica request: type must be string",
      }),
    };
  }

  if (parsed.type.startsWith("im.")) {
    let request: RuntimeImRequest;
    try {
      request = parseRuntimeImRequest(options.line);
    } catch (error) {
      return {
        response: runtimeImErrorResponse({
          id: requestIdFromUnknown(parsed),
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    return {
      request,
      response: await handleRuntimeImRequest(
        options.imService,
        { stateRoot: options.stateRoot },
        request,
      ),
    };
  }

  if (parsed.type.startsWith("workbench.")) {
    let request: WorkbenchRequest;
    try {
      request = parseWorkbenchRequest(parsed);
    } catch (error) {
      return {
        response: workbenchErrorResponse({
          id: requestIdFromUnknown(parsed),
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    const port = workbenchClientPortFromConnection(options.connection);
    const result = await options.workbenchService.handleRequest(request, port);
    return {
      request,
      response: result.response,
      afterResponse: () => {
        for (const event of result.events) {
          port.send(event);
        }
      },
    };
  }

  let request: RuntimeRequest;
  try {
    request = parseRuntimeRequestFromRecord(parsed);
  } catch (error) {
    return {
      response: runtimeErrorResponse({
        id: requestIdFromUnknown(parsed),
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
  return {
    request,
    response: await handleRuntimeRequest({
      request,
      stateRoot: options.stateRoot,
      identity: options.identity,
      projectServices: options.projectServices,
    }),
  };
}

async function handleRuntimeRequest(input: {
  request: RuntimeRequest;
  stateRoot: string;
  identity: RuntimeReplicaIdentity;
  projectServices: RuntimeProjectServices;
}): Promise<RuntimeResponse> {
  const { request } = input;
  switch (request.type) {
    case "runtime.health":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: {
          status: "ok",
          mode: "active-active-replica",
          replicaMode: input.identity.mode,
          identity: input.identity,
          ...(input.identity.mode === "run"
            ? { runId: input.identity.runId }
            : { edgeId: input.identity.edgeId }),
          stateRoot: input.stateRoot,
        },
      };
    case "runtime.capabilities":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: {
          mode: "active-active-replica",
          replicaMode: input.identity.mode,
          identity: input.identity,
          ...(input.identity.mode === "run"
            ? { runId: input.identity.runId }
            : { edgeId: input.identity.edgeId }),
          capabilities: [
            "runtime.health",
            "runtime.capabilities",
            "runtime.shutdown",
            "project.snapshot",
            "run.create",
            "run.resume",
            "run.stop",
            "im.pair",
            "im.bind",
            "im.post",
            "im.send",
            "im.recv",
            "im.ack",
            "im.run-recv",
            "im.run-ack",
            "workbench.connect",
            "workbench.subscribe",
            "workbench.replay",
            "workbench.snapshot",
            "workbench.command",
          ],
        },
      };
    case "runtime.shutdown":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.shutdown.result",
      };
    case "project.snapshot":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: (await input.projectServices.snapshot({
          selectedRunId: request.selectedRunId,
        })) as unknown as Record<string, unknown>,
      };
    case "run.create":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: await input.projectServices.createRun({
          task: request.task,
        }),
      };
    case "run.resume":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: await input.projectServices.startRun({
          runId: request.runId,
        }),
      };
    case "run.stop":
      return {
        schemaVersion: 1,
        id: request.id,
        ok: true,
        type: "runtime.result",
        command: request.type,
        data: await input.projectServices.stopRun({
          runId: request.runId ?? "latest",
        }),
      };
  }
}

function workbenchClientPortFromConnection(
  connection: ResidentHostSocketConnectionPort,
): WorkbenchClientPort {
  return {
    send(message) {
      connection.sendLine(JSON.stringify(message));
    },
    onClose(handler) {
      connection.onClose(handler);
    },
  };
}

function parseRuntimeRequestFromRecord(
  parsed: Record<string, unknown>,
): RuntimeRequest {
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid runtime replica request: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid runtime replica request: id must be non-empty");
  }
  if (
    parsed.type !== "runtime.health" &&
    parsed.type !== "runtime.capabilities" &&
    parsed.type !== "runtime.shutdown" &&
    parsed.type !== "project.snapshot" &&
    parsed.type !== "run.create" &&
    parsed.type !== "run.resume" &&
    parsed.type !== "run.stop"
  ) {
    throw new Error(`Unsupported runtime replica request: ${String(parsed.type)}`);
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    throw new Error("Invalid runtime.shutdown request: reason must be string");
  }
  if (
    parsed.selectedRunId !== undefined &&
    typeof parsed.selectedRunId !== "string"
  ) {
    throw new Error("Invalid project.snapshot request: selectedRunId must be string");
  }
  if (parsed.task !== undefined && typeof parsed.task !== "string") {
    throw new Error("Invalid run.create request: task must be string");
  }
  if (parsed.type === "run.resume") {
    if (typeof parsed.runId !== "string" || parsed.runId.length === 0) {
      throw new Error("Invalid run.resume request: runId must be non-empty string");
    }
  } else if (
    parsed.runId !== undefined &&
    typeof parsed.runId !== "string"
  ) {
    throw new Error("Invalid run.stop request: runId must be string");
  }
  return parsed as RuntimeRequest;
}

function parseRuntimeResponse(
  raw: string,
  expectedId?: string,
): RuntimeResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid runtime replica response JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid runtime replica response: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Invalid runtime replica response: schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("Invalid runtime replica response: id must be non-empty");
  }
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error(
      `Invalid runtime replica response: expected id ${expectedId}, got ${parsed.id}`,
    );
  }
  if (typeof parsed.ok !== "boolean" || typeof parsed.type !== "string") {
    throw new Error("Invalid runtime replica response: ok and type are required");
  }
  return parsed as RuntimeResponse;
}

function parseRuntimeReplicaWorkbenchResponse(
  raw: string,
  expectedId?: string,
): WorkbenchResponse {
  const message = parseWorkbenchServerMessage(raw, expectedId);
  if (message.type === "workbench.event") {
    throw new Error("Invalid runtime replica response: expected workbench result or error");
  }
  return message;
}

async function isRuntimeReplicaResponsive(input: {
  socketPath: string;
  timeoutMs: number;
  expectedIdentity?: RuntimeReplicaIdentity;
}): Promise<boolean> {
  try {
    const response = await requestRuntimeReplica({
      socketPath: input.socketPath,
      timeoutMs: input.timeoutMs,
      request: {
        schemaVersion: 1,
        id: "runtime-health-probe",
        type: "runtime.health",
      },
    });
    if (!response.ok || response.type !== "runtime.result") {
      return false;
    }
    return matchesExpectedIdentity(response.data, input.expectedIdentity);
  } catch {
    return false;
  }
}

function classifyProjectUiEdgeRuntimeReplica(input: {
  process: RuntimeProcessRecord;
  projectId: string;
  currentEdgeId: string;
  uiEdgeIdPrefix: string;
  processControl: ProcessControlPort;
}): StaleProjectUiEdgeRuntimeReplica | undefined {
  if (input.process.kind !== "runtime-replica") {
    return undefined;
  }
  const replicaPid =
    typeof input.process.pid === "number" && input.process.pid > 0
      ? input.process.pid
      : undefined;
  const closedRecord =
    input.process.status === "exited" || input.process.status === "crashed";
  if (
    closedRecord &&
    (replicaPid === undefined || !input.processControl.isAlive(replicaPid))
  ) {
    return undefined;
  }
  if (
    input.process.owner.scope !== "project" ||
    input.process.owner.projectId !== input.projectId
  ) {
    return undefined;
  }

  const edgeId = runtimeReplicaEdgeId(input.process);
  if (!edgeId || edgeId === input.currentEdgeId) {
    return undefined;
  }
  if (!edgeId.startsWith(input.uiEdgeIdPrefix)) {
    return undefined;
  }

  const ownerPid = Number.parseInt(edgeId.slice(input.uiEdgeIdPrefix.length), 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    return undefined;
  }
  if (input.processControl.isAlive(ownerPid)) {
    return undefined;
  }

  return {
    processId: input.process.id,
    edgeId,
    ownerPid,
    ...(replicaPid !== undefined ? { replicaPid } : {}),
    ...(runtimeReplicaSocketPath(input.process)
      ? { socketPath: runtimeReplicaSocketPath(input.process)! }
      : {}),
  };
}

function runtimeReplicaEdgeId(
  process: RuntimeProcessRecord,
): string | undefined {
  const metadataEdgeId = process.metadata?.edgeId;
  if (typeof metadataEdgeId === "string" && metadataEdgeId.length > 0) {
    return metadataEdgeId;
  }
  const prefix = "runtime-replica:edge:";
  return process.id.startsWith(prefix) ? process.id.slice(prefix.length) : undefined;
}

function runtimeReplicaSocketPath(
  process: RuntimeProcessRecord,
): string | undefined {
  const socketPath = process.metadata?.socketPath;
  return typeof socketPath === "string" && socketPath.length > 0
    ? socketPath
    : undefined;
}

async function requestStaleRuntimeReplicaShutdown(input: {
  socketPath?: string;
  timeoutMs: number;
  requestId: string;
}): Promise<boolean> {
  if (!input.socketPath) {
    return false;
  }
  try {
    const response = await requestRuntimeReplica({
      socketPath: input.socketPath,
      timeoutMs: input.timeoutMs,
      request: {
        schemaVersion: 1,
        id: input.requestId,
        type: "runtime.shutdown",
        reason: "orphaned_project_ui",
      },
    });
    return response.ok && response.type === "runtime.shutdown.result";
  } catch {
    return false;
  }
}

async function waitForPidExit(input: {
  pid: number;
  processControl: ProcessControlPort;
  timeoutMs: number;
  pollIntervalMs: number;
  wait: (ms: number) => Promise<void>;
  nowEpochMs: () => number;
}): Promise<boolean> {
  const deadline = input.nowEpochMs() + input.timeoutMs;
  while (input.nowEpochMs() <= deadline) {
    if (!input.processControl.isAlive(input.pid)) {
      return true;
    }
    await input.wait(input.pollIntervalMs);
  }
  return !input.processControl.isAlive(input.pid);
}

function markRuntimeReplicaCleanupCrashed(
  process: RuntimeProcessRecord,
  input: {
    now: string;
    exitCode?: number | null;
    signal?: string | null;
    message?: string;
  },
): RuntimeProcessRecord {
  if (process.status !== "exited" && process.status !== "crashed") {
    return markProcessCrashed(process, input);
  }
  return {
    ...process,
    status: "crashed",
    updatedAt: input.now,
    exit: {
      exitedAt: input.now,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      message: input.message,
    },
  };
}

function parseRuntimeReplicaCliOptions(argv: string[]): {
  socketPath?: string;
  stateRoot?: string;
  identity?: RuntimeReplicaIdentity;
} {
  const options: {
    socketPath?: string;
    stateRoot?: string;
    mode?: string;
    runId?: string;
    edgeId?: string;
    identity?: RuntimeReplicaIdentity;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === "--socket" && value) {
      options.socketPath = value;
      index += 1;
    } else if (arg === "--state-dir" && value) {
      options.stateRoot = value;
      index += 1;
    } else if (arg === "--mode" && value) {
      options.mode = value;
      index += 1;
    } else if (arg === "--run-id" && value) {
      options.runId = value;
      index += 1;
    } else if (arg === "--edge-id" && value) {
      options.edgeId = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete runtime replica option: ${arg}`);
    }
  }
  if (options.mode === "run" && options.runId && !options.edgeId) {
    options.identity = { mode: "run", runId: options.runId };
  } else if (options.mode === "edge" && options.edgeId && !options.runId) {
    options.identity = { mode: "edge", edgeId: options.edgeId };
  } else if (options.mode !== undefined || options.runId !== undefined || options.edgeId !== undefined) {
    throw new Error(
      "Runtime replica requires --mode run with --run-id, or --mode edge with --edge-id",
    );
  }
  return options;
}

function createRuntimeEventIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${Date.now()}-${++sequence}`;
}

function parseRuntimeArgs(argv: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = value;
      index += 1;
    }
  }
  return { flags, positional };
}

function runtimeUsage(): string {
  return (
    "Usage: tiny-agent runtime <replica|health|capabilities|shutdown> [options]\n" +
    "  tiny-agent runtime replica --mode run --run-id <runId> --socket <path> --state-dir <dir>\n" +
    "  tiny-agent runtime replica --mode edge --edge-id <edgeId> --socket <path> --state-dir <dir>\n" +
    "  tiny-agent runtime health --runtime-host-socket <path>\n" +
    `  ${RUNTIME_HOST_SOCKET_ENV}=<path> tiny-agent runtime capabilities\n`
  );
}

async function waitForSocket(input: {
  child: SpawnedProcessPort;
  socketPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  nowEpochMs: () => number;
  wait: (ms: number) => Promise<void>;
  isSocketReady: (socketPath: string) => boolean;
}): Promise<void> {
  const deadline = input.nowEpochMs() + input.timeoutMs;
  while (input.nowEpochMs() <= deadline) {
    if (input.isSocketReady(input.socketPath)) {
      return;
    }
    if (input.child.exitCode !== null && input.child.exitCode !== undefined) {
      throw new Error(
        `Runtime replica exited before socket was ready: ${input.socketPath}`,
      );
    }
    await input.wait(input.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for runtime replica socket: ${input.socketPath}`);
}

function isSocketPathReady(socketPath: string): boolean {
  try {
    return fs.lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function killChild(child: SpawnedProcessPort): void {
  if (!child.killed && child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

async function closeLogStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.once("error", () => resolve());
    stream.end(() => resolve());
  });
}

function assertSocketPathBudget(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > RESIDENT_HOST_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Runtime replica socket path is ${byteLength} bytes, exceeding ${RESIDENT_HOST_SOCKET_PATH_MAX_BYTES} byte budget: ${socketPath}`,
    );
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
  return safe.length > 0 ? safe : "edge";
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
}

function matchesExpectedIdentity(
  data: Record<string, unknown>,
  expected: RuntimeReplicaIdentity | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  if (data.replicaMode !== expected.mode) {
    return false;
  }
  if (expected.mode === "run") {
    return data.runId === expected.runId;
  }
  return data.edgeId === expected.edgeId;
}

function requestIdFromUnknown(value: unknown): string {
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  return "unknown";
}

function runtimeErrorResponse(input: {
  id: string;
  code: "BAD_REQUEST" | "RUNTIME_ERROR";
  message: string;
}): RuntimeResponse {
  return {
    schemaVersion: 1,
    id: input.id,
    ok: false,
    type: "runtime.error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
