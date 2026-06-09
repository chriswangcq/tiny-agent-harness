// Team CLI — pure command parsing and service layer for lightweight team
// roster plus task lifecycle commands. The team roster is a people/control-plane
// directory; workspace, branch, and ledger facts arrive through instructions or
// member metadata rather than mandatory runtime schema.

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
import type {
  SubAgentTeamEvent,
  SubAgentTeamState,
  SubAgentTask,
} from "./team.js";
import {
  applySubAgentTeamEvent,
  createSubAgentTeamState,
  summarizeSubAgentTeam,
} from "./team.js";
import {
  successEnvelope,
  failureEnvelope,
  type CliEnvelope,
  type SuccessEnvelopeInput,
} from "../cli/envelope.js";
import type { UserMessage } from "../types/environment.js";
import type { TeamDirectoryEvent } from "./directory-store.js";
import { DIRECTORY_EVENT_VERSION } from "./directory-store.js";

const TOOL_NAME = "team";

export type TeamCliPorts = {
  nowIso: () => string;
  newEventId: (prefix: string, seed: string) => string;
  newMessageId: (prefix: string, seed: string) => string;
};

export type TeamTaskDispatchPlan = {
  taskId: string;
  memberId: string;
  channel: string;
  runId?: string;
  message: UserMessage;
};

export type TeamParsedCommand =
  | TeamCreateParsedCommand
  | TeamMemberParsedCommand
  | TeamTaskParsedCommand;

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

export type TeamTaskParsedCommand =
  | { group: "task"; sub: "create"; taskId: string; title: string }
  | { group: "task"; sub: "list" }
  | { group: "task"; sub: "show"; taskId: string }
  | {
      group: "task";
      sub: "assign";
      taskId: string;
      memberId: string;
      instruction?: string;
    }
  | { group: "task"; sub: "start"; taskId: string }
  | { group: "task"; sub: "succeed"; taskId: string; output?: string }
  | { group: "task"; sub: "fail"; taskId: string; error: string }
  | { group: "task"; sub: "cancel"; taskId: string; reason?: string };

export type TeamParseResult =
  | { ok: true; command: TeamParsedCommand }
  | { ok: false; error: string; helpText?: string };

export type TeamServiceState = {
  roster: TeamRosterState;
  taskState: SubAgentTeamState;
  events: TeamDirectoryEvent[];
};

export function createTeamServiceState(teamId = "default-team"): TeamServiceState {
  return {
    roster: createTeamRosterState(teamId),
    taskState: createSubAgentTeamState(teamId),
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
      return { ok: false, error: "Usage: team create <teamId>", helpText: HELP_TEXT };
    }
    return { ok: true, command: { group: "create", teamId: args[1] } };
  }

  if (group !== "member" && group !== "task") {
    return {
      ok: false,
      error: `Unknown team group: "${group}". Expected "create", "member", or "task".`,
      helpText: HELP_TEXT,
    };
  }

  const rest = args.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return {
      ok: false,
      error: `Missing ${group} subcommand.`,
      helpText: group === "member" ? MEMBER_HELP : TASK_HELP,
    };
  }

  return group === "member" ? parseMemberArgs(rest) : parseTaskArgs(rest);
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
        return { ok: false, error: "Usage: team member show <memberId>", helpText: MEMBER_HELP };
      }
      return { ok: true, command: { group: "member", sub: "show", memberId: args[1] } };
    }

    case "add": {
      if (args.length < 4) {
        return {
          ok: false,
          error: "Usage: team member add <memberId> <role> <channel> [--metadata <json>]",
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
          error: "Usage: team member update <memberId> --json <patch>",
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
          error: "Usage: team member status <memberId> <status>",
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
          error: "Usage: team member heartbeat <memberId> [--evidence <text>]",
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
          error: "Usage: team member terminate <memberId> [--reason <text>]",
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

function parseTaskArgs(args: string[]): TeamParseResult {
  const sub = args[0];
  switch (sub) {
    case "create": {
      if (args.length < 3) {
        return { ok: false, error: "Usage: team task create <taskId> <title>", helpText: TASK_HELP };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "create",
          taskId: args[1],
          title: args.slice(2).join(" "),
        },
      };
    }

    case "list":
      return { ok: true, command: { group: "task", sub: "list" } };

    case "show": {
      if (args.length < 2) {
        return { ok: false, error: "Usage: team task show <taskId>", helpText: TASK_HELP };
      }
      return { ok: true, command: { group: "task", sub: "show", taskId: args[1] } };
    }

    case "assign": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: team task assign <taskId> <memberId> [--text <instruction>|--text-stdin]",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "assign",
          taskId: args[1],
          memberId: args[2],
          instruction: readFlagValue(args, "--text"),
        },
      };
    }

    case "start": {
      if (args.length < 2) {
        return { ok: false, error: "Usage: team task start <taskId>", helpText: TASK_HELP };
      }
      return { ok: true, command: { group: "task", sub: "start", taskId: args[1] } };
    }

    case "succeed": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team task succeed <taskId> [--output <json>]",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "succeed",
          taskId: args[1],
          output: readFlagValue(args, "--output"),
        },
      };
    }

    case "fail": {
      if (args.length < 3) {
        return { ok: false, error: "Usage: team task fail <taskId> <error>", helpText: TASK_HELP };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "fail",
          taskId: args[1],
          error: args.slice(2).join(" "),
        },
      };
    }

    case "cancel": {
      if (args.length < 2) {
        return { ok: false, error: "Usage: team task cancel <taskId> [reason]", helpText: TASK_HELP };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "cancel",
          taskId: args[1],
          reason: args.slice(2).join(" ") || undefined,
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown task subcommand: "${sub}"`,
        helpText: TASK_HELP,
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
  state.taskState = createSubAgentTeamState(cmd.teamId);
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
        addTaskMemberIfMissing(ports, state, cmd.memberId);
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
        if (cmd.status === "offline" || cmd.status === "terminated") {
          markTaskMemberOffline(ports, state, cmd.memberId);
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
        markTaskMemberOffline(ports, state, cmd.memberId);
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

export function handleTaskCommand(
  ports: TeamCliPorts,
  state: TeamServiceState,
  cmd: TeamTaskParsedCommand,
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  switch (cmd.sub) {
    case "create": {
      const event: SubAgentTeamEvent = {
        kind: "task_submitted",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}`,
        taskId: cmd.taskId,
        title: cmd.title,
      };
      return applyTaskEvent(ports, state, event, base, "TASK_CREATE_FAILED", {
        command: "task create",
        taskId: cmd.taskId,
      });
    }

    case "list":
      return successEnvelope({
        ...base,
        extra: { command: "task list", result: summarizeSubAgentTeam(state.taskState) },
      });

    case "show": {
      const task = state.taskState.tasks[cmd.taskId];
      if (!task) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "UNKNOWN_TASK",
          error: `Task "${cmd.taskId}" not found.`,
        });
      }
      return successEnvelope({
        ...base,
        extra: { command: "task show", taskId: cmd.taskId, result: task },
      });
    }

    case "assign": {
      const member = lookupMember(state.roster, cmd.memberId);
      if (!member) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "UNKNOWN_MEMBER",
          error: `Member "${cmd.memberId}" not found.`,
        });
      }
      addTaskMemberIfMissing(ports, state, cmd.memberId);
      const event: SubAgentTeamEvent = {
        kind: "task_assigned",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-assign`,
        taskId: cmd.taskId,
        workerId: cmd.memberId,
      };
      const assigned = applyTaskEvent(ports, state, event, base, "TASK_ASSIGN_FAILED", {
        command: "task assign",
        taskId: cmd.taskId,
        memberId: cmd.memberId,
      });
      if (!assigned.ok) {
        return assigned;
      }

      const task = state.taskState.tasks[cmd.taskId];
      if (!task) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "TASK_ASSIGN_FAILED",
          error: `Task "${cmd.taskId}" was not found after assignment.`,
        });
      }

      const dispatch = buildTaskDispatchPlan({
        ports,
        state,
        task,
        member,
        instruction: cmd.instruction,
      });
      const dispatchEvent: SubAgentTeamEvent = {
        kind: "task_dispatch_requested",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-dispatch-requested`,
        taskId: cmd.taskId,
        memberId: cmd.memberId,
        channel: dispatch.channel,
        messageId: dispatch.message.id,
        instruction: dispatch.message.text,
        timestamp: dispatch.message.createdAt,
      };
      const dispatchRequested = applySubAgentTeamEvent(state.taskState, dispatchEvent);
      if (dispatchRequested.status !== "applied") {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "TASK_DISPATCH_PLAN_FAILED",
          error: `Task dispatch plan failed: ${dispatchRequested.status}`,
          details:
            dispatchRequested.status === "rejected"
              ? dispatchRequested.rejection
              : undefined,
        });
      }
      state.taskState = dispatchRequested.state;
      recordTaskEvent(ports, state, dispatchEvent);

      return successEnvelope({
        ...base,
        extra: {
          command: "task assign",
          taskId: cmd.taskId,
          memberId: cmd.memberId,
          dispatch,
        },
      });
    }

    case "start": {
      const event: SubAgentTeamEvent = {
        kind: "task_started",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-start`,
        taskId: cmd.taskId,
      };
      return applyTaskEvent(ports, state, event, base, "TASK_START_FAILED", {
        command: "task start",
        taskId: cmd.taskId,
      });
    }

    case "succeed": {
      const event: SubAgentTeamEvent = {
        kind: "task_succeeded",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-succeed`,
        taskId: cmd.taskId,
        output: parseOptionalJson(cmd.output),
      };
      return applyTaskEvent(ports, state, event, base, "TASK_SUCCEED_FAILED", {
        command: "task succeed",
        taskId: cmd.taskId,
      });
    }

    case "fail": {
      const event: SubAgentTeamEvent = {
        kind: "task_failed",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-fail`,
        taskId: cmd.taskId,
        error: cmd.error,
      };
      return applyTaskEvent(ports, state, event, base, "TASK_FAIL_FAILED", {
        command: "task fail",
        taskId: cmd.taskId,
      });
    }

    case "cancel": {
      const event: SubAgentTeamEvent = {
        kind: "task_cancelled",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-cancel`,
        taskId: cmd.taskId,
        reason: cmd.reason,
      };
      return applyTaskEvent(ports, state, event, base, "TASK_CANCEL_FAILED", {
        command: "task cancel",
        taskId: cmd.taskId,
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
  return handleTaskCommand(ports, state, cmd, cwd);
}

export function recordTaskDispatchSent(
  ports: TeamCliPorts,
  state: TeamServiceState,
  dispatch: TeamTaskDispatchPlan,
): void {
  const event: SubAgentTeamEvent = {
    kind: "task_dispatch_sent",
    eventId: `evt-${ports.newEventId("evt", dispatch.taskId)}-dispatch-sent`,
    taskId: dispatch.taskId,
    messageId: dispatch.message.id,
    timestamp: ports.nowIso(),
  };
  const result = applySubAgentTeamEvent(state.taskState, event);
  if (result.status === "applied" || result.status === "duplicate") {
    state.taskState = result.state;
    if (result.status === "applied") {
      recordTaskEvent(ports, state, event);
    }
  }
}

export function recordTaskDispatchFailed(
  ports: TeamCliPorts,
  state: TeamServiceState,
  dispatch: TeamTaskDispatchPlan,
  error: string,
): void {
  const event: SubAgentTeamEvent = {
    kind: "task_dispatch_failed",
    eventId: `evt-${ports.newEventId("evt", dispatch.taskId)}-dispatch-failed`,
    taskId: dispatch.taskId,
    messageId: dispatch.message.id,
    timestamp: ports.nowIso(),
    error,
  };
  const result = applySubAgentTeamEvent(state.taskState, event);
  if (result.status === "applied" || result.status === "duplicate") {
    state.taskState = result.state;
    if (result.status === "applied") {
      recordTaskEvent(ports, state, event);
    }
  }
}

function buildTaskDispatchPlan(input: {
  ports: TeamCliPorts;
  state: TeamServiceState;
  task: SubAgentTask;
  member: NonNullable<ReturnType<typeof lookupMember>>;
  instruction?: string;
}): TeamTaskDispatchPlan {
  const createdAt = input.ports.nowIso();
  const instruction =
    input.instruction && input.instruction.trim().length > 0
      ? input.instruction
      : defaultTaskInstruction(input.state.roster.teamId, input.task, input.member);
  const message: UserMessage = {
    id: input.ports.newMessageId(
      "msg",
      `${input.state.roster.teamId}-${input.task.id}-${input.member.memberId}`,
    ),
    channel: input.member.channel,
    role: "user",
    text: instruction,
    createdAt,
    metadata: {
      from: "team",
      teamId: input.state.roster.teamId,
      taskId: input.task.id,
      memberId: input.member.memberId,
    },
  };

  return {
    taskId: input.task.id,
    memberId: input.member.memberId,
    channel: input.member.channel,
    runId: input.member.runId,
    message,
  };
}

function defaultTaskInstruction(
  teamId: string,
  task: SubAgentTask,
  member: NonNullable<ReturnType<typeof lookupMember>>,
): string {
  return [
    `Team ${teamId} assigned you task ${task.id}: ${task.title}`,
    "",
    `Role: ${member.role}`,
    `Channel: ${member.channel}`,
    "",
    "Work in your current tiny-agent session. Keep changes scoped to the task instructions you were given.",
    "Report progress, blockers, and final evidence back through IM using `im send --text-stdin`.",
  ].join("\n");
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

function recordTaskEvent(
  ports: TeamCliPorts,
  state: TeamServiceState,
  event: SubAgentTeamEvent,
): void {
  state.events.push({
    schemaVersion: DIRECTORY_EVENT_VERSION,
    kind: "task_event",
    eventId: event.eventId,
    timestamp: ports.nowIso(),
    teamId: state.roster.teamId,
    event,
  });
}

function applyTaskEvent(
  ports: TeamCliPorts,
  state: TeamServiceState,
  event: SubAgentTeamEvent,
  base: SuccessEnvelopeInput,
  errorCode: string,
  successExtra: Record<string, unknown>,
): CliEnvelope {
  const result = applySubAgentTeamEvent(state.taskState, event);
  if (result.status === "applied" || result.status === "duplicate") {
    state.taskState = result.state;
    if (result.status === "applied") {
      recordTaskEvent(ports, state, event);
    }
    return successEnvelope({ ...base, extra: successExtra });
  }
  return failureEnvelope({
    tool: TOOL_NAME,
    cwd: base.cwd,
    errorCode,
    error: `Task event failed: ${result.status}`,
    details: result.rejection,
  });
}

function addTaskMemberIfMissing(
  ports: TeamCliPorts,
  state: TeamServiceState,
  memberId: string,
): void {
  if (state.taskState.workers[memberId]) {
    return;
  }
  const event: SubAgentTeamEvent = {
    kind: "member_added",
    eventId: `evt-${ports.newEventId("evt", memberId)}-task-member`,
    workerId: memberId,
  };
  const result = applySubAgentTeamEvent(state.taskState, event);
  if (result.status === "applied") {
    state.taskState = result.state;
    recordTaskEvent(ports, state, event);
  }
}

function markTaskMemberOffline(
  ports: TeamCliPorts,
  state: TeamServiceState,
  memberId: string,
): void {
  if (!state.taskState.workers[memberId]) {
    return;
  }
  const event: SubAgentTeamEvent = {
    kind: "worker_offline",
    eventId: `evt-${ports.newEventId("evt", memberId)}-task-offline`,
    workerId: memberId,
  };
  const result = applySubAgentTeamEvent(state.taskState, event);
  if (result.status === "applied") {
    state.taskState = result.state;
    recordTaskEvent(ports, state, event);
  }
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

function parseOptionalJson(raw: string | undefined): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export const MEMBER_HELP = `Usage: tiny-agent team member <subcommand> [options]

Member subcommands:
  list [--role <role>] [--status <status>]
                                    List team members
  show <memberId>                   Show member details
  add <memberId> <role> <channel> [--metadata <json>]
                                    Add a team member
  update <memberId> --json <patch>  Update role/channel/run/task/metadata
  status <memberId> <status>        Change member status
                                    (active|idle|stale|offline|terminated)
  heartbeat <memberId> [--evidence <text>]
                                    Record heartbeat using explicit clock port
  terminate <memberId> [--reason <text>]
                                    Terminate a member

Options:
  --json                            Output JSON envelope (default)`;

export const TASK_HELP = `Usage: tiny-agent team task <subcommand> [options]

Task subcommands:
  create <taskId> <title>           Create a new task
  list                              List all tasks and summary
  show <taskId>                     Show task details
  assign <taskId> <memberId> [--text <instruction>]
                                    Assign task and dispatch instruction via IM
  start <taskId>                    Start task execution
  succeed <taskId> [--output <json>] Mark task as succeeded
  fail <taskId> <error>             Mark task as failed
  cancel <taskId> [reason]          Cancel a task

Options:
  --json                            Output JSON envelope (default)`;

export const HELP_TEXT = `Usage: tiny-agent team <group> [options]

Team subcommands:
  team create <teamId>              Create/reset a lightweight team state
  team member <subcommand>          Team roster management
  team task <subcommand>            Task lifecycle management
  team lifecycle <subcommand>       Run-scoped worker lease/reaper/shutdown

Groups:
  create      Create a team identity for roster/task state
  member      Add, lookup, status, heartbeat, terminate
  task        Task creation, assignment, execution, completion
  lifecycle   Worker lease, lifecycle-status, reaper, shutdown

Options:
  --json    Output JSON envelope (default)
  --help    Show this help or group help

Examples:
  tiny-agent team create team-p6
  tiny-agent team member add w1 coder default --metadata '{"workspace":"/ws","branch":"codex/p6/01"}'
  tiny-agent team member status w1 active
  tiny-agent team task create t1 "Inspect issue"
  tiny-agent team task assign t1 w1 --text "Inspect issue and report evidence"
  tiny-agent team lifecycle lifecycle-status w1 --run run-123

For group-specific help:
  tiny-agent team member --help
  tiny-agent team task --help
  tiny-agent team lifecycle --help`;
