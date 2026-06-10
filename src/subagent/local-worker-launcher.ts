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

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Workers directory relative to the product state root. */
export const DEFAULT_WORKERS_DIR = "runs";

/** Run-scoped worker directory paths. */
export type RunScopedWorkerPaths = {
  /** Directory for worker state under runs/<runId>/workers/<workerId>/ */
  runWorkerDir: string;
  /** Worker state JSON file path */
  runWorkerStateFile: string;
  /** Worker output log file path */
  runWorkerLogFile: string;
};

/**
 * Compute run-scoped worker directory paths.
 * Worker state lives under runs/<runId>/workers/<workerId>/,
 * keeping runtime state self-contained per the state-layout contract.
 * Pure — no IO, no side effects.
 */
export function planRunScopedWorkerPaths(
  stateRoot: string,
  runId: string,
  workerId: string,
): RunScopedWorkerPaths {
  const root = stateRoot.replace(/\/+$/, ""); // strip trailing slashes
  const runWorkerDir = `${root}/${DEFAULT_WORKERS_DIR}/${runId}/workers/${workerId}`;
  return {
    runWorkerDir,
    runWorkerStateFile: `${runWorkerDir}/state.json`,
    runWorkerLogFile: `${runWorkerDir}/output.log`,
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
  runId: string;
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

/** All effect ports needed to execute a worker launch. */
export type WorkerLaunchEffects = {
  spawn: SpawnPort;
  git: GitPort;
  clock: Clock;
  ids: IdGenerator;
  roster: RosterStorePort;
  workerState: WorkerStatePort;
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
  /** Product state root directory (for run-scoped path computation) */
  stateRoot: string;
  /** Agent run id */
  runId: string;
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
  runId: string;
  stateRoot: string;
  workspace: string;
  branch: string;
  channel: string;
  role: string;
  allowedActions: string[];
  taskPrompt: string;
  createdAt: string;
  /** Run-scoped worker paths */
  paths: RunScopedWorkerPaths;
  /** Command to spawn the worker process */
  spawnCommand: WorkerSpawnCommand;
};

// ---------------------------------------------------------------------------
// Launch planner — pure function
// ---------------------------------------------------------------------------

/**
 * Plan a worker launch from explicit input parameters.
 * Computes run-scoped paths and builds the spawn command.
 * Pure — no IO, no side effects, no hidden dependencies.
 */
export function planWorkerLaunch(
  params: WorkerLaunchParams,
): WorkerLaunchPlan {
  const paths = planRunScopedWorkerPaths(
    params.stateRoot,
    params.runId,
    params.workerId,
  );

  const plan: WorkerLaunchPlan = {
    workerId: params.workerId,
    runId: params.runId,
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
 * channel and task prompt.
 * Pure — no IO, no side effects.
 */
export function buildSpawnCommand(
  plan: WorkerLaunchPlan,
): WorkerSpawnCommand {
  const args: string[] = [
    "run",
    "--channel",
    plan.channel,
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
    memberId: plan.workerId,
    role: plan.role,
    channel: plan.channel,
    metadata: {
      workspace: plan.workspace,
      branch: plan.branch,
      allowedActions: plan.allowedActions.join(","),
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
    await effects.workerState.write(plan.paths.runWorkerStateFile, {
      workerId: plan.workerId,
      runId: plan.runId,
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

  // Step 5: Update worker with runId
  const updateEventId = effects.ids.newId();
  const updateEvent: TeamRosterEvent = {
    kind: "member_updated",
    eventId: updateEventId,
    memberId: plan.workerId,
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
    memberId: plan.workerId,
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
  const member = state.members[plan.workerId];

  return {
    kind: "launch_success",
    workerId: plan.workerId,
    runId: plan.runId,
    channel: plan.channel,
    branch: plan.branch,
    workspace: plan.workspace,
    spawnedPid: spawnResult.pid,
    member: member ?? {
      memberId: plan.workerId,
      role: plan.role,
      runId: plan.runId,
      channel: plan.channel,
      metadata: {
        workspace: plan.workspace,
        branch: plan.branch,
        allowedActions: plan.allowedActions.join(","),
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
