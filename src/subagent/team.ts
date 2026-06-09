export type SubAgentTaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SubAgentWorkerStatus = "idle" | "busy" | "offline";
export type SubAgentTaskDispatchStatus = "pending" | "sent" | "failed";

export type SubAgentTaskDispatch = {
  messageId: string;
  channel: string;
  memberId: string;
  instruction: string;
  status: SubAgentTaskDispatchStatus;
  requestedAt: string;
  sentAt?: string;
  failedAt?: string;
  error?: string;
};

export type SubAgentTask = {
  id: string;
  title: string;
  status: SubAgentTaskStatus;
  input?: unknown;
  workerId?: string;
  dispatch?: SubAgentTaskDispatch;
  output?: unknown;
  error?: string;
  cancelReason?: string;
};

export type SubAgentWorker = {
  id: string;
  label?: string;
  status: SubAgentWorkerStatus;
  currentTaskId?: string;
};

export type SubAgentTeamState = {
  teamId: string;
  tasks: Record<string, SubAgentTask>;
  workers: Record<string, SubAgentWorker>;
  appliedEventIds: string[];
};

export type SubAgentTeamEvent =
  | {
      kind: "task_submitted";
      eventId: string;
      taskId: string;
      title: string;
      input?: unknown;
    }
  | {
      kind: "member_added";
      eventId: string;
      workerId: string;
      label?: string;
    }
  | {
      kind: "task_assigned";
      eventId: string;
      taskId: string;
      workerId: string;
    }
  | {
      kind: "task_dispatch_requested";
      eventId: string;
      taskId: string;
      memberId: string;
      channel: string;
      messageId: string;
      instruction: string;
      timestamp: string;
    }
  | {
      kind: "task_dispatch_sent";
      eventId: string;
      taskId: string;
      messageId: string;
      timestamp: string;
    }
  | {
      kind: "task_dispatch_failed";
      eventId: string;
      taskId: string;
      messageId: string;
      timestamp: string;
      error: string;
    }
  | {
      kind: "task_started";
      eventId: string;
      taskId: string;
      workerId?: string;
    }
  | {
      kind: "task_succeeded";
      eventId: string;
      taskId: string;
      output?: unknown;
    }
  | {
      kind: "task_failed";
      eventId: string;
      taskId: string;
      error: string;
    }
  | {
      kind: "task_cancelled";
      eventId: string;
      taskId: string;
      reason?: string;
    }
  | {
      kind: "worker_offline";
      eventId: string;
      workerId: string;
      reason?: string;
    };

export type SubAgentTransitionRejectionCode =
  | "task_exists"
  | "member_exists"
  | "unknown_task"
  | "unknown_member"
  | "task_not_assignable"
  | "task_not_dispatchable"
  | "task_dispatch_exists"
  | "task_dispatch_missing"
  | "task_dispatch_mismatch"
  | "task_not_startable"
  | "task_not_completable"
  | "task_terminal"
  | "worker_not_available"
  | "worker_task_mismatch";

export type SubAgentTransitionRejection = {
  code: SubAgentTransitionRejectionCode;
  message: string;
};

export type SubAgentTransitionResult =
  | {
      status: "applied";
      state: SubAgentTeamState;
    }
  | {
      status: "duplicate";
      state: SubAgentTeamState;
    }
  | {
      status: "rejected";
      state: SubAgentTeamState;
      rejection: SubAgentTransitionRejection;
    };

export type SubAgentAssignmentSummary = {
  taskId: string;
  taskTitle: string;
  taskStatus: SubAgentTaskStatus;
  workerId: string;
  workerStatus: SubAgentWorkerStatus;
};

export type SubAgentTeamSummary = {
  teamId: string;
  totalTasks: number;
  totalWorkers: number;
  tasksByStatus: Record<SubAgentTaskStatus, number>;
  workersByStatus: Record<SubAgentWorkerStatus, number>;
  activeAssignments: SubAgentAssignmentSummary[];
};

const TERMINAL_TASK_STATUSES = new Set<SubAgentTaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function createSubAgentTeamState(teamId: string): SubAgentTeamState {
  return {
    teamId,
    tasks: {},
    workers: {},
    appliedEventIds: [],
  };
}

export function applySubAgentTeamEvent(
  state: SubAgentTeamState,
  event: SubAgentTeamEvent,
): SubAgentTransitionResult {
  if (state.appliedEventIds.includes(event.eventId)) {
    return { status: "duplicate", state };
  }

  switch (event.kind) {
    case "task_submitted":
      return submitTask(state, event);
    case "member_added":
      return registerWorker(state, event);
    case "task_assigned":
      return assignTask(state, event);
    case "task_dispatch_requested":
      return requestTaskDispatch(state, event);
    case "task_dispatch_sent":
      return completeTaskDispatch(state, event, "sent");
    case "task_dispatch_failed":
      return completeTaskDispatch(state, event, "failed");
    case "task_started":
      return startTask(state, event);
    case "task_succeeded":
      return finishTask(state, event, "succeeded");
    case "task_failed":
      return finishTask(state, event, "failed");
    case "task_cancelled":
      return cancelTask(state, event);
    case "worker_offline":
      return markWorkerOffline(state, event);
  }
}

export function listActiveSubAgentAssignments(
  state: SubAgentTeamState,
): SubAgentAssignmentSummary[] {
  return Object.values(state.workers)
    .filter((worker) => worker.currentTaskId !== undefined)
    .map((worker) => {
      const task = state.tasks[worker.currentTaskId as string];
      return task
        ? {
            taskId: task.id,
            taskTitle: task.title,
            taskStatus: task.status,
            workerId: worker.id,
            workerStatus: worker.status,
          }
        : undefined;
    })
    .filter((assignment): assignment is SubAgentAssignmentSummary => assignment !== undefined)
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
}

export function summarizeSubAgentTeam(
  state: SubAgentTeamState,
): SubAgentTeamSummary {
  const tasksByStatus = zeroTaskStatusCounts();
  for (const task of Object.values(state.tasks)) {
    tasksByStatus[task.status] += 1;
  }

  const workersByStatus = zeroWorkerStatusCounts();
  for (const worker of Object.values(state.workers)) {
    workersByStatus[worker.status] += 1;
  }

  return {
    teamId: state.teamId,
    totalTasks: Object.keys(state.tasks).length,
    totalWorkers: Object.keys(state.workers).length,
    tasksByStatus,
    workersByStatus,
    activeAssignments: listActiveSubAgentAssignments(state),
  };
}

function submitTask(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_submitted" }>,
): SubAgentTransitionResult {
  if (state.tasks[event.taskId]) {
    return rejected(state, "task_exists", `Task ${event.taskId} already exists.`);
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        id: event.taskId,
        title: event.title,
        status: "queued",
        input: event.input,
      },
    },
  }));
}

function registerWorker(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "member_added" }>,
): SubAgentTransitionResult {
  if (state.workers[event.workerId]) {
    return rejected(state, "member_exists", `Worker ${event.workerId} already exists.`);
  }

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: {
        id: event.workerId,
        label: event.label,
        status: "idle",
      },
    },
  }));
}

function assignTask(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_assigned" }>,
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (task.status !== "queued") {
    return rejected(state, "task_not_assignable", `Task ${event.taskId} is ${task.status}.`);
  }

  const worker = state.workers[event.workerId];
  if (!worker) {
    return rejected(state, "unknown_member", `Worker ${event.workerId} does not exist.`);
  }
  if (worker.status !== "idle") {
    return rejected(state, "worker_not_available", `Worker ${event.workerId} is ${worker.status}.`);
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        ...task,
        status: "assigned",
        workerId: event.workerId,
      },
    },
    workers: {
      ...state.workers,
      [event.workerId]: {
        ...worker,
        status: "busy",
        currentTaskId: event.taskId,
      },
    },
  }));
}

function requestTaskDispatch(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_dispatch_requested" }>,
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (task.status !== "assigned") {
    return rejected(
      state,
      "task_not_dispatchable",
      `Task ${event.taskId} is ${task.status}.`,
    );
  }
  if (task.workerId !== event.memberId) {
    return rejected(
      state,
      "worker_task_mismatch",
      `Task ${event.taskId} is assigned to ${task.workerId ?? "no worker"}.`,
    );
  }
  if (task.dispatch) {
    return rejected(
      state,
      "task_dispatch_exists",
      `Task ${event.taskId} already has dispatch ${task.dispatch.messageId}.`,
    );
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        ...task,
        dispatch: {
          messageId: event.messageId,
          channel: event.channel,
          memberId: event.memberId,
          instruction: event.instruction,
          status: "pending",
          requestedAt: event.timestamp,
        },
      },
    },
  }));
}

function completeTaskDispatch(
  state: SubAgentTeamState,
  event: Extract<
    SubAgentTeamEvent,
    { kind: "task_dispatch_sent" | "task_dispatch_failed" }
  >,
  status: Extract<SubAgentTaskDispatchStatus, "sent" | "failed">,
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (!task.dispatch) {
    return rejected(
      state,
      "task_dispatch_missing",
      `Task ${event.taskId} has no pending dispatch.`,
    );
  }
  if (task.dispatch.messageId !== event.messageId) {
    return rejected(
      state,
      "task_dispatch_mismatch",
      `Task ${event.taskId} dispatch is ${task.dispatch.messageId}, not ${event.messageId}.`,
    );
  }
  if (task.dispatch.status !== "pending") {
    return rejected(
      state,
      "task_not_dispatchable",
      `Task ${event.taskId} dispatch is already ${task.dispatch.status}.`,
    );
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        ...task,
        dispatch: {
          ...task.dispatch,
          status,
          ...(status === "sent"
            ? { sentAt: event.timestamp }
            : {
                failedAt: event.timestamp,
                error:
                  event.kind === "task_dispatch_failed"
                    ? event.error
                    : "Dispatch failed.",
              }),
        },
      },
    },
  }));
}

function startTask(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_started" }>,
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (task.status !== "assigned") {
    return rejected(state, "task_not_startable", `Task ${event.taskId} is ${task.status}.`);
  }
  if (event.workerId && task.workerId !== event.workerId) {
    return rejected(
      state,
      "worker_task_mismatch",
      `Task ${event.taskId} is assigned to ${task.workerId ?? "no worker"}.`,
    );
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        ...task,
        status: "running",
      },
    },
  }));
}

function finishTask(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_succeeded" | "task_failed" }>,
  status: "succeeded" | "failed",
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (task.status !== "running") {
    return rejected(state, "task_not_completable", `Task ${event.taskId} is ${task.status}.`);
  }

  const workerUpdate = releaseAssignedWorker(state, task);
  const nextTask: SubAgentTask = {
    ...task,
    status,
    ...(status === "succeeded" && "output" in event ? { output: event.output } : {}),
    ...(status === "failed" && "error" in event ? { error: event.error } : {}),
  };

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: nextTask,
    },
    workers: workerUpdate,
  }));
}

function cancelTask(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "task_cancelled" }>,
): SubAgentTransitionResult {
  const task = state.tasks[event.taskId];
  if (!task) {
    return rejected(state, "unknown_task", `Task ${event.taskId} does not exist.`);
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return rejected(state, "task_terminal", `Task ${event.taskId} is already ${task.status}.`);
  }

  return applied(withEvent(state, event.eventId, {
    tasks: {
      ...state.tasks,
      [event.taskId]: {
        ...task,
        status: "cancelled",
        cancelReason: event.reason,
      },
    },
    workers: releaseAssignedWorker(state, task),
  }));
}

function markWorkerOffline(
  state: SubAgentTeamState,
  event: Extract<SubAgentTeamEvent, { kind: "worker_offline" }>,
): SubAgentTransitionResult {
  const worker = state.workers[event.workerId];
  if (!worker) {
    return rejected(state, "unknown_member", `Worker ${event.workerId} does not exist.`);
  }

  const task =
    worker.currentTaskId !== undefined ? state.tasks[worker.currentTaskId] : undefined;
  const tasks =
    task && !TERMINAL_TASK_STATUSES.has(task.status)
      ? {
          ...state.tasks,
          [task.id]: {
            ...task,
            status: "failed" as const,
            error: event.reason ?? "Worker went offline.",
          },
        }
      : state.tasks;

  return applied(withEvent(state, event.eventId, {
    tasks,
    workers: {
      ...state.workers,
      [event.workerId]: {
        ...worker,
        status: "offline",
        currentTaskId: undefined,
      },
    },
  }));
}

function releaseAssignedWorker(
  state: SubAgentTeamState,
  task: SubAgentTask,
): Record<string, SubAgentWorker> {
  if (!task.workerId) {
    return state.workers;
  }
  const worker = state.workers[task.workerId];
  if (!worker) {
    return state.workers;
  }
  return {
    ...state.workers,
    [task.workerId]: {
      ...worker,
      status: worker.status === "offline" ? "offline" : "idle",
      currentTaskId: undefined,
    },
  };
}

function withEvent(
  state: SubAgentTeamState,
  eventId: string,
  patch: Partial<SubAgentTeamState>,
): SubAgentTeamState {
  return {
    ...state,
    ...patch,
    appliedEventIds: [...state.appliedEventIds, eventId],
  };
}

function applied(state: SubAgentTeamState): SubAgentTransitionResult {
  return { status: "applied", state };
}

function rejected(
  state: SubAgentTeamState,
  code: SubAgentTransitionRejectionCode,
  message: string,
): SubAgentTransitionResult {
  return {
    status: "rejected",
    state,
    rejection: {
      code,
      message,
    },
  };
}

function zeroTaskStatusCounts(): Record<SubAgentTaskStatus, number> {
  return {
    queued: 0,
    assigned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
}

function zeroWorkerStatusCounts(): Record<SubAgentWorkerStatus, number> {
  return {
    idle: 0,
    busy: 0,
    offline: 0,
  };
}
