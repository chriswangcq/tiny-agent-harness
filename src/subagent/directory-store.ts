// Durable team directory store — run-scoped and project-scoped paths,
// JSON snapshot schema, and explicit read/write repository ports.
//
// No direct IO, no side effects in core logic.
// All filesystem access goes through the FsPort interface.
// Time must be an explicit input; no hidden new Date().

import type { ContactRegistryState } from "./contact-registry.js";

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Default team directory relative to project root (project-scoped). */
export const DEFAULT_TEAM_DIR = ".tiny-agent/team";

/** Project-scoped team directory layout. */
export type TeamDirectoryLayout = {
  teamDir: string;
  registryFile: string;
  eventsFile: string;
  runsDir: string;
};

/** Run-scoped team directory layout (under .tiny-agent/runs/<runId>/team/). */
export type RunScopedTeamPaths = {
  runTeamDir: string;
  runRegistryFile: string;
  runEventsFile: string;
};

/**
 * Compute project-scoped team directory layout from a project root.
 * Pure — no IO, no side effects.
 */
export function planTeamDirectoryLayout(
  projectRoot: string,
): TeamDirectoryLayout {
  const root = projectRoot.replace(/\/+$/, ""); // strip trailing slashes
  const teamDir = `${root}/${DEFAULT_TEAM_DIR}`;
  return {
    teamDir,
    registryFile: `${teamDir}/contact-registry.json`,
    eventsFile: `${teamDir}/events.jsonl`,
    runsDir: `${teamDir}/runs`,
  };
}

/**
 * Compute run-scoped team directory paths.
 * Run-scoped state lives under .tiny-agent/runs/<runId>/team/,
 * keeping runtime state self-contained per the state-layout contract.
 * Pure — no IO, no side effects.
 */
export function planRunScopedTeamPaths(
  projectRoot: string,
  runId: string,
): RunScopedTeamPaths {
  const root = projectRoot.replace(/\/+$/, "");
  const runTeamDir = `${root}/.tiny-agent/runs/${runId}/team`;
  return {
    runTeamDir,
    runRegistryFile: `${runTeamDir}/contact-registry.json`,
    runEventsFile: `${runTeamDir}/events.jsonl`,
  };
}

// ---------------------------------------------------------------------------
// Snapshot schema
// ---------------------------------------------------------------------------

/** Current snapshot schema version. */
export const DIRECTORY_SNAPSHOT_VERSION = 1;

/** A durable snapshot of the team directory at a point in time. */
export type TeamDirectorySnapshot = {
  schemaVersion: number;
  registryId: string;
  createdAt: string; // ISO 8601 — explicit clock input, not hidden Date
  updatedAt: string; // ISO 8601 — explicit clock input, not hidden Date
  registry: ContactRegistryState;
};

/** Result of snapshot validation. */
export type SnapshotValidationResult = {
  valid: boolean;
  errors: string[];
};

/**
 * Create a new snapshot from a ContactRegistryState.
 * `now` is an explicit clock input — no hidden new Date().
 * `createdAt` allows preservation across rewrites; defaults to `now`.
 */
export function createTeamDirectorySnapshot(
  state: ContactRegistryState,
  now: string,
  createdAt?: string,
): TeamDirectorySnapshot {
  return {
    schemaVersion: DIRECTORY_SNAPSHOT_VERSION,
    registryId: state.registryId,
    createdAt: createdAt ?? now,
    updatedAt: now,
    registry: state,
  };
}

/**
 * Validate a snapshot structure.
 * Pure — no IO, no side effects.
 */
export function validateTeamDirectorySnapshot(
  snapshot: unknown,
): SnapshotValidationResult {
  const errors: string[] = [];

  if (!snapshot || typeof snapshot !== "object") {
    return { valid: false, errors: ["Snapshot is not an object"] };
  }

  const s = snapshot as Record<string, unknown>;

  if (s.schemaVersion !== DIRECTORY_SNAPSHOT_VERSION) {
    errors.push(`Unsupported schemaVersion: ${s.schemaVersion}`);
  }

  if (typeof s.registryId !== "string" || s.registryId.length === 0) {
    errors.push("Missing or invalid registryId");
  }

  if (typeof s.createdAt !== "string") {
    errors.push("Missing or invalid createdAt");
  }

  if (typeof s.updatedAt !== "string") {
    errors.push("Missing or invalid updatedAt");
  }

  if (!s.registry || typeof s.registry !== "object") {
    errors.push("Missing or invalid registry");
  } else {
    const registry = s.registry as Record<string, unknown>;
    if (typeof registry.registryId !== "string") {
      errors.push("registry.registryId is missing or not a string");
    } else if (registry.registryId !== s.registryId) {
      errors.push(
        `registry.registryId "${registry.registryId}" does not match snapshot registryId "${s.registryId}"`,
      );
    }
    if (!registry.workers || typeof registry.workers !== "object") {
      errors.push("registry.workers is missing or not an object");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// FsPort — explicit filesystem adapter
// ---------------------------------------------------------------------------

/** Explicit filesystem port for reading and writing team directory state. */
export type FsPort = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
};

/**
 * Create an in-memory FsPort for testing.
 * Stores data in a Map<string, string> with directory tracking.
 */
export function createInMemoryFsPort(): FsPort {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  return {
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
      // Parent directory must exist
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
  };
}

// ---------------------------------------------------------------------------
// Repository — read/write with explicit FsPort
// ---------------------------------------------------------------------------

/**
 * Read and parse the team directory snapshot from a layout.
 * Throws on missing file, parse errors, or validation failures.
 */
export async function readTeamDirectory(
  fs: FsPort,
  layout: TeamDirectoryLayout,
): Promise<TeamDirectorySnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(layout.registryFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Team directory not found at ${layout.registryFile}`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse team directory JSON at ${layout.registryFile}`,
    );
  }

  const validation = validateTeamDirectorySnapshot(parsed);
  if (!validation.valid) {
    throw new Error(
      `Invalid team directory snapshot: ${validation.errors.join("; ")}`,
    );
  }

  return parsed as TeamDirectorySnapshot;
}

/**
 * Write a team directory snapshot to a layout.
 * Creates parent directories automatically via the FsPort.
 */
export async function writeTeamDirectory(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  snapshot: TeamDirectorySnapshot,
): Promise<void> {
  // Ensure parent directory exists (mkdir is idempotent)
  await fs.mkdir(layout.teamDir);

  const json = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(layout.registryFile, json);
}
