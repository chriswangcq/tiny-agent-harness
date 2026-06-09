// Durable team roster store — project/run scoped paths, JSON snapshot schema,
// and explicit filesystem ports.
//
// No direct IO, no side effects in core logic. All filesystem access goes
// through FsPort. Time is an explicit input; no hidden Date reads.

import {
  applyTeamRosterEvent,
  createTeamRosterState,
  type TeamRosterState,
} from "./team-roster.js";
import type { TeamRosterEvent } from "./team-roster.js";
import {
  applySubAgentTeamEvent,
  createSubAgentTeamState,
  type SubAgentTeamState,
} from "./team.js";
import type { SubAgentTeamEvent } from "./team.js";

// ---------------------------------------------------------------------------
// Path planner — pure functions
// ---------------------------------------------------------------------------

/** Team directory relative to the product state root. */
export const DEFAULT_TEAM_DIR = "team";

/** Project-scoped team directory layout. */
export type TeamDirectoryLayout = {
  teamDir: string;
  stateFile: string;
  eventsFile: string;
  runsDir: string;
};

/** Run-scoped team directory layout under runs/<runId>/team/. */
export type RunScopedTeamPaths = {
  runTeamDir: string;
  runStateFile: string;
  runEventsFile: string;
};

export function planTeamDirectoryLayout(
  stateRoot: string,
): TeamDirectoryLayout {
  const root = stateRoot.replace(/\/+$/, "");
  const teamDir = `${root}/${DEFAULT_TEAM_DIR}`;
  return {
    teamDir,
    stateFile: `${teamDir}/state.json`,
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
    runStateFile: `${runTeamDir}/state.json`,
    runEventsFile: `${runTeamDir}/events.jsonl`,
  };
}

// ---------------------------------------------------------------------------
// Snapshot schema
// ---------------------------------------------------------------------------

export const DIRECTORY_SNAPSHOT_VERSION = 1;
export const DIRECTORY_EVENT_VERSION = 1;

export type TeamDirectorySnapshot = {
  schemaVersion: number;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  roster: TeamRosterState;
  taskState: SubAgentTeamState;
};

export type SnapshotValidationResult = {
  valid: boolean;
  errors: string[];
};

export type TeamDirectoryEvent =
  | {
      schemaVersion: typeof DIRECTORY_EVENT_VERSION;
      eventId: string;
      timestamp: string;
      teamId: string;
      kind: "team_created";
    }
  | {
      schemaVersion: typeof DIRECTORY_EVENT_VERSION;
      eventId: string;
      timestamp: string;
      teamId: string;
      kind: "roster_event";
      event: TeamRosterEvent;
    }
  | {
      schemaVersion: typeof DIRECTORY_EVENT_VERSION;
      eventId: string;
      timestamp: string;
      teamId: string;
      kind: "task_event";
      event: SubAgentTeamEvent;
    };

export type TeamDirectoryEventValidationResult = {
  valid: boolean;
  errors: string[];
};

export type AppendTeamDirectoryEventsResult = {
  status: "appended";
  appended: number;
  duplicates: number;
};

export type ReadTeamDirectoryEventsResult = {
  validEvents: TeamDirectoryEvent[];
  parseErrors: string[];
};

export function createTeamDirectorySnapshot(
  roster: TeamRosterState,
  taskState: SubAgentTeamState,
  now: string,
  createdAt?: string,
): TeamDirectorySnapshot {
  return {
    schemaVersion: DIRECTORY_SNAPSHOT_VERSION,
    teamId: roster.teamId,
    createdAt: createdAt ?? now,
    updatedAt: now,
    roster,
    taskState,
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

  if (!s.taskState || typeof s.taskState !== "object") {
    errors.push("Missing or invalid taskState");
  } else {
    const taskState = s.taskState as Record<string, unknown>;
    if (typeof taskState.teamId !== "string") {
      errors.push("taskState.teamId is missing or not a string");
    } else if (taskState.teamId !== s.teamId) {
      errors.push(
        `taskState.teamId "${taskState.teamId}" does not match snapshot teamId "${s.teamId}"`,
      );
    }
    if (!taskState.tasks || typeof taskState.tasks !== "object") {
      errors.push("taskState.tasks is missing or not an object");
    }
    if (!taskState.workers || typeof taskState.workers !== "object") {
      errors.push("taskState.workers is missing or not an object");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTeamDirectoryEvent(
  event: unknown,
): TeamDirectoryEventValidationResult {
  const errors: string[] = [];

  if (!event || typeof event !== "object") {
    return { valid: false, errors: ["Event is not an object"] };
  }

  const e = event as Record<string, unknown>;
  if (e.schemaVersion !== DIRECTORY_EVENT_VERSION) {
    errors.push(`Unsupported schemaVersion: ${e.schemaVersion}`);
  }
  if (typeof e.eventId !== "string" || e.eventId.length === 0) {
    errors.push("Missing or invalid eventId");
  }
  if (typeof e.timestamp !== "string" || e.timestamp.length === 0) {
    errors.push("Missing or invalid timestamp");
  }
  if (typeof e.teamId !== "string" || e.teamId.length === 0) {
    errors.push("Missing or invalid teamId");
  }
  if (
    e.kind !== "team_created" &&
    e.kind !== "roster_event" &&
    e.kind !== "task_event"
  ) {
    errors.push(`Unsupported kind: ${String(e.kind)}`);
  }

  if ((e.kind === "roster_event" || e.kind === "task_event") && !e.event) {
    errors.push("Missing event payload");
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
  const replayed = await tryReplayTeamDirectoryFromEvents(fs, layout);
  if (replayed) {
    return replayed;
  }

  let raw: string;
  try {
    raw = await fs.readFile(layout.stateFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Team state not found at ${layout.stateFile}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse team state JSON at ${layout.stateFile}`);
  }

  const validation = validateTeamDirectorySnapshot(parsed);
  if (!validation.valid) {
    throw new Error(
      `Invalid team directory snapshot: ${validation.errors.join("; ")}`,
    );
  }

  return parsed as TeamDirectorySnapshot;
}

export function replayTeamDirectoryEvents(
  events: TeamDirectoryEvent[],
): TeamDirectorySnapshot {
  let roster: TeamRosterState | undefined;
  let taskState: SubAgentTeamState | undefined;
  let teamId: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;

  for (const event of events) {
    if (event.kind === "team_created") {
      teamId = event.teamId;
      roster = createTeamRosterState(event.teamId);
      taskState = createSubAgentTeamState(event.teamId);
      createdAt ??= event.timestamp;
      updatedAt = event.timestamp;
      continue;
    }

    if (!roster || !taskState || !teamId) {
      throw new Error(
        `Cannot replay ${event.kind} before team_created (${event.eventId})`,
      );
    }

    if (event.teamId !== teamId) {
      throw new Error(
        `Cannot replay event ${event.eventId}: teamId ${event.teamId} does not match ${teamId}`,
      );
    }

    if (event.kind === "roster_event") {
      const result = applyTeamRosterEvent(roster, event.event);
      if (result.status === "rejected") {
        throw new Error(
          `Roster replay rejected ${event.eventId}: ${result.rejection.code}: ${result.rejection.message}`,
        );
      }
      roster = result.state;
    } else {
      const result = applySubAgentTeamEvent(taskState, event.event);
      if (result.status === "rejected") {
        throw new Error(
          `Task replay rejected ${event.eventId}: ${result.rejection.code}: ${result.rejection.message}`,
        );
      }
      taskState = result.state;
    }

    updatedAt = event.timestamp;
  }

  if (!teamId || !roster || !taskState || !createdAt || !updatedAt) {
    throw new Error("Cannot replay team directory events: missing team_created");
  }

  return {
    schemaVersion: DIRECTORY_SNAPSHOT_VERSION,
    teamId,
    createdAt,
    updatedAt,
    roster,
    taskState,
  };
}

export async function writeTeamDirectory(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  snapshot: TeamDirectorySnapshot,
): Promise<void> {
  await fs.mkdir(layout.teamDir);
  await fs.writeFile(layout.stateFile, JSON.stringify(snapshot, null, 2));
}

async function tryReplayTeamDirectoryFromEvents(
  fs: FsPort,
  layout: TeamDirectoryLayout,
): Promise<TeamDirectorySnapshot | undefined> {
  const events = await readTeamDirectoryEvents(fs, layout);
  if (events.parseErrors.length > 0) {
    throw new Error(
      `Cannot replay team events: ${events.parseErrors.join("; ")}`,
    );
  }
  if (events.validEvents.length === 0) {
    return undefined;
  }
  return replayTeamDirectoryEvents(events.validEvents);
}

export async function appendTeamDirectoryEvents(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  events: TeamDirectoryEvent[],
): Promise<AppendTeamDirectoryEventsResult> {
  if (events.length === 0) {
    return { status: "appended", appended: 0, duplicates: 0 };
  }

  await fs.mkdir(layout.teamDir);

  let existingContent = "";
  try {
    existingContent = await fs.readFile(layout.eventsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // New event stream.
  }

  const existingIds = new Set<string>();
  for (const line of existingContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { eventId?: unknown };
      if (typeof parsed.eventId === "string") {
        existingIds.add(parsed.eventId);
      }
    } catch {
      // Malformed historic lines are reported by readTeamDirectoryEvents.
    }
  }

  const lines: string[] = [];
  let duplicates = 0;
  for (const event of events) {
    const validation = validateTeamDirectoryEvent(event);
    if (!validation.valid) {
      throw new Error(
        `Invalid team directory event: ${validation.errors.join("; ")}`,
      );
    }
    if (existingIds.has(event.eventId)) {
      duplicates += 1;
      continue;
    }
    existingIds.add(event.eventId);
    lines.push(JSON.stringify(event));
  }

  if (lines.length > 0) {
    const separator =
      existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
    await fs.writeFile(
      layout.eventsFile,
      `${existingContent}${separator}${lines.join("\n")}\n`,
    );
  }

  return { status: "appended", appended: lines.length, duplicates };
}

export async function readTeamDirectoryEvents(
  fs: FsPort,
  layout: TeamDirectoryLayout,
): Promise<ReadTeamDirectoryEventsResult> {
  let raw: string;
  try {
    raw = await fs.readFile(layout.eventsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { validEvents: [], parseErrors: [] };
  }

  const validEvents: TeamDirectoryEvent[] = [];
  const parseErrors: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseErrors.push(`Failed to parse JSONL line: ${trimmed.slice(0, 100)}`);
      continue;
    }

    const validation = validateTeamDirectoryEvent(parsed);
    if (validation.valid) {
      validEvents.push(parsed as TeamDirectoryEvent);
    } else {
      parseErrors.push(
        `Invalid team directory event: ${validation.errors.join("; ")}`,
      );
    }
  }

  return { validEvents, parseErrors };
}
