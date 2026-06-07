// Durable supervisor store — path planning, lifecycle event types,
// JSONL append/read with explicit FsPort and ClockPort.
//
// No direct IO, no side effects in core logic.
// All filesystem access goes through the FsPort interface.
// Time must be an explicit input; no hidden new Date().

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/**
 * Project-scoped supervisor directory.
 * NON-ACTIVE — do not use for new code.
 * Prefer planRunScopedSupervisorPaths which scopes state under a run.
 */
export const DEFAULT_SUPERVISOR_DIR = ".tiny-agent/supervisor";

/** Run-scoped supervisor directory pattern. */
export const RUN_SCOPED_SUPERVISOR_DIR = ".tiny-agent/runs";

/** Paths for supervisor state under a project root. */
export type SupervisorPaths = {
  supervisorDir: string;
  eventsFile: string;
  snapshotFile: string;
};

/**
 * Validate that a project root does not contain path-traversal segments.
 * Throws on any `..` path component that would escape the root.
 */
function validateProjectRoot(projectRoot: string): void {
  const normalized = projectRoot.replace(/\/+$/, "");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(
        `Path traversal detected in project root: "${projectRoot}". ` +
        `The path must not contain ".." segments.`
      );
    }
  }
  if (normalized.includes("%2e%2e") || normalized.includes("..%2F") || normalized.includes("%2F..")) {
    throw new Error(
      `Path traversal detected in project root: "${projectRoot}". ` +
      `URL-encoded path traversal patterns are not allowed.`
    );
  }
}

/**
 * Validate that a run ID does not contain path-traversal or separator segments.
 */
function validateRunId(runId: string): void {
  if (!runId || typeof runId !== "string") {
    throw new Error(`Invalid runId: must be a non-empty string`);
  }
  if (runId.includes("..") || runId.includes("/")) {
    throw new Error(
      `Path traversal detected in runId: "${runId}". ` +
      `The runId must not contain ".." or "/" segments.`
    );
  }
  if (runId.includes("%2e%2e") || runId.includes("%2F")) {
    throw new Error(
      `Path traversal detected in runId: "${runId}". ` +
      `URL-encoded path traversal patterns are not allowed.`
    );
  }
}

/**
 * Compute project-scoped supervisor store paths (NON-ACTIVE).
 * Prefer planRunScopedSupervisorPaths for new code.
 * Pure — no IO, no side effects.
 * Throws on path traversal attempts.
 */
export function planSupervisorPaths(projectRoot: string): SupervisorPaths {
  validateProjectRoot(projectRoot);
  const root = projectRoot.replace(/\/+$/, "");
  const supervisorDir = `${root}/${DEFAULT_SUPERVISOR_DIR}`;
  return {
    supervisorDir,
    eventsFile: `${supervisorDir}/lifecycle-events.jsonl`,
    snapshotFile: `${supervisorDir}/snapshot.json`,
  };
}

/**
 * Compute run-scoped supervisor store paths (ACTIVE).
 * Active path is under .tiny-agent/runs/<runId>/supervisor.
 * Pure — no IO, no side effects.
 * Throws on path traversal attempts in either projectRoot or runId.
 */
export function planRunScopedSupervisorPaths(
  projectRoot: string,
  runId: string,
): SupervisorPaths {
  validateProjectRoot(projectRoot);
  validateRunId(runId);
  const root = projectRoot.replace(/\/+$/, "");
  const supervisorDir = `${root}/${RUN_SCOPED_SUPERVISOR_DIR}/${runId}/supervisor`;
  return {
    supervisorDir,
    eventsFile: `${supervisorDir}/lifecycle-events.jsonl`,
    snapshotFile: `${supervisorDir}/snapshot.json`,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle event types
// ---------------------------------------------------------------------------

/** Known supervisor lifecycle event types. */
export type SupervisorLifecycleEventType =
  // Worker registration and status
  | "worker_registered"
  | "worker_status_changed"
  | "worker_heartbeat"
  | "worker_terminated"
  // Leases — full resource-binding lifecycle
  | "lease_requested"
  | "lease_acquired"
  | "lease_renewed"
  | "lease_released"
  | "lease_expired"
  // Heartbeat — structured cadence recording
  | "heartbeat_recorded"
  // Shutdown — supervisor shutdown with intent/result/failure
  | "shutdown_requested"
  | "shutdown_draining"
  | "shutdown_completed"
  | "shutdown_failed"
  // Reaper — explicit planned/executed/skipped audit trail
  | "reaper_planned"
  | "reaper_executed"
  | "reaper_skipped";

/** Payload for each event type (documentation only — runtime uses Record<string, unknown>). */
export type SupervisorLifecycleEventPayload =
  // worker_registered
  | {
      workerId: string;
      role: string;
      workspace: string;
      branch: string;
      imChannel: string;
    }
  // worker_status_changed
  | {
      workerId: string;
      status: string;
      previousStatus?: string;
    }
  // worker_heartbeat
  | { workerId: string }
  // worker_terminated
  | { workerId: string; reason?: string }
  // lease_requested
  | {
      workerId: string;
      leaseId: string;
      resource: string;
      requestedAt: string;
    }
  // lease_acquired
  | {
      workerId: string;
      leaseId: string;
      resource: string;
      acquiredAt: string;
      expiresAt: string;
    }
  // lease_renewed
  | {
      workerId: string;
      leaseId: string;
      renewedAt: string;
      newExpiresAt: string;
    }
  // lease_released
  | {
      workerId: string;
      leaseId: string;
      releasedAt: string;
    }
  // lease_expired
  | {
      workerId: string;
      leaseId: string;
      expiredAt: string;
    }
  // heartbeat_recorded
  | {
      workerId: string;
      sequence: number;
      cadenceMs: number;
    }
  // shutdown_requested
  | {
      phase: string;
      requestedBy: string;
      reason?: string;
    }
  // shutdown_draining
  | { remainingWorkers: number }
  // shutdown_completed
  | { totalWorkersTerminated: number }
  // shutdown_failed
  | { reason: string }
  // reaper_planned
  | {
      candidateWorkerId: string;
      reason: string;
      plannedAction: string;
    }
  // reaper_executed
  | {
      workerId: string;
      action: string;
      reason: string;
      affectedLeases?: string[];
    }
  // reaper_skipped
  | {
      candidateWorkerId: string;
      reason: string;
    };

/** A supervisor lifecycle event with idempotency key. */
export type SupervisorLifecycleEvent = {
  eventId: string;
  type: SupervisorLifecycleEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};

/** Result of event validation. */
export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Event creation — pure factory
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  "worker_registered",
  "worker_status_changed",
  "worker_heartbeat",
  "worker_terminated",
  "lease_requested",
  "lease_acquired",
  "lease_renewed",
  "lease_released",
  "lease_expired",
  "heartbeat_recorded",
  "shutdown_requested",
  "shutdown_draining",
  "shutdown_completed",
  "shutdown_failed",
  "reaper_planned",
  "reaper_executed",
  "reaper_skipped",
]);

/**
 * Create a supervisor lifecycle event.
 * `now` is an explicit clock input — no hidden new Date().
 */
export function createSupervisorLifecycleEvent(
  eventId: string,
  type: SupervisorLifecycleEventType,
  payload: Record<string, unknown>,
  now: string,
): SupervisorLifecycleEvent {
  return {
    eventId,
    type,
    timestamp: now,
    payload,
  };
}

/**
 * Validate a supervisor lifecycle event structure.
 * Pure — no IO, no side effects.
 */
export function validateLifecycleEvent(
  event: unknown,
): ValidationResult {
  const errors: string[] = [];

  if (!event || typeof event !== "object") {
    return { valid: false, errors: ["Event is not an object"] };
  }

  const e = event as Record<string, unknown>;

  if (typeof e.eventId !== "string" || e.eventId.length === 0) {
    errors.push("Missing or invalid eventId");
  }

  if (typeof e.type !== "string" || !VALID_EVENT_TYPES.has(e.type)) {
    errors.push(`Invalid or unknown event type: ${e.type}`);
  }

  if (typeof e.timestamp !== "string") {
    errors.push("Missing or invalid timestamp");
  }

  if (!e.payload || typeof e.payload !== "object") {
    errors.push("Missing or invalid payload");
  } else {
    const payload = e.payload as Record<string, unknown>;
    const eventType = e.type as string;
    
    // Supervisor-level events that don't require workerId
    const isSupervisorEvent = 
      eventType === "shutdown_requested" ||
      eventType === "shutdown_draining" ||
      eventType === "shutdown_completed" ||
      eventType === "shutdown_failed";
    
    // Reaper planned/skipped use candidateWorkerId instead of workerId
    const isReaperPlanEvent =
      eventType === "reaper_planned" ||
      eventType === "reaper_skipped";
    
    if (isReaperPlanEvent) {
      if (typeof payload.candidateWorkerId !== "string" || payload.candidateWorkerId.length === 0) {
        errors.push("payload.candidateWorkerId is missing or not a string");
      }
    } else if (!isSupervisorEvent) {
      if (typeof payload.workerId !== "string" || payload.workerId.length === 0) {
        errors.push("payload.workerId is missing or not a string");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Snapshot schema
// ---------------------------------------------------------------------------

/** Current snapshot schema version. */
export const SUPERVISOR_SNAPSHOT_VERSION = 1;

/** State carried in the snapshot. */
export type SupervisorSnapshotState = {
  eventIds: string[];
};

/** A durable snapshot of the supervisor store at a point in time. */
export type SupervisorSnapshot = {
  schemaVersion: number;
  state: SupervisorSnapshotState;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create a new supervisor snapshot.
 * `now` is an explicit clock input — no hidden new Date().
 * `createdAt` allows preservation across rewrites; defaults to `now`.
 */
export function createSupervisorSnapshot(
  state: SupervisorSnapshotState,
  now: string,
  createdAt?: string,
): SupervisorSnapshot {
  return {
    schemaVersion: SUPERVISOR_SNAPSHOT_VERSION,
    state,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Ports — explicit interfaces for testability
// ---------------------------------------------------------------------------

/** Explicit filesystem port for reading and writing supervisor state. */
export type SupervisorFsPort = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
};

/** Explicit clock port for getting the current time. */
export type ClockPort = {
  now: () => string;
};

/** Combined ports needed by the supervisor store. */
export type SupervisorPorts = {
  fs: SupervisorFsPort;
  clock: ClockPort;
};

// ---------------------------------------------------------------------------
// In-memory ports — for testing
// ---------------------------------------------------------------------------

/**
 * Create an in-memory FsPort and ClockPort for testing.
 * Stores data in a Map<string, string> with directory tracking.
 */
export function createInMemorySupervisorPorts(
  clockTime?: string,
): SupervisorPorts {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const fs: SupervisorFsPort = {
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file '${path}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return content;
    },

    async writeFile(path: string, data: string): Promise<void> {
      const parent = path.substring(0, path.lastIndexOf("/"));
      if (parent && !dirs.has(parent)) {
        const err = new Error(`ENOENT: no such directory '${parent}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      files.set(path, data);
    },

    async mkdir(path: string): Promise<void> {
      dirs.add(path);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i + 1).join("/"));
      }
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
  };

  const clock: ClockPort = {
    now: () => clockTime ?? "2024-01-01T00:00:00.000Z",
  };

  return { fs, clock };
}

// ---------------------------------------------------------------------------
// Append/Read store
// ---------------------------------------------------------------------------

/** Result of appending a lifecycle event. */
export type AppendLifecycleResult =
  | { status: "appended" }
  | { status: "duplicate" }
  | { status: "error"; message: string };

/** Options for appendLifecycleEvent. */
export type AppendOptions = {
  /** If true, load the snapshot first to seed seen event IDs (for cross-restart idempotency). */
  loadSnapshot?: boolean;
};

/** Result of reading lifecycle events. */
export type ReadLifecycleResult = {
  validEvents: SupervisorLifecycleEvent[];
  parseErrors: string[];
};

/**
 * Append a lifecycle event to the JSONL events file.
 * Rejects duplicate event IDs.
 * Uses explicit FsPort — no direct filesystem access.
 */
export async function appendLifecycleEvent(
  ports: SupervisorPorts,
  paths: SupervisorPaths,
  event: SupervisorLifecycleEvent,
  options?: AppendOptions,
): Promise<AppendLifecycleResult> {
  await ports.fs.mkdir(paths.supervisorDir);
  const validation = validateLifecycleEvent(event);
  if (!validation.valid) {
    return {
      status: "error",
      message: `Invalid lifecycle event: ${validation.errors.join("; ")}`,
    };
  }

  const seenIds = new Set<string>();

  if (options?.loadSnapshot) {
    try {
      if (await ports.fs.exists(paths.snapshotFile)) {
        const raw = await ports.fs.readFile(paths.snapshotFile);
        const snapshot = JSON.parse(raw) as SupervisorSnapshot;
        if (snapshot.state?.eventIds) {
          for (const id of snapshot.state.eventIds) {
            seenIds.add(id);
          }
        }
      }
    } catch {
      // Snapshot not found or malformed — start fresh
    }
  }

  try {
    if (await ports.fs.exists(paths.eventsFile)) {
      const raw = await ports.fs.readFile(paths.eventsFile);
      const lines = raw.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed) as SupervisorLifecycleEvent;
          if (parsed.eventId) {
            seenIds.add(parsed.eventId);
          }
        } catch {
          // Skip malformed lines during duplicate check
        }
      }
    }
  } catch {
    // File not found — no existing events to check
  }

  if (seenIds.has(event.eventId)) {
    return { status: "duplicate" };
  }

  let existingContent = "";
  try {
    existingContent = await ports.fs.readFile(paths.eventsFile);
  } catch {
    // File doesn't exist yet — start fresh
  }

  const line = JSON.stringify(event) + "\n";
  await ports.fs.writeFile(paths.eventsFile, existingContent + line);

  return { status: "appended" };
}

/**
 * Read all lifecycle events from the JSONL events file.
 * Valid events are returned separately from parse errors.
 * Uses explicit FsPort — no direct filesystem access.
 */
export async function readAllLifecycleEvents(
  ports: SupervisorPorts,
  paths: SupervisorPaths,
): Promise<ReadLifecycleResult> {
  const validEvents: SupervisorLifecycleEvent[] = [];
  const parseErrors: string[] = [];

  let raw: string;
  try {
    raw = await ports.fs.readFile(paths.eventsFile);
  } catch {
    return { validEvents, parseErrors };
  }

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseErrors.push(
        `Failed to parse JSONL line: ${trimmed.slice(0, 100)}`,
      );
      continue;
    }

    const validation = validateLifecycleEvent(parsed);
    if (validation.valid) {
      validEvents.push(parsed as SupervisorLifecycleEvent);
    } else {
      parseErrors.push(
        `Invalid lifecycle event: ${validation.errors.join("; ")}`,
      );
    }
  }

  return { validEvents, parseErrors };
}
