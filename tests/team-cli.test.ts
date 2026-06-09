import { describe, expect, it } from "vitest";
import {
  MEMBER_HELP,
  TASK_HELP,
  HELP_TEXT,
  createTeamServiceState,
  executeTeamCommand,
  handleCreateCommand,
  handleMemberCommand,
  handleTaskCommand,
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
    newMessageId: (prefix: string, seed: string) => {
      eventCounter += 1;
      return `${prefix}-${seed}-${eventCounter.toString().padStart(3, "0")}`;
    },
  };
}

describe("parseTeamArgs", () => {
  it("returns help for empty args", () => {
    const r = parseTeamArgs([]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.helpText).toBe(HELP_TEXT);
  });

  it("parses team create", () => {
    const r = parseTeamArgs(["create", "team-p6"]);
    expect(r).toEqual({
      ok: true,
      command: { group: "create", teamId: "team-p6" },
    });
  });

  it("returns error for unknown group", () => {
    const r = parseTeamArgs(["unknown"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown team group");
  });

  it("parses member list with optional filters", () => {
    const r = parseTeamArgs(["member", "list", "--role", "coder", "--status", "active"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "member",
        sub: "list",
        role: "coder",
        status: "active",
      });
    }
  });

  it("parses member show", () => {
    const r = parseTeamArgs(["member", "show", "w1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({ group: "member", sub: "show", memberId: "w1" });
    }
  });

  it("parses member add without workspace or branch requirements", () => {
    const r = parseTeamArgs(["member", "add", "w1", "coder", "default"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "add") {
      expect(r.command.memberId).toBe("w1");
      expect(r.command.role).toBe("coder");
      expect(r.command.channel).toBe("default");
      expect(r.command.metadata).toBeUndefined();
    }
  });

  it("parses member add metadata as optional string facts", () => {
    const r = parseTeamArgs([
      "member",
      "add",
      "w1",
      "coder",
      "default",
      "--metadata",
      '{"workspace":"/ws","branch":"feat/x","ledgerId":"ledger-1"}',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "add") {
      expect(r.command.metadata).toEqual({
        workspace: "/ws",
        branch: "feat/x",
        ledgerId: "ledger-1",
      });
    }
  });

  it("rejects invalid metadata values", () => {
    const r = parseTeamArgs([
      "member",
      "add",
      "w1",
      "coder",
      "default",
      "--metadata",
      '{"attempt":1}',
    ]);
    expect(r.ok).toBe(false);
  });

  it("parses member status and rejects invalid status", () => {
    const ok = parseTeamArgs(["member", "status", "w1", "active"]);
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.command.sub === "status") {
      expect(ok.command.memberId).toBe("w1");
      expect(ok.command.status).toBe("active");
    }

    const bad = parseTeamArgs(["member", "status", "w1", "invalid"]);
    expect(bad.ok).toBe(false);
  });

  it("parses member heartbeat and terminate", () => {
    const hb = parseTeamArgs(["member", "heartbeat", "w1", "--evidence", "commit abc"]);
    expect(hb.ok).toBe(true);
    if (hb.ok) {
      expect(hb.command).toEqual({
        group: "member",
        sub: "heartbeat",
        memberId: "w1",
        evidence: "commit abc",
      });
    }

    const term = parseTeamArgs(["member", "terminate", "w1", "--reason", "done"]);
    expect(term.ok).toBe(true);
    if (term.ok) {
      expect(term.command).toEqual({
        group: "member",
        sub: "terminate",
        memberId: "w1",
        reason: "done",
      });
    }
  });

  it("returns member help for member --help", () => {
    const r = parseTeamArgs(["member", "--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.helpText).toBe(MEMBER_HELP);
  });

  it("parses task commands with member assignment", () => {
    expect(parseTeamArgs(["task", "create", "t1", "Inspect", "issue"])).toEqual({
      ok: true,
      command: { group: "task", sub: "create", taskId: "t1", title: "Inspect issue" },
    });

    const assign = parseTeamArgs(["task", "assign", "t1", "w1"]);
    expect(assign.ok).toBe(true);
    if (assign.ok && assign.command.sub === "assign") {
      expect(assign.command.memberId).toBe("w1");
    }

    const assignWithText = parseTeamArgs([
      "task",
      "assign",
      "t1",
      "w1",
      "--text",
      "Use IM and report evidence",
    ]);
    expect(assignWithText.ok).toBe(true);
    if (assignWithText.ok && assignWithText.command.sub === "assign") {
      expect(assignWithText.command.instruction).toBe("Use IM and report evidence");
    }
  });

  it("returns task help for task --help", () => {
    const r = parseTeamArgs(["task", "--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.helpText).toBe(TASK_HELP);
  });
});

describe("team service commands", () => {
  function fresh(): TeamServiceState {
    return createTeamServiceState("test-team");
  }

  it("creates team state", () => {
    const state = fresh();
    const env = handleCreateCommand(state, { group: "create", teamId: "team-p6" });
    expect(env.ok).toBe(true);
    expect(state.roster.teamId).toBe("team-p6");
    expect(state.taskState.teamId).toBe("team-p6");
  });

  it("lists empty roster", () => {
    const state = fresh();
    const env = handleMemberCommand(fakePorts(), state, {
      group: "member",
      sub: "list",
    });
    expect(env.ok).toBe(true);
    if (env.ok) {
      const result = env.result as Record<string, unknown>;
      expect(result.totalMembers).toBe(0);
    }
  });

  it("fails show unknown member", () => {
    const env = handleMemberCommand(fakePorts(), fresh(), {
      group: "member",
      sub: "show",
      memberId: "missing",
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.errorCode).toBe("UNKNOWN_MEMBER");
  });

  it("adds a member and then shows it", () => {
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

    const show = handleMemberCommand(ports, state, {
      group: "member",
      sub: "show",
      memberId: "w1",
    });
    expect(show.ok).toBe(true);
    if (show.ok) {
      const member = show.result as Record<string, unknown>;
      expect(member.memberId).toBe("w1");
      expect(member.role).toBe("coder");
      expect(member.status).toBe("idle");
      expect(member).not.toHaveProperty("workspace");
      expect(member.metadata).toEqual({ workspace: "/ws", branch: "feat/x" });
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

    const status = handleMemberCommand(ports, state, {
      group: "member",
      sub: "status",
      memberId: "w1",
      status: "active",
    });
    expect(status.ok).toBe(true);

    const hb = handleMemberCommand(ports, state, {
      group: "member",
      sub: "heartbeat",
      memberId: "w1",
    });
    expect(hb.ok).toBe(true);
    if (hb.ok) expect(hb.timestamp).toBe("2026-06-05T23:00:00.000Z");

    expect(state.roster.members["w1"]?.status).toBe("active");
    expect(state.roster.members["w1"]?.lastHeartbeat).toBe("2026-06-05T23:00:00.000Z");
  });

  it("terminates a member", () => {
    const state = fresh();
    const ports = fakePorts();
    handleMemberCommand(ports, state, {
      group: "member",
      sub: "add",
      memberId: "w1",
      role: "coder",
      channel: "default",
    });

    const term = handleMemberCommand(ports, state, {
      group: "member",
      sub: "terminate",
      memberId: "w1",
    });
    expect(term.ok).toBe(true);
    expect(state.roster.members["w1"]?.status).toBe("terminated");
  });

  it("creates and shows a task", () => {
    const state = fresh();
    const ports = fakePorts();
    const create = handleTaskCommand(ports, state, {
      group: "task",
      sub: "create",
      taskId: "t1",
      title: "Inspect issue",
    });
    expect(create.ok).toBe(true);

    const show = handleTaskCommand(ports, state, {
      group: "task",
      sub: "show",
      taskId: "t1",
    });
    expect(show.ok).toBe(true);
    if (show.ok) {
      const task = show.result as Record<string, unknown>;
      expect(task.id).toBe("t1");
      expect(task.title).toBe("Inspect issue");
      expect(task.status).toBe("queued");
    }
  });

  it("requires roster membership before assigning a task", () => {
    const state = fresh();
    const ports = fakePorts();
    handleTaskCommand(ports, state, {
      group: "task",
      sub: "create",
      taskId: "t1",
      title: "Inspect issue",
    });

    const missing = handleTaskCommand(ports, state, {
      group: "task",
      sub: "assign",
      taskId: "t1",
      memberId: "w1",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe("UNKNOWN_MEMBER");

    handleMemberCommand(ports, state, {
      group: "member",
      sub: "add",
      memberId: "w1",
      role: "coder",
      channel: "default",
    });
    handleMemberCommand(ports, state, {
      group: "member",
      sub: "update",
      memberId: "w1",
      patch: { runId: "run-worker-1" },
    });
    const assigned = handleTaskCommand(ports, state, {
      group: "task",
      sub: "assign",
      taskId: "t1",
      memberId: "w1",
      instruction: "Please inspect and report evidence.",
    });
    expect(assigned.ok).toBe(true);
    expect(state.taskState.tasks["t1"]?.workerId).toBe("w1");
    expect(state.taskState.tasks["t1"]?.dispatch).toMatchObject({
      channel: "default",
      memberId: "w1",
      instruction: "Please inspect and report evidence.",
      status: "pending",
      requestedAt: "2026-06-05T23:00:00.000Z",
    });
    if (assigned.ok) {
      expect(assigned.dispatch).toMatchObject({
        taskId: "t1",
        memberId: "w1",
        channel: "default",
        runId: "run-worker-1",
        message: {
          role: "user",
          text: "Please inspect and report evidence.",
          metadata: {
            from: "team",
            teamId: "test-team",
            taskId: "t1",
            memberId: "w1",
          },
        },
      });
    }
  });
});

describe("executeTeamCommand", () => {
  it("dispatches create, member, and task commands", () => {
    const state = createTeamServiceState("initial");
    const ports = fakePorts();

    const create = executeTeamCommand(ports, state, ["create", "team-p6"]);
    expect(create.ok).toBe(true);
    expect(state.roster.teamId).toBe("team-p6");

    const member = executeTeamCommand(ports, state, ["member", "add", "w1", "coder", "default"]);
    expect(member.ok).toBe(true);

    const task = executeTeamCommand(ports, state, ["task", "create", "t1", "Inspect issue"]);
    expect(task.ok).toBe(true);
  });

  it("returns parse errors as failure envelopes", () => {
    const env = executeTeamCommand(fakePorts(), createTeamServiceState(), ["bad"]);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.errorCode).toBe("PARSE_ERROR");
  });
});
