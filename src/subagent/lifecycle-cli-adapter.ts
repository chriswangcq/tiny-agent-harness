// Run-scoped lifecycle CLI adapter.
//
// This is the effect boundary for `team lifecycle ...`: it reads durable
// run-scoped team/supervisor state, wires those facts into the pure runtime
// adapter, and performs real process shutdown through injected ports.

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { failureEnvelope, successEnvelope, type CliEnvelope } from "../cli/envelope.js";
import {
  applyContactRegistryEvent,
  lookupWorker,
  type ContactRegistryEvent,
  type WorkerContact,
} from "./contact-registry.js";
import {
  createTeamDirectorySnapshot,
  planRunScopedTeamPaths,
  readTeamDirectory,
  writeTeamDirectory,
  type FsPort,
  type TeamDirectoryLayout,
  type TeamDirectorySnapshot,
} from "./directory-store.js";
import {
  createRuntimeAdapter,
  type LifecycleRuntimePorts,
  type TeamSnapshot,
} from "./lifecycle-runtime-adapter.js";
import { planRunScopedWorkerPaths } from "./local-worker-launcher.js";
import {
  appendLifecycleEvent,
  planRunScopedSupervisorPaths,
  readAllLifecycleEvents,
  type SupervisorFsPort,
  type SupervisorLifecycleEvent,
  type SupervisorPorts,
} from "./supervisor-store.js";

const TOOL_NAME = "team";
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 300_000;

export type LifecycleAdapterFsPort = FsPort & SupervisorFsPort;

export type LifecycleCliAdapterPorts = {
  fs: LifecycleAdapterFsPort;
  nowIso: () => string;
  newEventId: (prefix: string, seed: string) => string;
  listRunIds?: (stateRoot: string) => Promise<string[]>;
  readWorkerPid?: (input: {
    stateRoot: string;
    runId: string;
    workerId: string;
  }) => Promise<number | undefined>;
  shutdownProcess?: (
    pid: number,
    workerId: string,
    reason?: string,
  ) => Promise<void>;
  checkProcessExists?: (input: {
    stateRoot: string;
    runId: string;
    workerId: string;
    pid: number;
  }) => Promise<boolean>;
};

export type ExecuteLifecycleAdapterOptions = {
  stateRoot: string;
  cwd?: string;
};

type ParsedCommand =
  | {
      kind: "lifecycle-status";
      runId?: string;
      workerId: string;
      staleThresholdMs: number;
    }
  | {
      kind: "lease";
      runId?: string;
      workerId: string;
      leaseDurationMs: number;
      idempotencyKey?: string;
    }
  | {
      kind: "reaper";
      runId?: string;
      staleThresholdMs: number;
      execute: boolean;
    }
  | {
      kind: "shutdown";
      runId?: string;
      workerId: string;
      reason: string;
      execute: boolean;
    };

type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; errorCode: string; error: string };

export async function executeLifecycleAdapterCommand(
  ports: LifecycleCliAdapterPorts,
  args: string[],
  options: ExecuteLifecycleAdapterOptions,
): Promise<CliEnvelope> {
  let parsed: ParseResult;
  try {
    parsed = parseLifecycleAdapterArgs(args);
  } catch (error) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: classifyError(error),
      error: formatError(error),
    });
  }
  if (!parsed.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: parsed.errorCode,
      error: parsed.error,
    });
  }

  try {
    const runId = await resolveRunId(ports, options.stateRoot, parsed.command.runId);
    const context = await loadLifecycleContext(ports, options.stateRoot, runId);
    const adapter = createRuntimeAdapter(
      createRuntimePorts(ports, options.stateRoot, runId, context),
    );

    switch (parsed.command.kind) {
      case "lifecycle-status": {
        const worker = lookupWorkerOrThrow(context.registry, parsed.command.workerId);
        const facts = await adapter.enumerateWorkers(context.snapshot, {
          now: ports.nowIso(),
          staleThresholdMs: parsed.command.staleThresholdMs,
        });
        const fact = facts.workers.find((item) => item.workerId === worker.workerId);
        return successEnvelope({
          tool: TOOL_NAME,
          cwd: options.cwd,
          extra: {
            command: "lifecycle-status",
            runId,
            workerId: worker.workerId,
            worker,
            fact,
          },
        });
      }

      case "lease": {
        const worker = lookupWorkerOrThrow(context.registry, parsed.command.workerId);
        const envelope = await adapter.recordHeartbeat(
          worker,
          context.supervisorEvents,
          {
            heartbeatNow: ports.nowIso(),
            leaseDurationMs: parsed.command.leaseDurationMs,
            idempotencyKey: parsed.command.idempotencyKey,
          },
        );
        if (envelope.status === "error") {
          return failureEnvelope({
            tool: TOOL_NAME,
            cwd: options.cwd,
            errorCode: envelope.errorCode ?? "LEASE_FAILED",
            error: envelope.error ?? "Failed to record lifecycle lease",
            details: envelope,
          });
        }
        return successEnvelope({
          tool: TOOL_NAME,
          cwd: options.cwd,
          extra: {
            command: "lease",
            runId,
            workerId: worker.workerId,
            envelope,
          },
        });
      }

      case "reaper": {
        const envelope = await adapter.runReaper(context.snapshot, {
          now: ports.nowIso(),
          staleThresholdMs: parsed.command.staleThresholdMs,
          execute: parsed.command.execute,
        });
        if (envelope.status === "error") {
          return failureEnvelope({
            tool: TOOL_NAME,
            cwd: options.cwd,
            errorCode: envelope.errorCode ?? "REAPER_FAILED",
            error: envelope.error ?? "Lifecycle reaper failed",
            details: envelope,
          });
        }
        return successEnvelope({
          tool: TOOL_NAME,
          cwd: options.cwd,
          extra: {
            command: "reaper",
            runId,
            envelope,
          },
        });
      }

      case "shutdown": {
        const worker = lookupWorkerOrThrow(context.registry, parsed.command.workerId);
        const envelope = await adapter.requestShutdown(worker, {
          now: ports.nowIso(),
          reason: parsed.command.reason,
          execute: parsed.command.execute,
        });
        if (envelope.status === "error") {
          return failureEnvelope({
            tool: TOOL_NAME,
            cwd: options.cwd,
            errorCode: envelope.errorCode ?? "SHUTDOWN_FAILED",
            error: envelope.error ?? "Lifecycle shutdown failed",
            details: envelope,
          });
        }
        return successEnvelope({
          tool: TOOL_NAME,
          cwd: options.cwd,
          extra: {
            command: "shutdown",
            runId,
            workerId: worker.workerId,
            envelope,
          },
        });
      }
    }
  } catch (error) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: classifyError(error),
      error: formatError(error),
    });
  }
}

export function createNodeLifecycleCliAdapterPorts(): LifecycleCliAdapterPorts {
  let counter = 0;
  const fs: LifecycleAdapterFsPort = {
    readFile: (filePath) => nodeFs.readFile(filePath, "utf-8"),
    async writeFile(filePath, data) {
      await nodeFs.writeFile(filePath, data, "utf-8");
    },
    async mkdir(dirPath) {
      await nodeFs.mkdir(dirPath, { recursive: true });
    },
    async exists(filePath) {
      try {
        await nodeFs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };

  return createLifecycleCliAdapterPorts({
    fs,
    nowIso: () => new Date().toISOString(),
    newEventId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${Date.now()}-${seed}-${counter}`;
    },
    async listRunIds(stateRoot) {
      const runsDir = path.join(stateRoot, "runs");
      const entries = await nodeFs.readdir(runsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
        .map((entry) => entry.name)
        .sort();
    },
    shutdownProcess: defaultShutdownProcess,
    checkProcessExists: async ({ pid }) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "ESRCH"
        ) {
          return false;
        }
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "EPERM"
        ) {
          // EPERM: process exists but caller lacks permission to signal
          return true;
        }
        throw err;
      }
    },
  });
}

export function createLifecycleCliAdapterPorts(
  ports: LifecycleCliAdapterPorts,
): LifecycleCliAdapterPorts {
  return ports;
}

function parseLifecycleAdapterArgs(args: string[]): ParseResult {
  if (args.length === 0) {
    return {
      ok: false,
      errorCode: "MISSING_SUBCOMMAND",
      error: "Missing lifecycle subcommand. Expected lifecycle-status, lease, reaper, or shutdown.",
    };
  }

  const subcommand = args[0];
  const rest = args.slice(1);
  const common = parseCommonFlags(rest);
  if (!common.ok) return common;

  switch (subcommand) {
    case "lifecycle-status": {
      if (!common.positionals[0]) {
        return usage("Usage: team lifecycle lifecycle-status <workerId> [--run <runId>]");
      }
      return {
        ok: true,
        command: {
          kind: "lifecycle-status",
          runId: common.runId,
          workerId: common.positionals[0],
          staleThresholdMs: common.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
        },
      };
    }
    case "lease": {
      if (!common.positionals[0]) {
        return usage("Usage: team lifecycle lease <workerId> [--run <runId>] [--expiry-ms <ms>]");
      }
      return {
        ok: true,
        command: {
          kind: "lease",
          runId: common.runId,
          workerId: common.positionals[0],
          leaseDurationMs: common.expiryMs ?? DEFAULT_LEASE_DURATION_MS,
          idempotencyKey: common.idempotencyKey,
        },
      };
    }
    case "reaper":
      return {
        ok: true,
        command: {
          kind: "reaper",
          runId: common.runId,
          staleThresholdMs: common.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
          execute: common.execute,
        },
      };
    case "shutdown": {
      if (!common.positionals[0]) {
        return usage("Usage: team lifecycle shutdown <workerId> [--run <runId>] [--execute] [--reason <text>]");
      }
      return {
        ok: true,
        command: {
          kind: "shutdown",
          runId: common.runId,
          workerId: common.positionals[0],
          reason: common.reason ?? "Lifecycle shutdown requested",
          execute: common.execute,
        },
      };
    }
    default:
      return {
        ok: false,
        errorCode: "UNKNOWN_SUBCOMMAND",
        error: `Unknown lifecycle subcommand: "${subcommand}".`,
      };
  }
}

function parseCommonFlags(args: string[]):
  | {
      ok: true;
      positionals: string[];
      runId?: string;
      execute: boolean;
      expiryMs?: number;
      staleThresholdMs?: number;
      reason?: string;
      idempotencyKey?: string;
    }
  | { ok: false; errorCode: string; error: string } {
  const positionals: string[] = [];
  let runId: string | undefined;
  let execute = false;
  let expiryMs: number | undefined;
  let staleThresholdMs: number | undefined;
  let reason: string | undefined;
  let idempotencyKey: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--run") {
      runId = requiredValue(args, i, "--run");
      i += 1;
      continue;
    }
    if (arg === "--expiry-ms" || arg === "--lease-duration-ms") {
      const value = requiredValue(args, i, arg);
      expiryMs = parsePositiveInt(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--threshold-ms" || arg === "--stale-threshold-ms") {
      const value = requiredValue(args, i, arg);
      staleThresholdMs = parsePositiveInt(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = requiredValue(args, i, "--reason");
      i += 1;
      continue;
    }
    if (arg === "--idempotency-key") {
      idempotencyKey = requiredValue(args, i, "--idempotency-key");
      i += 1;
      continue;
    }
    if (arg?.startsWith("--")) {
      return { ok: false, errorCode: "UNKNOWN_FLAG", error: `Unknown flag: ${arg}` };
    }
    if (arg) positionals.push(arg);
  }

  return {
    ok: true,
    positionals,
    runId,
    execute,
    expiryMs,
    staleThresholdMs,
    reason,
    idempotencyKey,
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

async function resolveRunId(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  runId: string | undefined,
): Promise<string> {
  if (runId && runId !== "latest") return runId;
  if (!ports.listRunIds) {
    throw new Error("Missing run id and no listRunIds port was provided");
  }
  const runIds = await ports.listRunIds(stateRoot);
  const latest = [...runIds].sort().at(-1);
  if (!latest) {
    throw new Error(`No run directories found under ${path.join(stateRoot, "runs")}`);
  }
  return latest;
}

async function loadLifecycleContext(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  runId: string,
): Promise<{
  registry: TeamDirectorySnapshot["registry"];
  supervisorEvents: SupervisorLifecycleEvent[];
  snapshot: TeamSnapshot;
  teamLayout: TeamDirectoryLayout;
  supervisorPorts: SupervisorPorts;
}> {
  const runTeamPaths = planRunScopedTeamPaths(stateRoot, runId);
  const teamLayout: TeamDirectoryLayout = {
    teamDir: runTeamPaths.runTeamDir,
    registryFile: runTeamPaths.runRegistryFile,
    eventsFile: runTeamPaths.runEventsFile,
    runsDir: path.join(stateRoot, "runs"),
  };
  const supervisorPaths = planRunScopedSupervisorPaths(stateRoot, runId);
  const supervisorPorts: SupervisorPorts = {
    fs: ports.fs,
    clock: { now: ports.nowIso },
  };
  const teamSnapshot = await readTeamDirectory(ports.fs, teamLayout);
  const events = await readAllLifecycleEvents(supervisorPorts, supervisorPaths);

  const snapshot: TeamSnapshot = {
    registryState: teamSnapshot.registry,
    supervisorEvents: events.validEvents,
    createdAt: teamSnapshot.createdAt,
    runId,
  };

  // Populate per-worker process existence from run-scoped worker state files.
  const processExistence: Record<string, boolean> = {};
  for (const [workerId, worker] of Object.entries(teamSnapshot.registry.workers)) {
    processExistence[workerId] = await resolveProcessExistence(
      ports,
      stateRoot,
      runId,
      workerId,
    );
  }
  if (Object.keys(processExistence).length > 0) {
    snapshot.processExistence = processExistence;
  }

  return {
    registry: teamSnapshot.registry,
    supervisorEvents: events.validEvents,
    snapshot,
    teamLayout,
    supervisorPorts,
  };
}

function createRuntimePorts(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  runId: string,
  context: {
    teamLayout: TeamDirectoryLayout;
    supervisorPorts: SupervisorPorts;
  },
): LifecycleRuntimePorts {
  const supervisorPaths = planRunScopedSupervisorPaths(stateRoot, runId);
  return {
    nowIso: ports.nowIso,
    generateId: ports.newEventId,
    appendSupervisorEvent: (event) =>
      appendLifecycleEvent(context.supervisorPorts, supervisorPaths, event),
    shutdownWorker: async (workerId, reason) => {
      const pid = ports.readWorkerPid
        ? await ports.readWorkerPid({ stateRoot, runId, workerId })
        : await readWorkerPidFromState(ports.fs, stateRoot, runId, workerId);
      if (pid === undefined) {
        throw new Error(`Missing worker pid for ${workerId}`);
      }
      const shutdown = ports.shutdownProcess ?? defaultShutdownProcess;
      await shutdown(pid, workerId, reason);
      // Write terminal state back to the run-scoped worker state file.
      const workerPaths = planRunScopedWorkerPaths(stateRoot, runId, workerId);
      try {
        const raw = await ports.fs.readFile(workerPaths.runWorkerStateFile);
        const current = JSON.parse(raw) as Record<string, unknown>;
        const next = { ...current, status: "terminated", endedAt: ports.nowIso(), exitSignal: "SIGTERM" };
        await ports.fs.writeFile(workerPaths.runWorkerStateFile, JSON.stringify(next, null, 2));
      } catch {
        // State file absent or unparseable -- keep shutdown success; do not hide it.
      }
    },
    applyContactEvent: async (event: ContactRegistryEvent) => {
      const snapshot = await readTeamDirectory(ports.fs, context.teamLayout);
      const result = applyContactRegistryEvent(snapshot.registry, event);
      if (result.status === "rejected") {
        throw new Error(
          `Contact event rejected: ${result.rejection.code}: ${result.rejection.message}`,
        );
      }
      const nextSnapshot = createTeamDirectorySnapshot(
        result.state,
        ports.nowIso(),
        snapshot.createdAt,
      );
      await writeTeamDirectory(ports.fs, context.teamLayout, nextSnapshot);
      return result.status;
    },
  };
}

/**
 * Resolve process existence for a worker by reading its run-scoped state file.
 *
 * Terminal state (exited/terminated) => false.
 * Missing/unparseable state or missing pid => true (backward compatible default).
 * Running state with pid => use injected checkProcessExists if provided, else true.
 */
async function resolveProcessExistence(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  runId: string,
  workerId: string,
): Promise<boolean> {
  const workerPaths = planRunScopedWorkerPaths(stateRoot, runId, workerId);
  let raw: string;
  try {
    raw = await ports.fs.readFile(workerPaths.runWorkerStateFile);
  } catch {
    // Missing state file => default true
    return true;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Unparseable state => default true
    return true;
  }

  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  if (status === "exited" || status === "terminated") {
    return false;
  }

  const pid = parsed.pid ?? parsed.spawnedPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    // No valid pid => default true
    return true;
  }

  if (ports.checkProcessExists) {
    try {
      return await ports.checkProcessExists({ stateRoot, runId, workerId, pid });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "ESRCH"
      ) {
        return false;
      }
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "EPERM"
      ) {
        // EPERM: process exists, return true
        return true;
      }
      throw err;
    }
  }

  // No checker port available => default true
  return true;
}


async function readWorkerPidFromState(
  fs: LifecycleAdapterFsPort,
  stateRoot: string,
  runId: string,
  workerId: string,
): Promise<number | undefined> {
  const workerPaths = planRunScopedWorkerPaths(stateRoot, runId, workerId);
  let raw: string;
  try {
    raw = await fs.readFile(workerPaths.runWorkerStateFile);
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Skip if the process has already reached a terminal state.
  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  if (status === "exited" || status === "terminated") return undefined;
  const pid = parsed.pid ?? parsed.spawnedPid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0
    ? pid
    : undefined;
}

async function defaultShutdownProcess(
  pid: number,
  _workerId: string,
  _reason?: string,
): Promise<void> {
  process.kill(pid, "SIGTERM");
}

function lookupWorkerOrThrow(
  registry: TeamDirectorySnapshot["registry"],
  workerId: string,
): WorkerContact {
  const worker = lookupWorker(registry, workerId);
  if (!worker) {
    throw Object.assign(new Error(`Unknown worker: "${workerId}"`), {
      code: "UNKNOWN_WORKER",
    });
  }
  return worker;
}

function usage(error: string): ParseResult {
  return { ok: false, errorCode: "USAGE", error };
}

function classifyError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (error instanceof Error && error.message.startsWith("Missing value for")) {
    return "USAGE";
  }
  return "ADAPTER_ERROR";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
