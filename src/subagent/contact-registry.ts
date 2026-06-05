// Pure domain for team contact / personnel directory.
// Durable runtime truth, not TUI state.
// No IO, no side effects, no global state.

export type WorkerContactStatus =
  | "active"
  | "idle"
  | "stale"
  | "offline"
  | "terminated";

export type WorkerContact = {
  /** Unique worker identity */
  workerId: string;
  /** Role: coder, reviewer, master, etc. */
  role: string;
  /** Filesystem workspace path */
  workspace: string;
  /** Git branch name */
  branch: string;
  /** Current agent run id, if running */
  runId?: string;
  /** IM channel name for communication */
  imChannel: string;
  /** Current child ledger id, if any */
  ledgerId?: string;
  /** Current ticket / work item */
  ticket?: {
    id: string;
    title: string;
    status: string;
  };
  /** Human readable current task description */
  currentTask?: string;
  /** Worker lifecycle status */
  status: WorkerContactStatus;
  /** ISO timestamp of last heartbeat */
  lastHeartbeat?: string;
  /** ISO timestamp of last evidence (work output/commit) */
  lastEvidence?: string;
  /** Set of allowed action categories */
  allowedActions: string[];
};

export type ContactRegistryEvent =
  | {
      kind: "worker_registered";
      eventId: string;
      workerId: string;
      role: string;
      workspace: string;
      branch: string;
      imChannel: string;
      allowedActions: string[];
    }
  | {
      kind: "worker_updated";
      eventId: string;
      workerId: string;
      patch: Partial<
        Pick<
          WorkerContact,
          | "role"
          | "workspace"
          | "branch"
          | "runId"
          | "imChannel"
          | "ledgerId"
          | "ticket"
          | "currentTask"
          | "allowedActions"
        >
      >;
    }
  | {
      kind: "worker_status_changed";
      eventId: string;
      workerId: string;
      status: WorkerContactStatus;
      reason?: string;
    }
  | {
      kind: "worker_heartbeat";
      eventId: string;
      workerId: string;
      timestamp: string;
      /** Optional evidence of work output (commit hash, artifact path) */
      evidence?: string;
    }
  | {
      kind: "worker_terminated";
      eventId: string;
      workerId: string;
      reason?: string;
    };

export type ContactRegistryRejectionCode =
  | "worker_exists"
  | "unknown_worker"
  | "invalid_transition"
  | "worker_already_terminated";

export type ContactRegistryRejection = {
  code: ContactRegistryRejectionCode;
  message: string;
};

export type ContactRegistryResult =
  | { status: "applied"; state: ContactRegistryState }
  | { status: "duplicate"; state: ContactRegistryState }
  | { status: "rejected"; state: ContactRegistryState; rejection: ContactRegistryRejection };

export type ContactRegistryState = {
  registryId: string;
  workers: Record<string, WorkerContact>;
  appliedEventIds: string[];
};

export type ContactRegistrySummary = {
  registryId: string;
  totalWorkers: number;
  workersByStatus: Record<WorkerContactStatus, number>;
  workersByRole: Record<string, number>;
  activeWorkers: WorkerContact[];
};

// Valid transitions from each status
const VALID_TRANSITIONS: Record<WorkerContactStatus, Set<WorkerContactStatus>> = {
  active: new Set(["idle", "stale", "offline", "terminated"]),
  idle: new Set(["active", "stale", "offline", "terminated"]),
  stale: new Set(["active", "idle", "offline", "terminated"]),
  offline: new Set(["active", "idle", "stale", "terminated"]),
  terminated: new Set([]),
};

export function createContactRegistryState(
  registryId: string,
): ContactRegistryState {
  return {
    registryId,
    workers: {},
    appliedEventIds: [],
  };
}

export function applyContactRegistryEvent(
  state: ContactRegistryState,
  event: ContactRegistryEvent,
): ContactRegistryResult {
  if (state.appliedEventIds.includes(event.eventId)) {
    return { status: "duplicate", state };
  }

  switch (event.kind) {
    case "worker_registered":
      return registerWorker(state, event);
    case "worker_updated":
      return updateWorker(state, event);
    case "worker_status_changed":
      return changeWorkerStatus(state, event);
    case "worker_heartbeat":
      return recordHeartbeat(state, event);
    case "worker_terminated":
      return terminateWorker(state, event);
  }
}

export function summarizeContactRegistry(
  state: ContactRegistryState,
): ContactRegistrySummary {
  const workers = Object.values(state.workers);

  const workersByStatus = zeroStatusCounts();
  const workersByRole: Record<string, number> = {};

  for (const w of workers) {
    workersByStatus[w.status] += 1;
    workersByRole[w.role] = (workersByRole[w.role] || 0) + 1;
  }

  return {
    registryId: state.registryId,
    totalWorkers: workers.length,
    workersByStatus,
    workersByRole,
    activeWorkers: workers.filter(
      (w) => w.status === "active" || w.status === "idle",
    ),
  };
}

export function lookupWorker(
  state: ContactRegistryState,
  workerId: string,
): WorkerContact | undefined {
  return state.workers[workerId];
}

export function listWorkersByRole(
  state: ContactRegistryState,
  role: string,
): WorkerContact[] {
  return Object.values(state.workers)
    .filter((w) => w.role === role)
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

export function listWorkersByStatus(
  state: ContactRegistryState,
  status: WorkerContactStatus,
): WorkerContact[] {
  return Object.values(state.workers)
    .filter((w) => w.status === status)
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

// ---- internal helpers ----

function registerWorker(
  state: ContactRegistryState,
  event: Extract<ContactRegistryEvent, { kind: "worker_registered" }>,
): ContactRegistryResult {
  if (state.workers[event.workerId]) {
    return reject(
      state,
      "worker_exists",
      `Worker ${event.workerId} already exists.`,
    );
  }

  const worker: WorkerContact = {
    workerId: event.workerId,
    role: event.role,
    workspace: event.workspace,
    branch: event.branch,
    imChannel: event.imChannel,
    allowedActions: event.allowedActions,
    status: "idle",
  };

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: worker,
    },
  }));
}

function updateWorker(
  state: ContactRegistryState,
  event: Extract<ContactRegistryEvent, { kind: "worker_updated" }>,
): ContactRegistryResult {
  const existing = state.workers[event.workerId];
  if (!existing) {
    return reject(
      state,
      "unknown_worker",
      `Worker ${event.workerId} does not exist.`,
    );
  }

  if (existing.status === "terminated") {
    return reject(
      state,
      "worker_already_terminated",
      `Worker ${event.workerId} is terminated.`,
    );
  }

  const updated: WorkerContact = {
    ...existing,
    ...event.patch,
    // These fields are managed by lifecycle events, not patches
    status: existing.status,
    lastHeartbeat: existing.lastHeartbeat,
    lastEvidence: existing.lastEvidence,
  };

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: updated,
    },
  }));
}

function changeWorkerStatus(
  state: ContactRegistryState,
  event: Extract<ContactRegistryEvent, { kind: "worker_status_changed" }>,
): ContactRegistryResult {
  const existing = state.workers[event.workerId];
  if (!existing) {
    return reject(
      state,
      "unknown_worker",
      `Worker ${event.workerId} does not exist.`,
    );
  }

  if (existing.status === event.status) {
    // Idempotent: already at target status — treat as duplicate of intent
    return { status: "duplicate", state };
  }

  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed.has(event.status)) {
    return reject(
      state,
      "invalid_transition",
      `Cannot transition worker ${event.workerId} from ${existing.status} to ${event.status}.`,
    );
  }

  const updated: WorkerContact = {
    ...existing,
    status: event.status,
  };

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: updated,
    },
  }));
}

function recordHeartbeat(
  state: ContactRegistryState,
  event: Extract<ContactRegistryEvent, { kind: "worker_heartbeat" }>,
): ContactRegistryResult {
  const existing = state.workers[event.workerId];
  if (!existing) {
    return reject(
      state,
      "unknown_worker",
      `Worker ${event.workerId} does not exist.`,
    );
  }

  const updated: WorkerContact = {
    ...existing,
    lastHeartbeat: event.timestamp,
    ...(event.evidence ? { lastEvidence: event.timestamp } : {}),
  };

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: updated,
    },
  }));
}

function terminateWorker(
  state: ContactRegistryState,
  event: Extract<ContactRegistryEvent, { kind: "worker_terminated" }>,
): ContactRegistryResult {
  const existing = state.workers[event.workerId];
  if (!existing) {
    return reject(
      state,
      "unknown_worker",
      `Worker ${event.workerId} does not exist.`,
    );
  }

  if (existing.status === "terminated") {
    return { status: "duplicate", state };
  }

  const updated: WorkerContact = {
    ...existing,
    status: "terminated",
  };

  return applied(withEvent(state, event.eventId, {
    workers: {
      ...state.workers,
      [event.workerId]: updated,
    },
  }));
}

function withEvent(
  state: ContactRegistryState,
  eventId: string,
  patch: Partial<ContactRegistryState>,
): ContactRegistryState {
  return {
    ...state,
    ...patch,
    appliedEventIds: [...state.appliedEventIds, eventId],
  };
}

function applied(state: ContactRegistryState): ContactRegistryResult {
  return { status: "applied", state };
}

function reject(
  state: ContactRegistryState,
  code: ContactRegistryRejectionCode,
  message: string,
): ContactRegistryResult {
  return { status: "rejected", state, rejection: { code, message } };
}

function zeroStatusCounts(): Record<WorkerContactStatus, number> {
  return {
    active: 0,
    idle: 0,
    stale: 0,
    offline: 0,
    terminated: 0,
  };
}
