// Local worker launcher domain — pure types and functions for planning
// and executing a local tiny-agent worker launch behind explicit ports.
//
// No IO, no side effects, no hidden Date/fs/process/env/cwd/network.
// Real side effects enter through explicit port interfaces.

import type {
  WorkerContact,
  ContactRegistryState,
  ContactRegistryEvent,
  ContactRegistryResult,
} from "./contact-registry.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
} from "./contact-registry.js";

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Default workers directory relative to project root (under .tiny-agent/runs). */
export const DEFAULT_WORKERS_DIR = ".tiny-agent/runs";

/** Run-scoped worker directory paths. */
export type RunScopedWorkerPaths = {
  /** Directory for worker state under .tiny-agent/runs/<runId>/workers/<workerId>/ */
  runWorkerDir: string;
  /** Worker state JSON file path */
  runWorkerStateFile: string;
  /** Worker output log file path */
  runWorkerLogFile: string;
};

/**
 * Compute run-scoped worker directory paths.
 * Worker state lives under .tiny-agent/runs/<runId>/workers/<workerId>/,
 * keeping runtime state self-contained per the state-layout contract.
 * Pure — no IO, no side effects.
 */
export function planRunScopedWorkerPaths(
  projectRoot: string,
  runId: string,
  workerId: string,
): RunScopedWorkerPaths {
  const root = projectRoot.replace(/\/+$/, ""); // strip trailing slashes
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

/** Contact store port — registry read/write for worker contact events. */
export type ContactStorePort = {
  /** Load current contact registry state. */
  load: () => Promise<ContactRegistryState>;
  /** Persist a contact registry event and return updated state. */
  apply: (event: ContactRegistryEvent) => Promise<ContactRegistryResult>;
};

/** All effect ports needed to execute a worker launch. */
export type WorkerLaunchEffects = {
  spawn: SpawnPort;
  git: GitPort;
  clock: Clock;
  ids: IdGenerator;
  contacts: ContactStorePort;
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
  /** Project root directory (for path computation) */
  projectRoot: string;
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
    params.projectRoot,
    params.runId,
    params.workerId,
  );

  const plan: WorkerLaunchPlan = {
    workerId: params.workerId,
    runId: params.runId,
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
 * The command runs `node dist/cli/main.js run` with the worker's channel
 * and task prompt.
 * Pure — no IO, no side effects.
 */
export function buildSpawnCommand(
  plan: WorkerLaunchPlan,
): WorkerSpawnCommand {
  const args: string[] = [
    "dist/cli/main.js",
    "run",
    "--channel",
    plan.channel,
  ];

  if (plan.taskPrompt && plan.taskPrompt.length > 0) {
    args.push("--task", plan.taskPrompt);
  }

  return {
    command: "node",
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
  | "contact_register"
  | "contact_update"
  | "contact_status";

/** Successful worker launch result. */
export type WorkerLaunchSuccess = {
  kind: "launch_success";
  workerId: string;
  runId: string;
  channel: string;
  branch: string;
  workspace: string;
  spawnedPid: number;
  contact: WorkerContact;
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
 * 1. Register the worker in the contact registry (idempotent).
 * 2. Checkout the target branch via git port.
 * 3. Spawn the worker process via spawn port.
 * 4. Update the worker's runId in the contact registry.
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

  // Step 1: Register worker contact (idempotent via event id)
  const registerEventId = effects.ids.newId();
  const registerEvent: ContactRegistryEvent = {
    kind: "worker_registered",
    eventId: registerEventId,
    workerId: plan.workerId,
    role: plan.role,
    workspace: plan.workspace,
    branch: plan.branch,
    imChannel: plan.channel,
    allowedActions: plan.allowedActions,
  };

  try {
    const registerResult = await effects.contacts.apply(registerEvent);
    if (registerResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "contact_register",
        error: `Worker registration rejected: ${registerResult.rejection.message}`,
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
      stage: "contact_register",
      error: `Failed to register worker: ${formatError(err)}`,
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

  // Step 4: Update worker with runId
  const updateEventId = effects.ids.newId();
  const updateEvent: ContactRegistryEvent = {
    kind: "worker_updated",
    eventId: updateEventId,
    workerId: plan.workerId,
    patch: {
      runId: plan.runId,
      currentTask: plan.taskPrompt,
    },
  };

  try {
    const updateResult = await effects.contacts.apply(updateEvent);
    if (updateResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "contact_update",
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
      stage: "contact_update",
      error: `Worker launched but contact update failed: ${formatError(err)}`,
      evidence: {
        branch: plan.branch,
        registeredEventId: registerEventId,
        runId: plan.runId,
        spawnResult,
        failedAt: effects.clock.nowISO(),
      },
    };
  }

  // Step 5: Set worker status to active
  const statusEventId = effects.ids.newId();
  const statusEvent: ContactRegistryEvent = {
    kind: "worker_status_changed",
    eventId: statusEventId,
    workerId: plan.workerId,
    status: "active",
    reason: "launch completed",
  };

  try {
    const statusResult = await effects.contacts.apply(statusEvent);
    if (statusResult.status === "rejected") {
      return {
        kind: "launch_failure",
        workerId: plan.workerId,
        stage: "contact_status",
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
      stage: "contact_status",
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

  // Get contact for success response
  const state = await effects.contacts.load();
  const contact = state.workers[plan.workerId];

  return {
    kind: "launch_success",
    workerId: plan.workerId,
    runId: plan.runId,
    channel: plan.channel,
    branch: plan.branch,
    workspace: plan.workspace,
    spawnedPid: spawnResult.pid,
    contact: contact ?? {
      workerId: plan.workerId,
      role: plan.role,
      workspace: plan.workspace,
      branch: plan.branch,
      runId: plan.runId,
      imChannel: plan.channel,
      allowedActions: plan.allowedActions,
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
