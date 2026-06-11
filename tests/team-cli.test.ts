import { describe, expect, it } from "vitest";
import {
  HELP_TEXT,
  MEMBER_HELP,
  createTeamServiceState,
  executeTeamCommand,
  handleCreateCommand,
  handleMemberCommand,
  parseTeamArgs,
  type TeamCliPorts,
  type TeamServiceState,
} from "../src/subagent/team-cli.js";

let eventCounter = 0;

function fakePorts(): TeamCliPorts {
  eventCounter = 0;
  return {
    nowIso: () => "2026-06-05T23:00:00.000Z",
    newEventId: (prefix: string, seed: string) => {
      eventCounter += 1;
      return `${prefix}-${seed}-${eventCounter.toString().padStart(3, "0")}`;
    },
  };
}

describe("parseTeamArgs", () => {
  it("returns help for empty args", () => {
    const result = parseTeamArgs([]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.helpText).toBe(HELP_TEXT);
  });

  it("parses team create", () => {
    expect(parseTeamArgs(["create", "team-p6"])).toEqual({
      ok: true,
      command: { group: "create", teamId: "team-p6" },
    });
  });

  it("rejects removed task commands and points dispatch to IM", () => {
    const result = parseTeamArgs(["task", "assign", "t1", "w1"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Use tiny-agent im post");
      expect(result.helpText).toBe(HELP_TEXT);
    }
  });

  it("parses member list with optional filters", () => {
    const result = parseTeamArgs(["member", "list", "--role", "coder", "--status", "active"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({
        group: "member",
        sub: "list",
        role: "coder",
        status: "active",
      });
    }
  });

  it("parses member add metadata as optional string facts", () => {
    const result = parseTeamArgs([
      "member",
      "add",
      "w1",
      "coder",
      "default",
      "--metadata",
      '{"workspace":"/ws","branch":"feat/x","ledgerId":"ledger-1"}',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok && result.command.sub === "add") {
      expect(result.command.metadata).toEqual({
        workspace: "/ws",
        branch: "feat/x",
        ledgerId: "ledger-1",
      });
    }
  });

  it("rejects invalid metadata values", () => {
    const result = parseTeamArgs([
      "member",
      "add",
      "w1",
      "coder",
      "default",
      "--metadata",
      '{"attempt":1}',
    ]);
    expect(result.ok).toBe(false);
  });

  it("parses member status, heartbeat, and terminate", () => {
    const status = parseTeamArgs(["member", "status", "w1", "active"]);
    expect(status.ok).toBe(true);
    if (status.ok && status.command.sub === "status") {
      expect(status.command.status).toBe("active");
    }

    const heartbeat = parseTeamArgs(["member", "heartbeat", "w1", "--evidence", "commit abc"]);
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) {
      expect(heartbeat.command).toEqual({
        group: "member",
        sub: "heartbeat",
        memberId: "w1",
        evidence: "commit abc",
      });
    }

    const terminate = parseTeamArgs(["member", "terminate", "w1", "--reason", "done"]);
    expect(terminate.ok).toBe(true);
    if (terminate.ok) {
      expect(terminate.command).toEqual({
        group: "member",
        sub: "terminate",
        memberId: "w1",
        reason: "done",
      });
    }
  });

  it("returns member help for member --help", () => {
    const result = parseTeamArgs(["member", "--help"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.helpText).toBe(MEMBER_HELP);
  });
});

describe("team service commands", () => {
  function fresh(): TeamServiceState {
    return createTeamServiceState("test-team");
  }

  it("creates roster-only team state", () => {
    const state = fresh();
    const envelope = handleCreateCommand(fakePorts(), state, {
      group: "create",
      teamId: "team-p6",
    });
    expect(envelope.ok).toBe(true);
    expect(state.roster.teamId).toBe("team-p6");
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      kind: "team_created",
      teamId: "team-p6",
      timestamp: "2026-06-05T23:00:00.000Z",
    });
  });

  it("adds, updates, shows, and lists members", () => {
    const state = fresh();
    const ports = fakePorts();
    const add = handleMemberCommand(ports, state, {
      group: "member",
      sub: "add",
      memberId: "w1",
      role: "coder",
      channel: "default",
      metadata: { workspace: "/ws", branch: "feat/x" },
    });
    expect(add.ok).toBe(true);

    const update = handleMemberCommand(ports, state, {
      group: "member",
      sub: "update",
      memberId: "w1",
      patch: {
        runId: "run-worker-1",
        assignment: { id: "a1", title: "Inspect issue", status: "assigned" },
      },
    });
    expect(update.ok).toBe(true);

    const show = handleMemberCommand(ports, state, {
      group: "member",
      sub: "show",
      memberId: "w1",
    });
    expect(show.ok).toBe(true);
    if (show.ok) {
      expect(show.result).toMatchObject({
        memberId: "w1",
        role: "coder",
        channel: "default",
        runId: "run-worker-1",
        assignment: { id: "a1", title: "Inspect issue", status: "assigned" },
        metadata: { workspace: "/ws", branch: "feat/x" },
      });
    }

    const list = handleMemberCommand(ports, state, {
      group: "member",
      sub: "list",
      role: "coder",
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.result).toMatchObject({ totalMembers: 1 });
    }
  });

  it("updates member status and heartbeat with deterministic timestamp", () => {
    const state = fresh();
    const ports = fakePorts();
    handleMemberCommand(ports, state, {
      group: "member",
      sub: "add",
      memberId: "w1",
      role: "coder",
      channel: "default",
    });

    expect(handleMemberCommand(ports, state, {
      group: "member",
      sub: "status",
      memberId: "w1",
      status: "active",
    }).ok).toBe(true);

    const heartbeat = handleMemberCommand(ports, state, {
      group: "member",
      sub: "heartbeat",
      memberId: "w1",
    });
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) {
      expect(heartbeat.timestamp).toBe("2026-06-05T23:00:00.000Z");
    }

    expect(state.roster.members["w1"]?.status).toBe("active");
    expect(state.roster.members["w1"]?.lastHeartbeat).toBe("2026-06-05T23:00:00.000Z");
  });

  it("terminates a member without touching task state", () => {
    const state = fresh();
    const ports = fakePorts();
    handleMemberCommand(ports, state, {
      group: "member",
      sub: "add",
      memberId: "w1",
      role: "coder",
      channel: "default",
    });

    const terminate = handleMemberCommand(ports, state, {
      group: "member",
      sub: "terminate",
      memberId: "w1",
    });
    expect(terminate.ok).toBe(true);
    expect(state.roster.members["w1"]?.status).toBe("terminated");
    expect(state.events.every((event) => event.kind !== "task_event")).toBe(true);
  });
});

describe("executeTeamCommand", () => {
  it("dispatches create and member commands only", () => {
    const state = createTeamServiceState("initial");
    const ports = fakePorts();

    const create = executeTeamCommand(ports, state, ["create", "team-p6"]);
    expect(create.ok).toBe(true);
    expect(state.roster.teamId).toBe("team-p6");

    const member = executeTeamCommand(ports, state, ["member", "add", "w1", "coder", "default"]);
    expect(member.ok).toBe(true);

    const task = executeTeamCommand(ports, state, ["task", "create", "t1", "Inspect issue"]);
    expect(task.ok).toBe(false);
    if (!task.ok) {
      expect(task.errorCode).toBe("PARSE_ERROR");
      expect(task.error).toContain("Use tiny-agent im post");
    }
  });
});
