// Durable team roster store — project/run scoped paths, JSON snapshot schema,
// and explicit filesystem ports.
//
// No direct IO, no side effects in core logic. All filesystem access goes
// through FsPort. Time is an explicit input; no hidden Date reads.

import type { TeamRosterState } from "./team-roster.js";

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Team directory relative to the product state root. */
export const DEFAULT_TEAM_DIR = "team";

/** Project-scoped team directory layout. */
export type TeamDirectoryLayout = {
  teamDir: string;
  rosterFile: string;
  eventsFile: string;
  runsDir: string;
};

/** Run-scoped team directory layout under runs/<runId>/team/. */
export type RunScopedTeamPaths = {
  runTeamDir: string;
  runRosterFile: string;
  runEventsFile: string;
};

export function planTeamDirectoryLayout(
  stateRoot: string,
): TeamDirectoryLayout {
  const root = stateRoot.replace(/\/+$/, "");
  const teamDir = `${root}/${DEFAULT_TEAM_DIR}`;
  return {
    teamDir,
    rosterFile: `${teamDir}/roster.json`,
    eventsFile: `${teamDir}/events.jsonl`,
    runsDir: `${teamDir}/runs`,
  };
}

export function planRunScopedTeamPaths(
  stateRoot: string,
  runId: string,
): RunScopedTeamPaths {
  const root = stateRoot.replace(/\/+$/, "");
  const runTeamDir = `${root}/runs/${runId}/team`;
  return {
    runTeamDir,
    runRosterFile: `${runTeamDir}/roster.json`,
    runEventsFile: `${runTeamDir}/events.jsonl`,
  };
}

// ---------------------------------------------------------------------------
// Snapshot schema
// ---------------------------------------------------------------------------

export const DIRECTORY_SNAPSHOT_VERSION = 1;

export type TeamDirectorySnapshot = {
  schemaVersion: number;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  roster: TeamRosterState;
};

export type SnapshotValidationResult = {
  valid: boolean;
  errors: string[];
};

export function createTeamDirectorySnapshot(
  state: TeamRosterState,
  now: string,
  createdAt?: string,
): TeamDirectorySnapshot {
  return {
    schemaVersion: DIRECTORY_SNAPSHOT_VERSION,
    teamId: state.teamId,
    createdAt: createdAt ?? now,
    updatedAt: now,
    roster: state,
  };
}

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

  if (typeof s.teamId !== "string" || s.teamId.length === 0) {
    errors.push("Missing or invalid teamId");
  }

  if (typeof s.createdAt !== "string") {
    errors.push("Missing or invalid createdAt");
  }

  if (typeof s.updatedAt !== "string") {
    errors.push("Missing or invalid updatedAt");
  }

  if (!s.roster || typeof s.roster !== "object") {
    errors.push("Missing or invalid roster");
  } else {
    const roster = s.roster as Record<string, unknown>;
    if (typeof roster.teamId !== "string") {
      errors.push("roster.teamId is missing or not a string");
    } else if (roster.teamId !== s.teamId) {
      errors.push(
        `roster.teamId "${roster.teamId}" does not match snapshot teamId "${s.teamId}"`,
      );
    }
    if (!roster.members || typeof roster.members !== "object") {
      errors.push("roster.members is missing or not an object");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// FsPort — explicit filesystem adapter
// ---------------------------------------------------------------------------

export type FsPort = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
};

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
  };
}

// ---------------------------------------------------------------------------
// Repository — read/write with explicit FsPort
// ---------------------------------------------------------------------------

export async function readTeamDirectory(
  fs: FsPort,
  layout: TeamDirectoryLayout,
): Promise<TeamDirectorySnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(layout.rosterFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Team roster not found at ${layout.rosterFile}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse team roster JSON at ${layout.rosterFile}`);
  }

  const validation = validateTeamDirectorySnapshot(parsed);
  if (!validation.valid) {
    throw new Error(
      `Invalid team directory snapshot: ${validation.errors.join("; ")}`,
    );
  }

  return parsed as TeamDirectorySnapshot;
}

export async function writeTeamDirectory(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  snapshot: TeamDirectorySnapshot,
): Promise<void> {
  await fs.mkdir(layout.teamDir);
  await fs.writeFile(layout.rosterFile, JSON.stringify(snapshot, null, 2));
}
