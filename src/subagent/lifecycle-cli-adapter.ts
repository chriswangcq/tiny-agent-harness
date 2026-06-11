// Team-scoped lifecycle CLI adapter.
//
// This is the effect boundary for `tiny-agent team lifecycle ...`: it reads durable
// team/supervisor state, wires those facts into the pure runtime
// adapter, and performs real process shutdown through injected ports.

import * as nodeFs from "node:fs/promises";
import process from "node:process";
import { failureEnvelope, successEnvelope, type CliEnvelope } from "../cli/envelope.js";
import {
  applyTeamRosterEvent,
  lookupMember,
  type TeamRosterEvent,
  type TeamMember,
} from "./team-roster.js";
import {
  createTeamDirectorySnapshot,
  planTeamScopedDirectoryLayout,
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
import {
  appendLifecycleEvent,
  planTeamScopedSupervisorPaths,
  readAllLifecycleEvents,
  type SupervisorFsPort,
  type SupervisorLifecycleEvent,
  type SupervisorPorts,
} from "./supervisor-store.js";

const TOOL_NAME = "team";
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 300_000;

export const LIFECYCLE_HELP = `Usage: tiny-agent team lifecycle <subcommand> [options]

Lifecycle subcommands:
  lifecycle-status <workerId>       Show worker lifecycle and lease status
  lease <workerId>                  Record heartbeat and acquire/renew lease
  reaper                            Plan stale-worker shutdowns; dry-run by default
  shutdown <workerId>               Request one worker shutdown

Options:
  --team <teamId>                   Target team id (required)
  --run <runId>                     Optional execution run id fact
  --expiry-ms <ms>                  Lease duration for lease
  --threshold-ms <ms>               Stale heartbeat threshold
  --execute                         Execute reaper/shutdown process effects
  --reason <text>                   Shutdown reason
  --idempotency-key <key>           Stable event idempotency key
  --json                            Output JSON envelope (default)`;

export type LifecycleAdapterFsPort = FsPort & SupervisorFsPort;

export type LifecycleCliAdapterPorts = {
  fs: LifecycleAdapterFsPort;
  nowIso: () => string;
  newEventId: (prefix: string, seed: string) => string;
  readWorkerPid?: (input: {
    stateRoot: string;
    teamId: string;
    memberId: string;
    runId?: string;
  }) => Promise<number | undefined>;
  shutdownProcess?: (
    pid: number,
    workerId: string,
    reason?: string,
  ) => Promise<void>;
  checkProcessExists?: (input: {
    stateRoot: string;
    teamId: string;
    memberId: string;
    runId?: string;
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
      teamId?: string;
      runId?: string;
      workerId: string;
      staleThresholdMs: number;
    }
  | {
      kind: "lease";
      teamId?: string;
      runId?: string;
      workerId: string;
      leaseDurationMs: number;
      idempotencyKey?: string;
    }
  | {
      kind: "reaper";
      teamId?: string;
      runId?: string;
      staleThresholdMs: number;
      execute: boolean;
    }
  | {
      kind: "shutdown";
      teamId?: string;
      runId?: string;
      workerId: string;
      reason: string;
      execute: boolean;
    };

type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; errorCode: string; error: string; helpText?: string };

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
      ...(parsed.helpText ? { details: { helpText: parsed.helpText } } : {}),
    });
  }

  try {
    const teamId = parsed.command.teamId;
    if (!teamId) {
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd: options.cwd,
        errorCode: "TEAM_ID_REQUIRED",
        error: "Missing --team <teamId>; lifecycle state is stored under teams/<teamId>/",
      });
    }
    const runId = parsed.command.runId;
    const context = await loadLifecycleContext(
      ports,
      options.stateRoot,
      teamId,
      runId,
    );
    const adapter = createRuntimeAdapter(
      createRuntimePorts(ports, options.stateRoot, teamId, runId, context),
    );

    switch (parsed.command.kind) {
      case "lifecycle-status": {
        const worker = lookupMemberOrThrow(context.roster, parsed.command.workerId);
        const facts = await adapter.enumerateWorkers(context.snapshot, {
          now: ports.nowIso(),
          staleThresholdMs: parsed.command.staleThresholdMs,
        });
        const fact = facts.workers.find((item) => item.workerId === worker.memberId);
        return successEnvelope({
          tool: TOOL_NAME,
          cwd: options.cwd,
          extra: {
            command: "lifecycle-status",
            teamId,
            runId,
            workerId: worker.memberId,
            worker,
            fact,
          },
        });
      }

      case "lease": {
        const worker = lookupMemberOrThrow(context.roster, parsed.command.workerId);
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
            teamId,
            runId,
            workerId: worker.memberId,
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
            teamId,
            runId,
            envelope,
          },
        });
      }

      case "shutdown": {
        const worker = lookupMemberOrThrow(context.roster, parsed.command.workerId);
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
            teamId,
            runId,
            workerId: worker.memberId,
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
      helpText: LIFECYCLE_HELP,
    };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return usage(LIFECYCLE_HELP);
  }

  const subcommand = args[0];
  const rest = args.slice(1);
  const common = parseCommonFlags(rest);
  if (!common.ok) return common;

  switch (subcommand) {
    case "lifecycle-status": {
      if (!common.positionals[0]) {
        return usage("Usage: tiny-agent team lifecycle lifecycle-status <workerId> --team <teamId> [--run <runId>]");
      }
      return {
        ok: true,
        command: {
          kind: "lifecycle-status",
          teamId: common.teamId,
          runId: common.runId,
          workerId: common.positionals[0],
          staleThresholdMs: common.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
        },
      };
    }
    case "lease": {
      if (!common.positionals[0]) {
        return usage("Usage: tiny-agent team lifecycle lease <workerId> --team <teamId> [--run <runId>] [--expiry-ms <ms>]");
      }
      return {
        ok: true,
        command: {
          kind: "lease",
          teamId: common.teamId,
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
          teamId: common.teamId,
          runId: common.runId,
          staleThresholdMs: common.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
          execute: common.execute,
        },
      };
    case "shutdown": {
      if (!common.positionals[0]) {
        return usage("Usage: tiny-agent team lifecycle shutdown <workerId> --team <teamId> [--run <runId>] [--execute] [--reason <text>]");
      }
      return {
        ok: true,
        command: {
          kind: "shutdown",
          teamId: common.teamId,
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
      teamId?: string;
      runId?: string;
      execute: boolean;
      expiryMs?: number;
      staleThresholdMs?: number;
      reason?: string;
      idempotencyKey?: string;
    }
  | { ok: false; errorCode: string; error: string } {
  const positionals: string[] = [];
  let teamId: string | undefined;
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
    if (arg === "--team") {
      teamId = requiredValue(args, i, "--team");
      i += 1;
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
    teamId,
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

async function loadLifecycleContext(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  teamId: string,
  runId: string | undefined,
): Promise<{
  roster: TeamDirectorySnapshot["roster"];
  supervisorEvents: SupervisorLifecycleEvent[];
  snapshot: TeamSnapshot;
  teamLayout: TeamDirectoryLayout;
  supervisorPorts: SupervisorPorts;
}> {
  const teamLayout = planTeamScopedDirectoryLayout(stateRoot, teamId);
  const supervisorPaths = planTeamScopedSupervisorPaths(stateRoot, teamId);
  const supervisorPorts: SupervisorPorts = {
    fs: ports.fs,
    clock: { now: ports.nowIso },
  };
  const teamSnapshot = await readTeamDirectory(ports.fs, teamLayout);
  const events = await readAllLifecycleEvents(supervisorPorts, supervisorPaths);

  const snapshot: TeamSnapshot = {
    rosterState: teamSnapshot.roster,
    supervisorEvents: events.validEvents,
    createdAt: teamSnapshot.createdAt,
    runId: runId ?? `team:${teamId}`,
  };

  // Populate per-worker process existence from team-scoped member state files.
  const processExistence: Record<string, boolean> = {};
  for (const [memberId, member] of Object.entries(teamSnapshot.roster.members)) {
    processExistence[memberId] = await resolveProcessExistence(
      ports,
      stateRoot,
      teamId,
      memberId,
      member.runId ?? runId,
    );
  }
  if (Object.keys(processExistence).length > 0) {
    snapshot.processExistence = processExistence;
  }

  return {
    roster: teamSnapshot.roster,
    supervisorEvents: events.validEvents,
    snapshot,
    teamLayout,
    supervisorPorts,
  };
}

function createRuntimePorts(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  teamId: string,
  runId: string | undefined,
  context: {
    teamLayout: TeamDirectoryLayout;
    supervisorPorts: SupervisorPorts;
    roster: TeamDirectorySnapshot["roster"];
  },
): LifecycleRuntimePorts {
  const supervisorPaths = planTeamScopedSupervisorPaths(stateRoot, teamId);
  return {
    nowIso: ports.nowIso,
    generateId: ports.newEventId,
    appendSupervisorEvent: (event) =>
      appendLifecycleEvent(context.supervisorPorts, supervisorPaths, event),
    shutdownWorker: async (workerId, reason) => {
      const member = context.roster.members[workerId];
      const workerRunId = member?.runId ?? runId;
      const pid = ports.readWorkerPid
        ? await ports.readWorkerPid({
            stateRoot,
            teamId,
            memberId: workerId,
            runId: workerRunId,
          })
        : await readWorkerPidFromState(ports.fs, stateRoot, teamId, workerId);
      if (pid === undefined) {
        throw new Error(`Missing worker pid for ${workerId}`);
      }
      const shutdown = ports.shutdownProcess ?? defaultShutdownProcess;
      await shutdown(pid, workerId, reason);
      // Write terminal state back to the team-scoped member state file.
      const workerStateFile = teamMemberStateFile(stateRoot, teamId, workerId);
      try {
        const raw = await ports.fs.readFile(workerStateFile);
        const current = JSON.parse(raw) as Record<string, unknown>;
        const next = { ...current, status: "terminated", endedAt: ports.nowIso(), exitSignal: "SIGTERM" };
        await ports.fs.writeFile(workerStateFile, JSON.stringify(next, null, 2));
      } catch {
        // State file absent or unparseable -- keep shutdown success; do not hide it.
      }
    },
    applyContactEvent: async (event: TeamRosterEvent) => {
      const snapshot = await readTeamDirectory(ports.fs, context.teamLayout);
      const result = applyTeamRosterEvent(snapshot.roster, event);
      if (result.status === "rejected") {
        throw new Error(
          `Roster event rejected: ${result.rejection.code}: ${result.rejection.message}`,
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
 * Resolve process existence for a worker by reading its team-scoped member state file.
 *
 * Terminal state (exited/terminated) => false.
 * Missing/unparseable state or missing pid => true (backward compatible default).
 * Running state with pid => use injected checkProcessExists if provided, else true.
 */
async function resolveProcessExistence(
  ports: LifecycleCliAdapterPorts,
  stateRoot: string,
  teamId: string,
  memberId: string,
  runId: string | undefined,
): Promise<boolean> {
  const workerStateFile = teamMemberStateFile(stateRoot, teamId, memberId);
  let raw: string;
  try {
    raw = await ports.fs.readFile(workerStateFile);
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
      return await ports.checkProcessExists({
        stateRoot,
        teamId,
        memberId,
        runId,
        pid,
      });
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
  teamId: string,
  memberId: string,
): Promise<number | undefined> {
  const workerStateFile = teamMemberStateFile(stateRoot, teamId, memberId);
  let raw: string;
  try {
    raw = await fs.readFile(workerStateFile);
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

function teamMemberStateFile(
  stateRoot: string,
  teamId: string,
  memberId: string,
): string {
  const layout = planTeamScopedDirectoryLayout(stateRoot, teamId);
  return `${layout.membersDir}/${memberId}/state.json`;
}

async function defaultShutdownProcess(
  pid: number,
  _workerId: string,
  _reason?: string,
): Promise<void> {
  process.kill(pid, "SIGTERM");
}

function lookupMemberOrThrow(
  roster: TeamDirectorySnapshot["roster"],
  workerId: string,
): TeamMember {
  const worker = lookupMember(roster, workerId);
  if (!worker) {
    throw Object.assign(new Error(`Unknown worker: "${workerId}"`), {
      code: "UNKNOWN_WORKER",
    });
  }
  return worker;
}

function usage(error: string): ParseResult {
  return { ok: false, errorCode: "USAGE", error, helpText: LIFECYCLE_HELP };
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
