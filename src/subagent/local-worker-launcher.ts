// Local worker launcher domain — pure types and functions for planning
// and executing a local tiny-agent worker launch behind explicit ports.
//
// No IO, no side effects, no hidden Date/fs/process/env/cwd/network.
// Real side effects enter through explicit port interfaces.

import type {
  TeamMember,
  TeamRosterState,
  TeamRosterEvent,
  TeamRosterResult,
} from "./team-roster.js";
import {
  planTeamRunReferencePath,
  planTeamScopedDirectoryLayout,
} from "./directory-store.js";
import {
  createRuntimeProcess,
  markProcessRunning,
  type RuntimeProcessRecord,
} from "../runtime/process-registry.js";

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Canonical worker launch paths used by the active launcher. */
export type WorkerLaunchPaths = {
  /** Directory for team member worker state. */
  workerDir: string;
  /** Worker state JSON file path. */
  workerStateFile: string;
  /** Worker output log file path. */
  workerLogFile: string;
  /** Team-owned run reference file path, when available. */
  runRefFile?: string;
};

/** Active team-scoped worker paths under teams/<teamId>/. */
export type TeamScopedWorkerPaths = WorkerLaunchPaths & {
  teamId: string;
  memberId: string;
  runId: string;
  /** Directory for team member state under teams/<teamId>/members/<memberId>/ */
  teamMemberDir: string;
  /** Team member worker state JSON file path. */
  teamMemberStateFile: string;
  /** Team member output log file path. */
  teamMemberLogFile: string;
  /** Team-owned reference to the agent run created for this member. */
  teamRunRefFile: string;
};

/**
 * Compute active team-scoped worker paths.
 * Worker/member state lives under teams/<teamId>/members/<memberId>/,
 * while the run reference lives under teams/<teamId>/runs/<runId>.json.
 * Pure — no IO, no side effects.
 */
export function planTeamScopedWorkerPaths(
  stateRoot: string,
  teamId: string,
  memberId: string,
  runId: string,
): TeamScopedWorkerPaths {
  const layout = planTeamScopedDirectoryLayout(stateRoot, teamId);
  const runRef = planTeamRunReferencePath(stateRoot, teamId, runId);
  const teamMemberDir = `${layout.membersDir}/${memberId}`;
  const teamMemberStateFile = `${teamMemberDir}/state.json`;
  const teamMemberLogFile = `${teamMemberDir}/output.log`;
  return {
    teamId,
    memberId,
    runId,
    workerDir: teamMemberDir,
    workerStateFile: teamMemberStateFile,
    workerLogFile: teamMemberLogFile,
    runRefFile: runRef.runRefFile,
    teamMemberDir,
    teamMemberStateFile,
    teamMemberLogFile,
    teamRunRefFile: runRef.runRefFile,
  };
}

// ---------------------------------------------------------------------------
// Port types
// ---------------------------------------------------------------------------

/** Spawn result from a process port. */
export type SpawnResult = {
  pid: number;
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Git checkout result. */
export type GitCheckoutResult = {
  success: boolean;
  branch: string;
  error?: string;
};

/** Clock port — explicit time source. */
export type Clock = {
  nowISO(): string;
};

/** IdGenerator port — explicit id source. */
export type IdGenerator = {
  newId(): string;
};

/** Spawn port — explicit interface for process spawning. */
export type SpawnPort = {
  spawn: (
    command: string,
    args: string[],
    cwd: string,
  ) => Promise<SpawnResult>;
};

/** Git port — explicit interface for git operations. */
export type GitPort = {
  checkout: (cwd: string, branch: string) => Promise<GitCheckoutResult>;
};

/** Roster store port — read/write for team member events. */
export type RosterStorePort = {
  /** Load current team roster state. */
  load: () => Promise<TeamRosterState>;
  /** Persist a roster event and return updated state. */
  apply: (event: TeamRosterEvent) => Promise<TeamRosterResult>;
};

/** Durable process state written for reaper/shutdown lookup. */
export type WorkerProcessState = {
  workerId: string;
  teamId?: string;
  memberId?: string;
  runId: string;
  assignmentId?: string;
  pid: number;
  spawnedPid: number;
  status: "running" | "exited" | "terminated";
  /** ISO timestamp when the process ended (terminal states only). */
  endedAt?: string;
  /** Exit code for "exited" state. */
  exitCode?: number;
  /** Signal for "terminated" state. */
  exitSignal?: string;
  startedAt: string;
  command: string;
  args: string[];
  cwd: string;
};

/** Worker state port — explicit durable state write. */
export type WorkerStatePort = {
  write: (filePath: string, state: WorkerProcessState) => Promise<void>;
};

/** Process registry port — explicit durable process record write. */
export type WorkerProcessRegistryPort = {
  upsert: (record: RuntimeProcessRecord) => Promise<void> | void;
};

/** All effect ports needed to execute a worker launch. */
export type WorkerLaunchEffects = {
  spawn: SpawnPort;
  git: GitPort;
  clock: Clock;
  ids: IdGenerator;
  roster: RosterStorePort;
  workerState: WorkerStatePort;
  processRegistry?: WorkerProcessRegistryPort;
};

/** A spawn command ready for execution by a SpawnPort. */
export type WorkerSpawnCommand = {
  command: string;
  args: string[];
};

// ---------------------------------------------------------------------------
// Launch plan types
// ---------------------------------------------------------------------------

/** Input parameters for planning a worker launch. */
export type WorkerLaunchParams = {
  /** Product state root directory (for team-scoped path computation) */
  stateRoot: string;
  /** Team workflow id that owns this member run */
  teamId: string;
  /** Team member id that owns this run */
  memberId: string;
  /** Agent run id */
  runId: string;
  /** Optional team assignment id that caused the run */
  assignmentId?: string;
  /** Unique worker identifier */
  workerId: string;
  /** Workspace directory for the worker */
  workspace: string;
  /** Git branch for the worker */
  branch: string;
  /** IM channel for worker communication */
  channel: string;
  /** Human-readable task prompt for the worker */
  taskPrompt: string;
  /** Worker role (coder, reviewer, etc.) */
  role: string;
  /** Allowed action categories */
  allowedActions: string[];
  /** Explicit ISO timestamp — no hidden new Date() */
  now: string;
};

/** A complete worker launch plan with all computed fields. */
export type WorkerLaunchPlan = {
  workerId: string;
  teamId: string;
  memberId: string;
  runId: string;
  assignmentId?: string;
  stateRoot: string;
  workspace: string;
  branch: string;
  channel: string;
  role: string;
  allowedActions: string[];
  taskPrompt: string;
  createdAt: string;
  /** Active team-scoped worker paths */
  paths: TeamScopedWorkerPaths;
  /** Command to spawn the worker process */
  spawnCommand: WorkerSpawnCommand;
};

// ---------------------------------------------------------------------------
// Launch planner — pure function
// ---------------------------------------------------------------------------

/**
 * Plan a worker launch from explicit input parameters.
 * Computes team-scoped paths and builds the spawn command.
 * Pure — no IO, no side effects, no hidden dependencies.
 */
export function planWorkerLaunch(
  params: WorkerLaunchParams,
): WorkerLaunchPlan {
  const paths = planTeamScopedWorkerPaths(
    params.stateRoot,
    params.teamId,
    params.memberId,
    params.runId,
  );

  const plan: WorkerLaunchPlan = {
    workerId: params.workerId,
    teamId: params.teamId,
    memberId: params.memberId,
    runId: params.runId,
    assignmentId: params.assignmentId,
    stateRoot: params.stateRoot,
    workspace: params.workspace,
    branch: params.branch,
    channel: params.channel,
    role: params.role,
    allowedActions: params.allowedActions,
    taskPrompt: params.taskPrompt,
    createdAt: params.now,
    paths,
    spawnCommand: { command: "", args: [] },
  };

  plan.spawnCommand = buildSpawnCommand(plan);

  return plan;
}

// ---------------------------------------------------------------------------
// Command builder — pure function
// ---------------------------------------------------------------------------

/**
 * Build a spawn command for a worker launch plan.
 * The command runs the installed `tiny-agent run` CLI with the worker's
 * task prompt. Public IM binding is owned by run startup, not by a channel arg.
 * Pure — no IO, no side effects.
 */
export function buildSpawnCommand(
  plan: WorkerLaunchPlan,
): WorkerSpawnCommand {
  const args: string[] = [
    "run",
    "--state-dir",
    plan.stateRoot,
  ];

  if (plan.taskPrompt && plan.taskPrompt.length > 0) {
    args.push("--task", plan.taskPrompt);
  }

  return {
    command: "tiny-agent",
    args,
  };
}

// ---------------------------------------------------------------------------
// Launch result types
// ---------------------------------------------------------------------------

/** Stage where a worker launch might fail. */
export type LaunchFailureStage =
  | "checkout"
  | "spawn"
  | "worker_state"
  | "process_registry"
  | "member_add"
  | "member_update"
  | "member_status";

/** Successful worker launch result. */
export type WorkerLaunchSuccess = {
  kind: "launch_success";
  workerId: string;
  runId: string;
  channel: string;
  branch: string;
  workspace: string;
  spawnedPid: number;
  member: TeamMember;
};

/** Failed worker launch result with stage and evidence. */
export type WorkerLaunchFailure = {
  kind: "launch_failure";
  workerId: string;
  stage: LaunchFailureStage;
  error: string;
  /** Evidence from any partial progress */
  evidence: {
    branch?: string;
    /** Worker registration event id if registered before failure */
    registeredEventId?: string;
    /** Run id if launch started but failed */
    runId?: string;
    /** Partial spawn result if available */
    spawnResult?: SpawnResult;
    /** ISO timestamp of failure */
    failedAt: string;
  };
};

/** Union result type for worker launch. */
export type WorkerLaunchResult = WorkerLaunchSuccess | WorkerLaunchFailure;

// ---------------------------------------------------------------------------
// Process registry adapter helpers
// ---------------------------------------------------------------------------

export function teamMemberRunProcessId(
  teamId: string,
  memberId: string,
  runId: string,
): string {
  return `team-member-run:${teamId}:${memberId}:${runId}`;
}

export function createTeamMemberRunProcessRecord(
  plan: WorkerLaunchPlan,
): RuntimeProcessRecord {
  return createRuntimeProcess({
    id: teamMemberRunProcessId(plan.teamId, plan.memberId, plan.runId),
    kind: "run",
    owner: {
      scope: "team-member",
      teamId: plan.teamId,
      memberId: plan.memberId,
      runId: plan.runId,
    },
    command: {
      executable: plan.spawnCommand.command,
      args: plan.spawnCommand.args,
      cwd: plan.workspace,
    },
    now: plan.createdAt,
    statePath: plan.paths.workerStateFile,
    logPath: plan.paths.workerLogFile,
    metadata: {
      channel: plan.channel,
      branch: plan.branch,
      role: plan.role,
      assignmentId: plan.assignmentId ?? null,
    },
  });
}

export function markTeamMemberRunProcessRunning(
  plan: WorkerLaunchPlan,
  input: { pid: number; now: string },
): RuntimeProcessRecord {
  return markProcessRunning(createTeamMemberRunProcessRecord(plan), {
    pid: input.pid,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Launch executor — function behind explicit ports
// ---------------------------------------------------------------------------

/**
 * Execute a worker launch from a plan and effect ports.
 *
 * Steps:
 * 1. Add the worker to the team roster (idempotent).
 * 2. Checkout the target branch via git port.
 * 3. Spawn the worker process via spawn port.
 * 4. Update the member's runId in the team roster.
 *
 * Returns structured success or failure with stage/evidence.
 * All side effects go through explicit ports.
 * No hidden Date/env/fs/network.
 */
export async function launchLocalWorker(
  plan: WorkerLaunchPlan,
  effects: WorkerLaunchEffects,
): Promise<WorkerLaunchResult> {
  const now = effects.clock.nowISO();

  // Step 1: add worker member to the roster (idempotent via event id).
  const registerEventId = effects.ids.newId();
  const registerEvent: TeamRosterEvent = {
    kind: "member_added",
    eventId: registerEventId,
    memberId: plan.memberId,
    role: plan.role,
    channel: plan.channel,
    metadata: {
      workspace: plan.workspace,
      branch: plan.branch,
      allowedActions: plan.allowedActions.join(","),
      runId: plan.runId,
      assignmentId: plan.assignmentId ?? "",
    },
  };

  try {
    const registerResult = await effects.roster.apply(registerEvent);
    if (registerResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "member_add",
        error: `Member add rejected: ${registerResult.rejection.message}`,
        evidence: {
          registeredEventId: registerEventId,
          failedAt: now,
        },
      };
    }
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "member_add",
      error: `Failed to add member: ${formatError(err)}`,
      evidence: {
        registeredEventId: registerEventId,
        failedAt: now,
      },
    };
  }

  // Step 2: Checkout branch
  let checkoutResult: GitCheckoutResult;
  try {
    checkoutResult = await effects.git.checkout(plan.workspace, plan.branch);
    if (!checkoutResult.success) {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "checkout",
        error: `Git checkout failed: ${checkoutResult.error ?? "unknown error"}`,
        evidence: {
          branch: plan.branch,
          registeredEventId: registerEventId,
          failedAt: now,
        },
      };
    }
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "checkout",
      error: `Git checkout threw: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        failedAt: now,
      },
    };
  }

  // Step 3: Spawn worker process
  let spawnResult: SpawnResult;
  try {
    spawnResult = await effects.spawn.spawn(
      plan.spawnCommand.command,
      plan.spawnCommand.args,
      plan.workspace,
    );
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "spawn",
      error: `Spawn failed: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        failedAt: now,
      },
    };
  }

  if (spawnResult.exitCode !== 0) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "spawn",
      error: `Spawn exited with code ${spawnResult.exitCode}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        spawnResult,
        failedAt: now,
      },
    };
  }

  // Step 4: Persist process state for reaper/shutdown lookup.
  try {
    await effects.workerState.write(plan.paths.workerStateFile, {
      workerId: plan.workerId,
      teamId: plan.teamId,
      memberId: plan.memberId,
      runId: plan.runId,
      assignmentId: plan.assignmentId,
      pid: spawnResult.pid,
      spawnedPid: spawnResult.pid,
      status: "running",
      startedAt: effects.clock.nowISO(),
      command: plan.spawnCommand.command,
      args: plan.spawnCommand.args,
      cwd: plan.workspace,
    });
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "worker_state",
      error: `Worker state write failed: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        runId: plan.runId,
        spawnResult,
        failedAt: effects.clock.nowISO(),
      },
    };
  }

  if (effects.processRegistry) {
    try {
      await effects.processRegistry.upsert(
        markTeamMemberRunProcessRunning(plan, {
          pid: spawnResult.pid,
          now: effects.clock.nowISO(),
        }),
      );
    } catch (err) {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "process_registry",
        error: `Worker process registry write failed: ${formatError(err)}`,
        evidence: {
          branch: plan.branch,
          registeredEventId: registerEventId,
          runId: plan.runId,
          spawnResult,
          failedAt: effects.clock.nowISO(),
        },
      };
    }
  }

  // Step 5: Update worker with runId
  const updateEventId = effects.ids.newId();
  const updateEvent: TeamRosterEvent = {
    kind: "member_updated",
    eventId: updateEventId,
    memberId: plan.memberId,
    patch: {
      runId: plan.runId,
      currentTask: plan.taskPrompt,
    },
  };

  try {
    const updateResult = await effects.roster.apply(updateEvent);
    if (updateResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "member_update",
        error: `Worker update rejected: ${updateResult.rejection.message}`,
        evidence: {
          branch: plan.branch,
          registeredEventId: registerEventId,
          runId: plan.runId,
          spawnResult,
          failedAt: effects.clock.nowISO(),
        },
      };
    }
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "member_update",
      error: `Worker launched but member update failed: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        runId: plan.runId,
        spawnResult,
        failedAt: effects.clock.nowISO(),
      },
    };
  }

  // Step 6: Set worker status to active
  const statusEventId = effects.ids.newId();
  const statusEvent: TeamRosterEvent = {
    kind: "member_status_changed",
    eventId: statusEventId,
    memberId: plan.memberId,
    status: "active",
    reason: "launch completed",
  };

  try {
    const statusResult = await effects.roster.apply(statusEvent);
    if (statusResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "member_status",
        error: `Status change rejected: ${statusResult.rejection.message}`,
        evidence: {
          branch: plan.branch,
          registeredEventId: registerEventId,
          runId: plan.runId,
          spawnResult,
          failedAt: effects.clock.nowISO(),
        },
      };
    }
  } catch (err) {
    return {
      kind: "launch_failure",
      workerId: plan.workerId,
      stage: "member_status",
      error: `Status change failed: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        runId: plan.runId,
        spawnResult,
        failedAt: effects.clock.nowISO(),
      },
    };
  }

  // Get member for success response.
  const state = await effects.roster.load();
  const member = state.members[plan.memberId];

  return {
    kind: "launch_success",
    workerId: plan.workerId,
    runId: plan.runId,
    channel: plan.channel,
    branch: plan.branch,
    workspace: plan.workspace,
    spawnedPid: spawnResult.pid,
    member: member ?? {
      memberId: plan.memberId,
      role: plan.role,
      runId: plan.runId,
      channel: plan.channel,
      metadata: {
        workspace: plan.workspace,
        branch: plan.branch,
        allowedActions: plan.allowedActions.join(","),
        runId: plan.runId,
        assignmentId: plan.assignmentId ?? "",
      },
      currentTask: plan.taskPrompt,
      status: "active",
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
