// Team CLI — pure command parsing and service layer for lightweight team
// roster commands. Work instructions are delivered through IM, not a team-owned
// task FSM.

import type {
  TeamMemberStatus,
  TeamRosterEvent,
  TeamRosterState,
} from "./team-roster.js";
import {
  applyTeamRosterEvent,
  createTeamRosterState,
  lookupMember,
  summarizeTeamRoster,
} from "./team-roster.js";
import {
  successEnvelope,
  failureEnvelope,
  type CliEnvelope,
  type SuccessEnvelopeInput,
} from "../cli/envelope.js";
import type { TeamDirectoryEvent } from "./directory-store.js";
import { DIRECTORY_EVENT_VERSION } from "./directory-store.js";

const TOOL_NAME = "team";

export type TeamCliPorts = {
  nowIso: () => string;
  newEventId: (prefix: string, seed: string) => string;
};

export type TeamParsedCommand =
  | TeamCreateParsedCommand
  | TeamMemberParsedCommand;

export type TeamCreateParsedCommand = {
  group: "create";
  teamId: string;
};

export type TeamMemberParsedCommand =
  | {
      group: "member";
      sub: "list";
      role?: string;
      status?: TeamMemberStatus;
    }
  | { group: "member"; sub: "show"; memberId: string }
  | {
      group: "member";
      sub: "add";
      memberId: string;
      role: string;
      channel: string;
      metadata?: Record<string, string>;
    }
  | {
      group: "member";
      sub: "update";
      memberId: string;
      patch: Record<string, unknown>;
    }
  | {
      group: "member";
      sub: "status";
      memberId: string;
      status: TeamMemberStatus;
    }
  | {
      group: "member";
      sub: "heartbeat";
      memberId: string;
      evidence?: string;
    }
  | { group: "member"; sub: "terminate"; memberId: string; reason?: string };

export type TeamParseResult =
  | { ok: true; command: TeamParsedCommand }
  | { ok: false; error: string; helpText?: string };

export type TeamServiceState = {
  roster: TeamRosterState;
  events: TeamDirectoryEvent[];
};

export function createTeamServiceState(teamId = "default-team"): TeamServiceState {
  return {
    roster: createTeamRosterState(teamId),
    events: [],
  };
}

export function parseTeamArgs(args: string[]): TeamParseResult {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { ok: false, error: "Missing subcommand", helpText: HELP_TEXT };
  }

  const group = args[0];
  if (group === "create") {
    if (args.length < 2) {
      return { ok: false, error: "Usage: tiny-agent team create <teamId>", helpText: HELP_TEXT };
    }
    return { ok: true, command: { group: "create", teamId: args[1] } };
  }

  if (group !== "member") {
    return {
      ok: false,
      error: `Unknown team group: "${group}". Expected "create" or "member". Use tiny-agent im admin post to send work instructions from an external control edge.`,
      helpText: HELP_TEXT,
    };
  }

  const rest = args.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return {
      ok: false,
      error: `Missing ${group} subcommand.`,
      helpText: MEMBER_HELP,
    };
  }

  return parseMemberArgs(rest);
}

function parseMemberArgs(args: string[]): TeamParseResult {
  const sub = args[0];
  switch (sub) {
    case "list": {
      const role = readFlagValue(args, "--role");
      const rawStatus = readFlagValue(args, "--status");
      const status = rawStatus ? parseStatus(rawStatus) : undefined;
      if (rawStatus && !status) {
        return { ok: false, error: `Invalid status "${rawStatus}".` };
      }
      return { ok: true, command: { group: "member", sub: "list", role, status } };
    }

    case "show": {
      if (args.length < 2) {
        return { ok: false, error: "Usage: tiny-agent team member show <memberId>", helpText: MEMBER_HELP };
      }
      return { ok: true, command: { group: "member", sub: "show", memberId: args[1] } };
    }

    case "add": {
      if (args.length < 4) {
        return {
          ok: false,
          error: "Usage: tiny-agent team member add <memberId> <role> <channel> [--metadata <json>]",
          helpText: MEMBER_HELP,
        };
      }
      const metadataResult = parseMetadataFlag(args);
      if (!metadataResult.ok) {
        return metadataResult;
      }
      return {
        ok: true,
        command: {
          group: "member",
          sub: "add",
          memberId: args[1],
          role: args[2],
          channel: args[3],
          metadata: metadataResult.metadata,
        },
      };
    }

    case "update": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: tiny-agent team member update <memberId> --json <patch>",
          helpText: MEMBER_HELP,
        };
      }
      const patchResult = parseJsonFlag(args, "--json");
      if (!patchResult.ok) {
        return patchResult;
      }
      return {
        ok: true,
        command: {
          group: "member",
          sub: "update",
          memberId: args[1],
          patch: patchResult.value,
        },
      };
    }

    case "status": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: tiny-agent team member status <memberId> <status>",
          helpText: MEMBER_HELP,
        };
      }
      const status = parseStatus(args[2]);
      if (!status) {
        return { ok: false, error: `Invalid status "${args[2]}".` };
      }
      return {
        ok: true,
        command: { group: "member", sub: "status", memberId: args[1], status },
      };
    }

    case "heartbeat": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: tiny-agent team member heartbeat <memberId> [--evidence <text>]",
          helpText: MEMBER_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "member",
          sub: "heartbeat",
          memberId: args[1],
          evidence: readFlagValue(args, "--evidence"),
        },
      };
    }

    case "terminate": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: tiny-agent team member terminate <memberId> [--reason <text>]",
          helpText: MEMBER_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "member",
          sub: "terminate",
          memberId: args[1],
          reason: readFlagValue(args, "--reason"),
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown member subcommand: "${sub}"`,
        helpText: MEMBER_HELP,
      };
  }
}

export function handleCreateCommand(
  ports: TeamCliPorts,
  state: TeamServiceState,
  cmd: TeamCreateParsedCommand,
  cwd?: string,
): CliEnvelope {
  state.roster = createTeamRosterState(cmd.teamId);
  state.events = [
    {
      schemaVersion: DIRECTORY_EVENT_VERSION,
      kind: "team_created",
      eventId: `evt-${ports.newEventId("evt", cmd.teamId)}-team-created`,
      timestamp: ports.nowIso(),
      teamId: cmd.teamId,
    },
  ];
  return successEnvelope({
    tool: TOOL_NAME,
    cwd,
    extra: { command: "team create", teamId: cmd.teamId, result: state.roster },
  });
}

export function handleMemberCommand(
  ports: TeamCliPorts,
  state: TeamServiceState,
  cmd: TeamMemberParsedCommand,
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  switch (cmd.sub) {
    case "list": {
      const summary = summarizeTeamRoster(state.roster);
      const members = Object.values(state.roster.members)
        .filter((member) => !cmd.role || member.role === cmd.role)
        .filter((member) => !cmd.status || member.status === cmd.status)
        .sort((left, right) => left.memberId.localeCompare(right.memberId));
      return successEnvelope({
        ...base,
        extra: { command: "member list", result: { ...summary, members } },
      });
    }

    case "show": {
      const member = lookupMember(state.roster, cmd.memberId);
      if (!member) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "UNKNOWN_MEMBER",
          error: `Member "${cmd.memberId}" not found.`,
        });
      }
      return successEnvelope({
        ...base,
        extra: { command: "member show", memberId: cmd.memberId, result: member },
      });
    }

    case "add": {
      const event: TeamRosterEvent = {
        kind: "member_added",
        eventId: `evt-${ports.newEventId("evt", cmd.memberId)}`,
        memberId: cmd.memberId,
        role: cmd.role,
        channel: cmd.channel,
        ...(cmd.metadata ? { metadata: cmd.metadata } : {}),
      };
      const result = applyTeamRosterEvent(state.roster, event);
      if (result.status === "applied") {
        state.roster = result.state;
        recordRosterEvent(ports, state, event);
        return successEnvelope({
          ...base,
          extra: { command: "member add", memberId: cmd.memberId, result: result.state.members[cmd.memberId] },
        });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "MEMBER_ADD_FAILED",
        error: `Member add failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "update": {
      const patch = filterMemberPatch(cmd.patch);
      if (!patch) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "NO_VALID_FIELDS",
          error: "No valid member fields to update.",
        });
      }
      const event: TeamRosterEvent = {
        kind: "member_updated",
        eventId: `evt-${ports.newEventId("evt", cmd.memberId)}-update`,
        memberId: cmd.memberId,
        patch,
      };
      const result = applyTeamRosterEvent(state.roster, event);
      if (result.status === "applied") {
        state.roster = result.state;
        recordRosterEvent(ports, state, event);
        return successEnvelope({
          ...base,
          extra: { command: "member update", memberId: cmd.memberId, result: result.state.members[cmd.memberId] },
        });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "MEMBER_UPDATE_FAILED",
        error: `Member update failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "status": {
      const event: TeamRosterEvent = {
        kind: "member_status_changed",
        eventId: `evt-${ports.newEventId("evt", cmd.memberId)}-status`,
        memberId: cmd.memberId,
        status: cmd.status,
      };
      const result = applyTeamRosterEvent(state.roster, event);
      if (result.status === "applied" || result.status === "duplicate") {
        state.roster = result.state;
        if (result.status === "applied") {
          recordRosterEvent(ports, state, event);
        }
        return successEnvelope({
          ...base,
          extra: { command: "member status", memberId: cmd.memberId, status: cmd.status },
        });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "MEMBER_STATUS_FAILED",
        error: `Member status failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "heartbeat": {
      const event: TeamRosterEvent = {
        kind: "member_heartbeat",
        eventId: `evt-${ports.newEventId("evt", cmd.memberId)}-heartbeat`,
        memberId: cmd.memberId,
        timestamp: ports.nowIso(),
        ...(cmd.evidence ? { evidence: cmd.evidence } : {}),
      };
      const result = applyTeamRosterEvent(state.roster, event);
      if (result.status === "applied") {
        state.roster = result.state;
        recordRosterEvent(ports, state, event);
        return successEnvelope({
          ...base,
          extra: {
            command: "member heartbeat",
            memberId: cmd.memberId,
            timestamp: event.timestamp,
          },
        });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "MEMBER_HEARTBEAT_FAILED",
        error: `Member heartbeat failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "terminate": {
      const event: TeamRosterEvent = {
        kind: "member_terminated",
        eventId: `evt-${ports.newEventId("evt", cmd.memberId)}-terminate`,
        memberId: cmd.memberId,
        reason: cmd.reason,
      };
      const result = applyTeamRosterEvent(state.roster, event);
      if (result.status === "applied" || result.status === "duplicate") {
        state.roster = result.state;
        if (result.status === "applied") {
          recordRosterEvent(ports, state, event);
        }
        return successEnvelope({
          ...base,
          extra: { command: "member terminate", memberId: cmd.memberId },
        });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "MEMBER_TERMINATE_FAILED",
        error: `Member terminate failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }
  }
}

export function executeTeamCommand(
  ports: TeamCliPorts,
  state: TeamServiceState,
  args: string[],
  cwd?: string,
): CliEnvelope {
  const parsed = parseTeamArgs(args);
  if (!parsed.ok) {
    return failureEnvelope({
      tool: TOOL_NAME,
      cwd,
      errorCode: "PARSE_ERROR",
      error: parsed.error,
      details: { helpText: parsed.helpText },
    });
  }

  const cmd = parsed.command;
  if (cmd.group === "create") {
    return handleCreateCommand(ports, state, cmd, cwd);
  }
  if (cmd.group === "member") {
    return handleMemberCommand(ports, state, cmd, cwd);
  }
  return failureEnvelope({
    tool: TOOL_NAME,
    cwd,
    errorCode: "UNKNOWN_TEAM_COMMAND",
    error: "Unknown team command. Use tiny-agent im admin post to send work instructions from an external control edge.",
  });
}

function recordRosterEvent(
  ports: TeamCliPorts,
  state: TeamServiceState,
  event: TeamRosterEvent,
): void {
  state.events.push({
    schemaVersion: DIRECTORY_EVENT_VERSION,
    kind: "roster_event",
    eventId: event.eventId,
    timestamp: ports.nowIso(),
    teamId: state.roster.teamId,
    event,
  });
}

function parseStatus(value: string): TeamMemberStatus | undefined {
  const statuses: TeamMemberStatus[] = [
    "active",
    "idle",
    "stale",
    "offline",
    "terminated",
  ];
  return statuses.includes(value as TeamMemberStatus)
    ? (value as TeamMemberStatus)
    : undefined;
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

type JsonFlagResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; helpText?: string };

function parseJsonFlag(args: string[], flag: string): JsonFlagResult {
  const raw = readFlagValue(args, flag);
  if (!raw) {
    return { ok: true, value: {} };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `${flag} must be a JSON object.` };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: `Invalid JSON for ${flag}: could not parse.` };
  }
}

type MetadataParseResult =
  | { ok: true; metadata?: Record<string, string> }
  | { ok: false; error: string; helpText?: string };

function parseMetadataFlag(args: string[]): MetadataParseResult {
  const raw = readFlagValue(args, "--metadata");
  if (!raw) {
    return { ok: true };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "--metadata must be a JSON object." };
    }
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `--metadata value for "${key}" must be a string.`,
        };
      }
      metadata[key] = value;
    }
    return { ok: true, metadata };
  } catch {
    return { ok: false, error: "Invalid JSON for --metadata: could not parse." };
  }
}

function filterMemberPatch(
  patch: Record<string, unknown>,
): Extract<TeamRosterEvent, { kind: "member_updated" }>["patch"] | undefined {
  const output: Extract<TeamRosterEvent, { kind: "member_updated" }>["patch"] = {};

  if (typeof patch.role === "string") output.role = patch.role;
  if (typeof patch.channel === "string") output.channel = patch.channel;
  if (typeof patch.runId === "string") output.runId = patch.runId;
  if (typeof patch.currentTask === "string") output.currentTask = patch.currentTask;

  if (patch.assignment && typeof patch.assignment === "object" && !Array.isArray(patch.assignment)) {
    const assignment = patch.assignment as Record<string, unknown>;
    if (typeof assignment.id === "string") {
      output.assignment = {
        id: assignment.id,
        ...(typeof assignment.title === "string" ? { title: assignment.title } : {}),
        ...(typeof assignment.status === "string" ? { status: assignment.status } : {}),
      };
    }
  }

  if (patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)) {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch.metadata)) {
      if (typeof value === "string") metadata[key] = value;
    }
    output.metadata = metadata;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

export const MEMBER_HELP = `Usage: tiny-agent team --team <teamId> member <subcommand> [options]

Member subcommands:
  list [--role <role>] [--status <status>]
                                    List team members
  show <memberId>                   Show member details
  add <memberId> <role> <channel> [--metadata <json>]
                                    Add a team member
  update <memberId> --json <patch>  Update role/channel/run/assignment/metadata
  status <memberId> <status>        Change member status
                                    (active|idle|stale|offline|terminated)
  heartbeat <memberId> [--evidence <text>]
                                    Record heartbeat using explicit clock port
  terminate <memberId> [--reason <text>]
                                    Terminate a member

Options:
  --team <teamId>                   Target team id (required)
  --json                            Output JSON envelope (default)`;

export const HELP_TEXT = `Usage: tiny-agent team <group> [--team <teamId>] [options]

Team subcommands:
  tiny-agent team create <teamId>              Create/reset a lightweight team state
  tiny-agent team --team <teamId> member <subcommand>
                                               Team roster management
  tiny-agent team lifecycle <subcommand> --team <teamId>
                                               Team-scoped worker lease/reaper/shutdown
  tiny-agent im admin pair --a user:main --b member:<teamId>/<memberId> --kind a2a
  tiny-agent im admin bind --run-id <runId> --self member:<teamId>/<memberId> --peer user:main --kind a2a
  tiny-agent im admin post --from user:main --to member:<teamId>/<memberId> --text <instruction>
                                               Send work instructions

Groups:
  create      Create a team identity for roster state
  member      Add, lookup, status, heartbeat, terminate
  lifecycle   Worker lease, lifecycle-status, reaper, shutdown

Options:
  --team    Target team id for member/lifecycle commands
  --json    Output JSON envelope (default)
  --help    Show this help or group help

Examples:
  tiny-agent team create team-p6
  tiny-agent team --team team-p6 member add w1 coder default --metadata '{"workspace":"/ws","branch":"codex/p6/01"}'
  tiny-agent team --team team-p6 member status w1 active
  tiny-agent im admin post --from user:main --to member:team-p6/coder-1 --text "Inspect issue and report evidence"
  tiny-agent team lifecycle lifecycle-status w1 --team team-p6 --run run-123

For group-specific help:
  tiny-agent team member --help
  tiny-agent team lifecycle --help`;
