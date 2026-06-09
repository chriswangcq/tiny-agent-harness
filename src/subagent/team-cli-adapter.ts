// Project-scoped team CLI adapter.
//
// Pure command handling lives in team-cli.ts. This adapter is the explicit
// effect boundary: load/save durable team state and deliver task assignment
// instructions through run-scoped IM.

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { failureEnvelope, type CliEnvelope } from "../cli/envelope.js";
import { ImCliTransport } from "../im/transport.js";
import type { UserMessage } from "../types/environment.js";
import {
  createTeamDirectorySnapshot,
  planTeamDirectoryLayout,
  readTeamDirectory,
  writeTeamDirectory,
  type FsPort,
  type TeamDirectorySnapshot,
} from "./directory-store.js";
import {
  createTeamServiceState,
  executeTeamCommand,
  parseTeamArgs,
  recordTaskDispatchFailed,
  recordTaskDispatchSent,
  type TeamCliPorts,
  type TeamServiceState,
  type TeamTaskDispatchPlan,
} from "./team-cli.js";

const TOOL_NAME = "team";

export type TeamImDispatchPort = {
  postUserMessage: (input: {
    stateRoot: string;
    runId: string;
    message: UserMessage;
  }) => Promise<void>;
};

export type TeamCliAdapterPorts = TeamCliPorts & {
  fs: FsPort;
  im: TeamImDispatchPort;
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
  const parsed = parseTeamArgs(args);
  if (!parsed.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "PARSE_ERROR",
      error: parsed.error,
      details: { helpText: parsed.helpText },
    });
  }

  const layout = planTeamDirectoryLayout(options.stateRoot);
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
      taskState: snapshot.taskState,
    };
    createdAt = snapshot.createdAt;
  }

  const result = executeTeamCommand(ports, state, args, options.cwd);
  if (!result.ok) {
    return result;
  }

  const dispatch = readDispatchPlan(result);
  if (dispatch) {
    const dispatchResult = await deliverDispatch(ports, state, dispatch, options);
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
    if (!dispatchResult.ok) {
      return dispatchResult;
    }
    return {
      ...result,
      dispatch: {
        ...dispatch,
        status: "sent",
      },
    };
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
    newMessageId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${Date.now()}-${seed}-${counter}`;
    },
    im: {
      async postUserMessage(input) {
        const baseDir = path.join(input.stateRoot, "runs", input.runId, "im");
        await new ImCliTransport({ baseDir }).post(input.message);
      },
    },
  };
}

async function deliverDispatch(
  ports: TeamCliAdapterPorts,
  state: TeamServiceState,
  dispatch: TeamTaskDispatchPlan,
  options: ExecuteTeamAdapterOptions,
): Promise<CliEnvelope> {
  if (!dispatch.runId) {
    const error = `Member "${dispatch.memberId}" has no runId; cannot choose a run-scoped IM inbox.`;
    recordTaskDispatchFailed(ports, state, dispatch, error);
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "TEAM_DISPATCH_TARGET_MISSING",
      error,
      details: { dispatch },
    });
  }

  try {
    await ports.im.postUserMessage({
      stateRoot: options.stateRoot,
      runId: dispatch.runId,
      message: dispatch.message,
    });
  } catch (error) {
    const message = `Failed to dispatch task ${dispatch.taskId} to ${dispatch.memberId}: ${formatError(error)}`;
    recordTaskDispatchFailed(ports, state, dispatch, message);
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd: options.cwd,
      errorCode: "TEAM_DISPATCH_FAILED",
      error: message,
      details: { dispatch },
    });
  }

  recordTaskDispatchSent(ports, state, dispatch);
  return { ok: true, tool: TOOL_NAME, version: "0.1.0" };
}

async function writeCurrentState(
  fs: FsPort,
  layout: ReturnType<typeof planTeamDirectoryLayout>,
  state: TeamServiceState,
  now: string,
  createdAt?: string,
): Promise<void> {
  const snapshot = createTeamDirectorySnapshot(
    state.roster,
    state.taskState,
    now,
    createdAt,
  );
  await writeTeamDirectory(fs, layout, snapshot);
}

async function writeCurrentStateOrFailure(
  fs: FsPort,
  layout: ReturnType<typeof planTeamDirectoryLayout>,
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

function readDispatchPlan(envelope: CliEnvelope): TeamTaskDispatchPlan | undefined {
  if (!envelope.ok) {
    return undefined;
  }
  const dispatch = envelope.dispatch;
  if (!dispatch || typeof dispatch !== "object") {
    return undefined;
  }
  return dispatch as TeamTaskDispatchPlan;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
