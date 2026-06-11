// Project-scoped team CLI adapter.
//
// Pure command handling lives in team-cli.ts. This adapter is the explicit
// effect boundary for loading and saving durable team roster state.

import * as nodeFs from "node:fs/promises";
import { failureEnvelope, type CliEnvelope } from "../cli/envelope.js";
import {
  appendTeamDirectoryEvents,
  createTeamDirectorySnapshot,
  planTeamScopedDirectoryLayout,
  readTeamDirectory,
  writeTeamDirectory,
  type FsPort,
  type TeamDirectoryLayout,
  type TeamDirectorySnapshot,
} from "./directory-store.js";
import {
  createTeamServiceState,
  executeTeamCommand,
  parseTeamArgs,
  type TeamCliPorts,
  type TeamParsedCommand,
  type TeamServiceState,
} from "./team-cli.js";

const TOOL_NAME = "team";

export type TeamCliAdapterPorts = TeamCliPorts & {
  fs: FsPort;
};

export type ExecuteTeamAdapterOptions = {
  stateRoot: string;
  cwd?: string;
};

export async function executeTeamAdapterCommand(
  ports: TeamCliAdapterPorts,
  args: string[],
  options: ExecuteTeamAdapterOptions,
): Promise<CliEnvelope> {
  const scopedArgs = extractTeamScope(args);
  if (!scopedArgs.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "PARSE_ERROR",
      error: scopedArgs.error,
    });
  }

  const parsed = parseTeamArgs(scopedArgs.args);
  if (!parsed.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "PARSE_ERROR",
      error: parsed.error,
      details: { helpText: parsed.helpText },
    });
  }

  const teamId = resolveExplicitTeamId(parsed.command, scopedArgs.teamId);
  if (!teamId.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "TEAM_ID_REQUIRED",
      error: teamId.error,
    });
  }
  const layout = planTeamScopedDirectoryLayout(options.stateRoot, teamId.teamId);
  let state: TeamServiceState;
  let createdAt: string | undefined;

  if (parsed.command.group === "create") {
    state = createTeamServiceState(parsed.command.teamId);
  } else {
    let snapshot: TeamDirectorySnapshot;
    try {
      snapshot = await readTeamDirectory(ports.fs, layout);
    } catch (error) {
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd: options.cwd,
        errorCode: "TEAM_STATE_NOT_FOUND",
        error: `Create a team first with: tiny-agent team create <teamId>. ${formatError(error)}`,
      });
    }
    state = {
      roster: snapshot.roster,
      events: [],
    };
    createdAt = snapshot.createdAt;
  }

  const result = executeTeamCommand(ports, state, scopedArgs.args, options.cwd);
  if (!result.ok) {
    return result;
  }

  if (state.events.length === 0) {
    return result;
  }

  const eventFailure = await appendEventsOrFailure(
    ports.fs,
    layout,
    state,
    0,
    options.cwd,
  );
  if (eventFailure.envelope) {
    return eventFailure.envelope;
  }

  const writeFailure = await writeCurrentStateOrFailure(
    ports.fs,
    layout,
    state,
    ports.nowIso(),
    createdAt,
    options.cwd,
  );
  if (writeFailure) {
    return writeFailure;
  }
  return result;
}

export function createNodeTeamCliAdapterPorts(): TeamCliAdapterPorts {
  let counter = 0;
  const fs: FsPort = {
    readFile: (filePath) => nodeFs.readFile(filePath, "utf-8"),
    async writeFile(filePath, data) {
      await nodeFs.writeFile(filePath, data, "utf-8");
    },
    async mkdir(dirPath) {
      await nodeFs.mkdir(dirPath, { recursive: true });
    },
  };

  return {
    fs,
    nowIso: () => new Date().toISOString(),
    newEventId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${Date.now()}-${seed}-${counter}`;
    },
  };
}

async function writeCurrentState(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  state: TeamServiceState,
  now: string,
  createdAt?: string,
): Promise<void> {
  const snapshot = createTeamDirectorySnapshot(
    state.roster,
    now,
    createdAt,
  );
  await writeTeamDirectory(fs, layout, snapshot);
}

async function appendEventsOrFailure(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  state: TeamServiceState,
  offset: number,
  cwd: string | undefined,
): Promise<{ nextOffset: number; envelope?: CliEnvelope }> {
  const events = state.events.slice(offset);
  if (events.length === 0) {
    return { nextOffset: state.events.length };
  }

  try {
    await appendTeamDirectoryEvents(fs, layout, events);
    return { nextOffset: state.events.length };
  } catch (error) {
    return {
      nextOffset: offset,
      envelope: failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TEAM_EVENT_APPEND_FAILED",
        error: `Failed to append team events: ${formatError(error)}`,
      }),
    };
  }
}

async function writeCurrentStateOrFailure(
  fs: FsPort,
  layout: TeamDirectoryLayout,
  state: TeamServiceState,
  now: string,
  createdAt: string | undefined,
  cwd: string | undefined,
): Promise<CliEnvelope | undefined> {
  try {
    await writeCurrentState(fs, layout, state, now, createdAt);
    return undefined;
  } catch (error) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "TEAM_STATE_WRITE_FAILED",
      error: `Failed to write team state: ${formatError(error)}`,
    });
  }
}

function extractTeamScope(args: string[]):
  | { ok: true; args: string[]; teamId?: string }
  | { ok: false; error: string } {
  const nextArgs: string[] = [];
  let teamId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--team") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "Missing value for --team" };
      }
      teamId = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      nextArgs.push(arg);
    }
  }

  return { ok: true, args: nextArgs, teamId };
}

function resolveExplicitTeamId(
  command: TeamParsedCommand,
  explicitTeamId: string | undefined,
): { ok: true; teamId: string } | { ok: false; error: string } {
  if (command.group === "create") {
    if (explicitTeamId && explicitTeamId !== command.teamId) {
      return {
        ok: false,
        error: `--team ${explicitTeamId} does not match created team ${command.teamId}`,
      };
    }
    return { ok: true, teamId: command.teamId };
  }

  if (!explicitTeamId) {
    return {
      ok: false,
      error: "Missing --team <teamId>; team state is stored under teams/<teamId>/",
    };
  }
  return { ok: true, teamId: explicitTeamId };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
