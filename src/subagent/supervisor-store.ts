// Durable supervisor store — path planning, lifecycle event types,
// JSONL append/read with explicit FsPort and ClockPort.
//
// No direct IO, no side effects in core logic.
// All filesystem access goes through the FsPort interface.
// Time must be an explicit input; no hidden new Date().

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Default supervisor directory relative to project root. */
export const DEFAULT_SUPERVISOR_DIR = ".tiny-agent/supervisor";

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
  // Normalize: strip trailing slashes
  const normalized = projectRoot.replace(/\/+$/, "");
  
  // Split into segments and check for ".."
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(
        `Path traversal detected in project root: "${projectRoot}". ` +
        `The path must not contain ".." segments.`
      );
    }
  }
  
  // Also check for encoded traversal attempts
  if (normalized.includes("%2e%2e") || normalized.includes("..%2F") || normalized.includes("%2F..")) {
    throw new Error(
      `Path traversal detected in project root: "${projectRoot}". ` +
      `URL-encoded path traversal patterns are not allowed.`
    );
  }
}

/**
 * Compute supervisor store paths from a project root.
 * Pure — no IO, no side effects.
 * Throws on path traversal attempts.
 */
export function planSupervisorPaths(projectRoot: string): SupervisorPaths {
  validateProjectRoot(projectRoot);
  
  const root = projectRoot.replace(/\/+$/, ""); // strip trailing slashes
  const supervisorDir = `${root}/${DEFAULT_SUPERVISOR_DIR}`;
  
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
  | "worker_registered"
  | "worker_status_changed"
  | "worker_heartbeat"
  | "worker_terminated";

/** Payload for each event type. */
export type SupervisorLifecycleEventPayload =
  | {
      workerId: string;
      role: string;
      workspace: string;
      branch: string;
      imChannel: string;
    }
  | {
      workerId: string;
      status: string;
      previousStatus?: string;
    }
  | {
      workerId: string;
    }
  | {
      workerId: string;
      reason?: string;
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
    // Every event must have a workerId in its payload
    if (typeof payload.workerId !== "string" || payload.workerId.length === 0) {
      errors.push("payload.workerId is missing or not a string");
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
      // Also ensure parent directories are tracked
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
  // Ensure supervisor directory exists
  await ports.fs.mkdir(paths.supervisorDir);

  // Check for duplicate event ID by reading existing events
  // and optionally loading the snapshot for cross-restart idempotency
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

  // Also read existing events to check for duplicates in the JSONL
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

  // Read existing content
  let existingContent = "";
  try {
    existingContent = await ports.fs.readFile(paths.eventsFile);
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Append the new event as a JSONL line
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
    // File not found — no events
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
