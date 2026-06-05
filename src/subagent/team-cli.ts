// Team CLI — pure command parsing and service layer for contact + task subcommands.
// Consumes contact-registry, team FSM, and directory-store.
// Produces typed results; no shell/pty dependency.

import type {
  WorkerContact,
  WorkerContactStatus,
  ContactRegistryState,
  ContactRegistryEvent,
  ContactRegistryResult,
} from "./contact-registry.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  summarizeContactRegistry,
  lookupWorker,
  listWorkersByRole,
  listWorkersByStatus,
} from "./contact-registry.js";
import type {
  SubAgentTeamState,
  SubAgentTeamEvent,
  SubAgentTransitionResult,
} from "./team.js";
import {
  createSubAgentTeamState,
  applySubAgentTeamEvent,
  summarizeSubAgentTeam,
} from "./team.js";
import type {
  TeamDirectoryLayout,
  TeamDirectorySnapshot,
} from "./directory-store.js";
import {
  planTeamDirectoryLayout,
  planRunScopedTeamPaths,
  readTeamDirectory,
  writeTeamDirectory,
  createTeamDirectorySnapshot,
  type FsPort,
} from "./directory-store.js";
import {
  successEnvelope,
  failureEnvelope,
  type CliEnvelope,
  type SuccessEnvelopeInput,
} from "../cli/envelope.js";

// ---------------------------------------------------------------------------
// Tool name for JSON envelope
// ---------------------------------------------------------------------------
const TOOL_NAME = "team";

// ---------------------------------------------------------------------------
// Explicit dependency ports — no hidden time or id generation in core logic
// ---------------------------------------------------------------------------
export type TeamCliPorts = {
  /** ISO-8601 timestamp — explicit clock input */
  nowIso: () => string;
  /** Generate a unique event id — explicit id generation */
  newEventId: (prefix: string, seed: string) => string;
};

// ---------------------------------------------------------------------------
// Parsed command types
// ---------------------------------------------------------------------------
export type TeamParsedCommand =
  | TeamContactParsedCommand
  | TeamTaskParsedCommand;

// --- Contact subcommands ---
export type TeamContactParsedCommand =
  | { group: "contact"; sub: "list" }
  | { group: "contact"; sub: "show"; workerId: string }
  | {
      group: "contact";
      sub: "register";
      workerId: string;
      role: string;
      workspace: string;
      branch: string;
      imChannel: string;
      allowedActions: string[];
    }
  | {
      group: "contact";
      sub: "update";
      workerId: string;
      patch: Record<string, unknown>;
    }
  | {
      group: "contact";
      sub: "status";
      workerId: string;
      status: WorkerContactStatus;
    }
  | {
      group: "contact";
      sub: "heartbeat";
      workerId: string;
    }
  | { group: "contact"; sub: "terminate"; workerId: string };

// --- Task subcommands ---
export type TeamTaskParsedCommand =
  | { group: "task"; sub: "create"; taskId: string; title: string }
  | { group: "task"; sub: "list" }
  | { group: "task"; sub: "show"; taskId: string }
  | {
      group: "task";
      sub: "assign";
      taskId: string;
      workerId: string;
    }
  | {
      group: "task";
      sub: "start";
      taskId: string;
    }
  | {
      group: "task";
      sub: "succeed";
      taskId: string;
      output?: string;
    }
  | {
      group: "task";
      sub: "fail";
      taskId: string;
      error: string;
    }
  | {
      group: "task";
      sub: "cancel";
      taskId: string;
      reason?: string;
    };

// ---------------------------------------------------------------------------
// Parsed result
// ---------------------------------------------------------------------------
export type TeamParseResult =
  | { ok: true; command: TeamParsedCommand }
  | { ok: false; error: string; helpText?: string };

// ---------------------------------------------------------------------------
// In-memory service state
// ---------------------------------------------------------------------------
export type TeamServiceState = {
  contactRegistry: ContactRegistryState;
  taskState: SubAgentTeamState;
};

export function createTeamServiceState(
  registryId?: string,
  teamId?: string,
): TeamServiceState {
  return {
    contactRegistry: createContactRegistryState(
      registryId ?? "default-registry",
    ),
    taskState: createSubAgentTeamState(teamId ?? "default-team"),
  };
}

// ---------------------------------------------------------------------------
// Pure command parser
// ---------------------------------------------------------------------------
export function parseTeamArgs(args: string[]): TeamParseResult {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { ok: false, error: "Missing subcommand", helpText: HELP_TEXT };
  }

  const group = args[0];
  if (group !== "contact" && group !== "task") {
    return {
      ok: false,
      error: `Unknown team group: "${group}". Expected "contact" or "task".`,
      helpText: HELP_TEXT,
    };
  }

  const rest = args.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return {
      ok: false,
      error: `Missing ${group} subcommand.`,
      helpText: group === "contact" ? CONTACT_HELP : TASK_HELP,
    };
  }

  if (group === "contact") {
    return parseContactArgs(rest);
  }
  return parseTaskArgs(rest);
}

function parseContactArgs(args: string[]): TeamParseResult {
  const sub = args[0];
  switch (sub) {
    case "list":
      return { ok: true, command: { group: "contact", sub: "list" } };

    case "show": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team contact show <workerId>",
          helpText: CONTACT_HELP,
        };
      }
      return {
        ok: true,
        command: { group: "contact", sub: "show", workerId: args[1] },
      };
    }

    case "register": {
      // register <workerId> <role> <workspace> <branch> <imChannel> [actions...]
      if (args.length < 6) {
        return {
          ok: false,
          error:
            "Usage: team contact register <workerId> <role> <workspace> <branch> <imChannel> [allowedAction...]",
          helpText: CONTACT_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "contact",
          sub: "register",
          workerId: args[1],
          role: args[2],
          workspace: args[3],
          branch: args[4],
          imChannel: args[5],
          allowedActions: args.slice(6),
        },
      };
    }

    case "update": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team contact update <workerId> --json <patch>",
          helpText: CONTACT_HELP,
        };
      }
      // Accept --json flag with JSON patch
      let patch: Record<string, unknown> = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--json" && i + 1 < args.length) {
          try {
            patch = JSON.parse(args[i + 1]);
          } catch {
            return {
              ok: false,
              error: "Invalid JSON for --json: could not parse.",
            };
          }
          break;
        }
      }
      return {
        ok: true,
        command: {
          group: "contact",
          sub: "update",
          workerId: args[1],
          patch,
        },
      };
    }

    case "status": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: team contact status <workerId> <status>",
          helpText: CONTACT_HELP,
        };
      }
      const status = args[2] as WorkerContactStatus;
      const validStatuses: WorkerContactStatus[] = [
        "active",
        "idle",
        "stale",
        "offline",
        "terminated",
      ];
      if (!validStatuses.includes(status)) {
        return {
          ok: false,
          error: `Invalid status "${status}". Valid: ${validStatuses.join(", ")}`,
        };
      }
      return {
        ok: true,
        command: {
          group: "contact",
          sub: "status",
          workerId: args[1],
          status,
        },
      };
    }

    case "heartbeat": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team contact heartbeat <workerId>",
          helpText: CONTACT_HELP,
        };
      }
      return {
        ok: true,
        command: { group: "contact", sub: "heartbeat", workerId: args[1] },
      };
    }

    case "terminate": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team contact terminate <workerId>",
          helpText: CONTACT_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "contact",
          sub: "terminate",
          workerId: args[1],
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown contact subcommand: "${sub}"`,
        helpText: CONTACT_HELP,
      };
  }
}

function parseTaskArgs(args: string[]): TeamParseResult {
  const sub = args[0];
  switch (sub) {
    case "create": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: team task create <taskId> <title>",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "create",
          taskId: args[1],
          title: args[2],
        },
      };
    }

    case "list":
      return { ok: true, command: { group: "task", sub: "list" } };

    case "show": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team task show <taskId>",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: { group: "task", sub: "show", taskId: args[1] },
      };
    }

    case "assign": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: team task assign <taskId> <workerId>",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "assign",
          taskId: args[1],
          workerId: args[2],
        },
      };
    }

    case "start": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team task start <taskId>",
          helpText: TASK_HELP,
        };
      }
      return {
        ok: true,
        command: { group: "task", sub: "start", taskId: args[1] },
      };
    }

    case "succeed": {
      if (args.length < 2) {
        return {
          ok: false,
          error: "Usage: team task succeed <taskId> [--output <json>]",
          helpText: TASK_HELP,
        };
      }
      let output: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--output" && i + 1 < args.length) {
          output = args[i + 1];
          break;
        }
      }
      return {
        ok: true,
        command: {
          group: "task",
          sub: "succeed",
          taskId: args[1],
          output,
        },
      };
    }

    case "fail": {
      if (args.length < 3) {
        return {
          ok: false,
          error: "Usage: team task fail <taskId> <error>",
          helpText: TASK_HELP,
        };
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
        return {
          ok: false,
          error: "Usage: team task cancel <taskId> [reason]",
          helpText: TASK_HELP,
        };
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

// ---------------------------------------------------------------------------
// Service handlers — return CliEnvelope
// ---------------------------------------------------------------------------
export function handleContactCommand(
  ports: TeamCliPorts,
  state: TeamServiceState,
  cmd: TeamContactParsedCommand,
  cwd?: string,
): CliEnvelope {
  const base: SuccessEnvelopeInput = { tool: TOOL_NAME, cwd };

  switch (cmd.sub) {
    case "list": {
      const summary = summarizeContactRegistry(state.contactRegistry);
      return successEnvelope({ ...base, extra: { command: "contact list", result: summary } });
    }

    case "show": {
      const worker = lookupWorker(state.contactRegistry, cmd.workerId);
      if (!worker) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "UNKNOWN_WORKER",
          error: `Worker "${cmd.workerId}" not found.`,
        });
      }
      return successEnvelope({ ...base, extra: { command: "contact show", workerId: cmd.workerId, result: worker } });
    }

    case "register": {
      const event: ContactRegistryEvent = {
        kind: "worker_registered",
        eventId: `evt-${ports.newEventId("evt", cmd.workerId)}`,
        workerId: cmd.workerId,
        role: cmd.role,
        workspace: cmd.workspace,
        branch: cmd.branch,
        imChannel: cmd.imChannel,
        allowedActions: cmd.allowedActions,
      };
      const result = applyContactRegistryEvent(
        state.contactRegistry,
        event,
      );
      if (result.status === "applied") {
        state.contactRegistry = result.state;
        return successEnvelope({ ...base, extra: { command: "contact register", workerId: cmd.workerId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "REGISTER_FAILED",
        error: `Register failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "update": {
      const allowedFields = [
        "role",
        "workspace",
        "branch",
        "runId",
        "imChannel",
        "ledgerId",
        "ticket",
        "currentTask",
        "allowedActions",
      ];
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(cmd.patch)) {
        if (allowedFields.includes(key)) {
          patch[key] = value;
        }
      }
      if (Object.keys(patch).length === 0) {
        return failureEnvelope({
          tool: TOOL_NAME,
          cwd,
          errorCode: "NO_VALID_FIELDS",
          error: "No valid fields to update.",
        });
      }
      const event: ContactRegistryEvent = {
        kind: "worker_updated",
        eventId: `evt-${ports.newEventId("evt", cmd.workerId)}-update`,
        workerId: cmd.workerId,
        patch,
      };
      const result = applyContactRegistryEvent(
        state.contactRegistry,
        event,
      );
      if (result.status === "applied") {
        state.contactRegistry = result.state;
        return successEnvelope({ ...base, extra: { command: "contact update", workerId: cmd.workerId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "UPDATE_FAILED",
        error: `Update failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "status": {
      const event: ContactRegistryEvent = {
        kind: "worker_status_changed",
        eventId: `evt-${ports.newEventId("evt", cmd.workerId)}-status`,
        workerId: cmd.workerId,
        status: cmd.status,
      };
      const result = applyContactRegistryEvent(
        state.contactRegistry,
        event,
      );
      if (result.status === "applied") {
        state.contactRegistry = result.state;
        return successEnvelope({ ...base, extra: { command: "contact status", workerId: cmd.workerId, status: cmd.status } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "STATUS_CHANGE_FAILED",
        error: `Status change failed: ${result.status}`,
        details:
          result.status === "rejected" ? result.rejection :
          result.status === "duplicate" ? "already at target status" :
          undefined,
      });
    }

    case "heartbeat": {
      const event: ContactRegistryEvent = {
        kind: "worker_heartbeat",
        eventId: `evt-${ports.newEventId("evt", cmd.workerId)}-heartbeat`,
        workerId: cmd.workerId,
        timestamp: ports.nowIso(),
      };
      const result = applyContactRegistryEvent(
        state.contactRegistry,
        event,
      );
      if (result.status === "applied") {
        state.contactRegistry = result.state;
        return successEnvelope({ ...base, extra: { command: "contact heartbeat", workerId: cmd.workerId, timestamp: event.timestamp } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "HEARTBEAT_FAILED",
        error: `Heartbeat failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "terminate": {
      const event: ContactRegistryEvent = {
        kind: "worker_terminated",
        eventId: `evt-${ports.newEventId("evt", cmd.workerId)}-terminate`,
        workerId: cmd.workerId,
      };
      const result = applyContactRegistryEvent(
        state.contactRegistry,
        event,
      );
      if (result.status === "applied" || result.status === "duplicate") {
        state.contactRegistry = result.state;
        return successEnvelope({ ...base, extra: { command: "contact terminate", workerId: cmd.workerId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TERMINATE_FAILED",
        error: `Terminate failed: ${result.status}`,
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
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task create", taskId: cmd.taskId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_CREATE_FAILED",
        error: `Task create failed: ${result.status}`,
        details:
          result.status === "rejected" ? result.rejection :
          result.status === "duplicate" ? "task already exists" :
          undefined,
      });
    }

    case "list": {
      const summary = summarizeSubAgentTeam(state.taskState);
      return successEnvelope({ ...base, extra: { command: "task list", result: summary } });
    }

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
      return successEnvelope({ ...base, extra: { command: "task show", taskId: cmd.taskId, result: task } });
    }

    case "assign": {
      const event: SubAgentTeamEvent = {
        kind: "task_assigned",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-assign`,
        taskId: cmd.taskId,
        workerId: cmd.workerId,
      };
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task assign", taskId: cmd.taskId, workerId: cmd.workerId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_ASSIGN_FAILED",
        error: `Task assign failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "start": {
      const event: SubAgentTeamEvent = {
        kind: "task_started",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-start`,
        taskId: cmd.taskId,
      };
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task start", taskId: cmd.taskId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_START_FAILED",
        error: `Task start failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "succeed": {
      let output: unknown = undefined;
      if (cmd.output) {
        try {
          output = JSON.parse(cmd.output);
        } catch {
          output = cmd.output;
        }
      }
      const event: SubAgentTeamEvent = {
        kind: "task_succeeded",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-succeed`,
        taskId: cmd.taskId,
        output,
      };
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task succeed", taskId: cmd.taskId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_SUCCEED_FAILED",
        error: `Task succeed failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "fail": {
      const event: SubAgentTeamEvent = {
        kind: "task_failed",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-fail`,
        taskId: cmd.taskId,
        error: cmd.error,
      };
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task fail", taskId: cmd.taskId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_FAIL_FAILED",
        error: `Task fail failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }

    case "cancel": {
      const event: SubAgentTeamEvent = {
        kind: "task_cancelled",
        eventId: `evt-${ports.newEventId("evt", cmd.taskId)}-cancel`,
        taskId: cmd.taskId,
        reason: cmd.reason,
      };
      const result = applySubAgentTeamEvent(state.taskState, event);
      if (result.status === "applied") {
        state.taskState = result.state;
        return successEnvelope({ ...base, extra: { command: "task cancel", taskId: cmd.taskId } });
      }
      return failureEnvelope({
        tool: TOOL_NAME,
        cwd,
        errorCode: "TASK_CANCEL_FAILED",
        error: `Task cancel failed: ${result.status}`,
        details: result.status === "rejected" ? result.rejection : undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------
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
  if (cmd.group === "contact") {
    return handleContactCommand(ports, state, cmd, cwd);
  }
  return handleTaskCommand(ports, state, cmd, cwd);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
export const CONTACT_HELP = `Usage: tiny-agent team contact <subcommand> [options]

Contact subcommands:
  list                              List all registered workers
  show <workerId>                   Show worker details
  register <wId> <role> <ws> <br> <ch> [actions...]
                                    Register a new worker
  update <workerId> --json <patch>  Update worker fields
  status <workerId> <status>        Change worker status
                                    (active|idle|stale|offline|terminated)
  heartbeat <workerId>              Record heartbeat (now)
  terminate <workerId>              Terminate a worker

Options:
  --json                            Output JSON envelope (default)`;

export const TASK_HELP = `Usage: tiny-agent team task <subcommand> [options]

Task subcommands:
  create <taskId> <title>           Create a new task
  list                              List all tasks and summary
  show <taskId>                     Show task details
  assign <taskId> <workerId>        Assign task to worker
  start <taskId>                    Start task execution
  succeed <taskId> [--output <json>] Mark task as succeeded
  fail <taskId> <error>             Mark task as failed
  cancel <taskId> [reason]          Cancel a task

Options:
  --json                            Output JSON envelope (default)`;

export const HELP_TEXT = `Usage: tiny-agent team <group> [options]

Team subcommands:
  team contact <subcommand>         Contact/worker directory management
  team task <subcommand>            Task lifecycle management

Groups:
  contact   Worker registration, lookup, status, heartbeat
  task      Task creation, assignment, execution, completion

Options:
  --json    Output JSON envelope (default)
  --help    Show this help or group help

Examples:
  tiny-agent team contact list
  tiny-agent team contact register w1 coder /ws feat/x default
  tiny-agent team contact status w1 active
  tiny-agent team task create t1 "Inspect issue"
  tiny-agent team task assign t1 w1
  tiny-agent team task start t1
  tiny-agent team task succeed t1

For group-specific help:
  tiny-agent team contact --help
  tiny-agent team task --help`;
