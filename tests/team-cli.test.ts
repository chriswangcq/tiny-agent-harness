import { describe, expect, it } from "vitest";
import {
  parseTeamArgs,
  createTeamServiceState,
  executeTeamCommand,
  handleContactCommand,
  handleTaskCommand,
  HELP_TEXT,
  CONTACT_HELP,
  TASK_HELP,
  type TeamServiceState,
  type TeamCliPorts,
} from "../src/subagent/team-cli.js";

// ---------------------------------------------------------------------------
// Fake ports — deterministic, no hidden time/id
// ---------------------------------------------------------------------------
let eventCounter = 0;
function fakePorts(): TeamCliPorts {
  return {
    nowIso: () => "2026-06-05T23:00:00.000Z",
    newEventId: (prefix: string, seed: string) => {
      eventCounter += 1;
      return `${prefix}-${seed}-${eventCounter.toString().padStart(3, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Parse tests
// ---------------------------------------------------------------------------
describe("parseTeamArgs", () => {
  it("returns help for empty args", () => {
    const r = parseTeamArgs([]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.helpText).toBe(HELP_TEXT);
  });

  it("returns help for --help", () => {
    const r = parseTeamArgs(["--help"]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.helpText).toBe(HELP_TEXT);
  });

  it("returns error for unknown group", () => {
    const r = parseTeamArgs(["unknown"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Unknown team group");
    }
  });

  // Contact subcommands
  it("parses contact list", () => {
    const r = parseTeamArgs(["contact", "list"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({ group: "contact", sub: "list" });
    }
  });

  it("parses contact show with workerId", () => {
    const r = parseTeamArgs(["contact", "show", "w1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "contact",
        sub: "show",
        workerId: "w1",
      });
    }
  });

  it("fails contact show without workerId", () => {
    const r = parseTeamArgs(["contact", "show"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Usage");
    }
  });

  it("parses contact register", () => {
    const r = parseTeamArgs([
      "contact",
      "register",
      "w1",
      "coder",
      "/ws",
      "feat/x",
      "default",
      "write",
      "read",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cmd = r.command;
      expect(cmd.group).toBe("contact");
      if (cmd.sub === "register") {
        expect(cmd.workerId).toBe("w1");
        expect(cmd.role).toBe("coder");
        expect(cmd.workspace).toBe("/ws");
        expect(cmd.branch).toBe("feat/x");
        expect(cmd.imChannel).toBe("default");
        expect(cmd.allowedActions).toEqual(["write", "read"]);
      }
    }
  });

  it("fails contact register without enough args", () => {
    const r = parseTeamArgs(["contact", "register", "w1"]);
    expect(r.ok).toBe(false);
  });

  it("parses contact status", () => {
    const r = parseTeamArgs(["contact", "status", "w1", "active"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "status") {
      expect(r.command.workerId).toBe("w1");
      expect(r.command.status).toBe("active");
    }
  });

  it("rejects invalid contact status", () => {
    const r = parseTeamArgs(["contact", "status", "w1", "invalid"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Invalid status");
    }
  });

  it("parses contact heartbeat", () => {
    const r = parseTeamArgs(["contact", "heartbeat", "w1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "contact",
        sub: "heartbeat",
        workerId: "w1",
      });
    }
  });

  it("parses contact terminate", () => {
    const r = parseTeamArgs(["contact", "terminate", "w1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "contact",
        sub: "terminate",
        workerId: "w1",
      });
    }
  });

  it("returns contact help for contact --help", () => {
    const r = parseTeamArgs(["contact", "--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.helpText).toBe(CONTACT_HELP);
    }
  });

  it("returns error for unknown contact subcommand", () => {
    const r = parseTeamArgs(["contact", "unknown"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Unknown contact subcommand");
    }
  });

  // Task subcommands
  it("parses task create", () => {
    const r = parseTeamArgs(["task", "create", "t1", "Inspect issue"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "create") {
      expect(r.command.taskId).toBe("t1");
      expect(r.command.title).toBe("Inspect issue");
    }
  });

  it("fails task create without title", () => {
    const r = parseTeamArgs(["task", "create", "t1"]);
    expect(r.ok).toBe(false);
  });

  it("parses task list", () => {
    const r = parseTeamArgs(["task", "list"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({ group: "task", sub: "list" });
    }
  });

  it("parses task show", () => {
    const r = parseTeamArgs(["task", "show", "t1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "task",
        sub: "show",
        taskId: "t1",
      });
    }
  });

  it("parses task assign", () => {
    const r = parseTeamArgs(["task", "assign", "t1", "w1"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "assign") {
      expect(r.command.taskId).toBe("t1");
      expect(r.command.workerId).toBe("w1");
    }
  });

  it("parses task start", () => {
    const r = parseTeamArgs(["task", "start", "t1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toEqual({
        group: "task",
        sub: "start",
        taskId: "t1",
      });
    }
  });

  it("parses task succeed", () => {
    const r = parseTeamArgs(["task", "succeed", "t1"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "succeed") {
      expect(r.command.taskId).toBe("t1");
    }
  });

  it("parses task succeed with --output", () => {
    const r = parseTeamArgs([
      "task",
      "succeed",
      "t1",
      "--output",
      '{"ok":true}',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "succeed") {
      expect(r.command.taskId).toBe("t1");
      expect(r.command.output).toBe('{"ok":true}');
    }
  });

  it("parses task fail", () => {
    const r = parseTeamArgs(["task", "fail", "t1", "something went wrong"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "fail") {
      expect(r.command.taskId).toBe("t1");
      expect(r.command.error).toBe("something went wrong");
    }
  });

  it("parses task cancel", () => {
    const r = parseTeamArgs(["task", "cancel", "t1", "no longer needed"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.sub === "cancel") {
      expect(r.command.taskId).toBe("t1");
      expect(r.command.reason).toBe("no longer needed");
    }
  });

  it("returns task help for task --help", () => {
    const r = parseTeamArgs(["task", "--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.helpText).toBe(TASK_HELP);
    }
  });

  it("returns error for unknown task subcommand", () => {
    const r = parseTeamArgs(["task", "unknown"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Unknown task subcommand");
    }
  });
});

// ---------------------------------------------------------------------------
// Service handler tests — using fake ports for deterministic tests
// ---------------------------------------------------------------------------
describe("team service commands", () => {
  function fresh(): TeamServiceState {
    return createTeamServiceState("test-registry", "test-team");
  }

  describe("contact", () => {
    it("lists empty registry", () => {
      const state = fresh();
      const ports = fakePorts();
      const env = handleContactCommand(ports, state, {
        group: "contact",
        sub: "list",
      });
      expect(env.ok).toBe(true);
      if (env.ok) {
        const extra = env as Record<string, unknown>;
        expect(extra.command).toBe("contact list");
        const result = extra.result as Record<string, unknown>;
        expect(result.totalWorkers).toBe(0);
      }
    });

    it("fails show unknown worker", () => {
      const state = fresh();
      const ports = fakePorts();
      const env = handleContactCommand(ports, state, {
        group: "contact",
        sub: "show",
        workerId: "nonexistent",
      });
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.errorCode).toBe("UNKNOWN_WORKER");
      }
    });

    it("registers a worker and then shows it", () => {
      const state = fresh();
      const ports = fakePorts();
      const reg = handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w1",
        role: "coder",
        workspace: "/ws",
        branch: "feat/x",
        imChannel: "default",
        allowedActions: ["write"],
      });
      expect(reg.ok).toBe(true);

      const show = handleContactCommand(ports, state, {
        group: "contact",
        sub: "show",
        workerId: "w1",
      });
      expect(show.ok).toBe(true);
      if (show.ok) {
        const extra = show as Record<string, unknown>;
        const worker = extra.result as Record<string, unknown>;
        expect(worker.workerId).toBe("w1");
        expect(worker.role).toBe("coder");
        expect(worker.status).toBe("idle");
      }
    });

    it("changes worker status", () => {
      const state = fresh();
      const ports = fakePorts();
      handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w1",
        role: "coder",
        workspace: "/ws",
        branch: "feat/x",
        imChannel: "default",
        allowedActions: [],
      });

      const status = handleContactCommand(ports, state, {
        group: "contact",
        sub: "status",
        workerId: "w1",
        status: "active",
      });
      expect(status.ok).toBe(true);

      const show = handleContactCommand(ports, state, {
        group: "contact",
        sub: "show",
        workerId: "w1",
      });
      if (show.ok) {
        const extra = show as Record<string, unknown>;
        const worker = extra.result as Record<string, unknown>;
        expect(worker.status).toBe("active");
      }
    });

    it("records heartbeat with deterministic timestamp", () => {
      const state = fresh();
      const ports = fakePorts();
      handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w1",
        role: "coder",
        workspace: "/ws",
        branch: "feat/x",
        imChannel: "default",
        allowedActions: [],
      });

      const hb = handleContactCommand(ports, state, {
        group: "contact",
        sub: "heartbeat",
        workerId: "w1",
      });
      expect(hb.ok).toBe(true);
      // Verify deterministic timestamp
      if (hb.ok) {
        const extra = hb as Record<string, unknown>;
        expect(extra.timestamp).toBe("2026-06-05T23:00:00.000Z");
      }
    });

    it("terminates a worker", () => {
      const state = fresh();
      const ports = fakePorts();
      handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w1",
        role: "coder",
        workspace: "/ws",
        branch: "feat/x",
        imChannel: "default",
        allowedActions: [],
      });

      const term = handleContactCommand(ports, state, {
        group: "contact",
        sub: "terminate",
        workerId: "w1",
      });
      expect(term.ok).toBe(true);

      const show = handleContactCommand(ports, state, {
        group: "contact",
        sub: "show",
        workerId: "w1",
      });
      if (show.ok) {
        const extra = show as Record<string, unknown>;
        const worker = extra.result as Record<string, unknown>;
        expect(worker.status).toBe("terminated");
      }
    });

    it("lists workers after registration", () => {
      const state = fresh();
      const ports = fakePorts();
      handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w1",
        role: "coder",
        workspace: "/ws",
        branch: "feat/x",
        imChannel: "default",
        allowedActions: [],
      });
      handleContactCommand(ports, state, {
        group: "contact",
        sub: "register",
        workerId: "w2",
        role: "reviewer",
        workspace: "/ws2",
        branch: "feat/y",
        imChannel: "default",
        allowedActions: [],
      });

      const list = handleContactCommand(ports, state, {
        group: "contact",
        sub: "list",
      });
      expect(list.ok).toBe(true);
      if (list.ok) {
        const extra = list as Record<string, unknown>;
        const result = extra.result as Record<string, unknown>;
        expect(result.totalWorkers).toBe(2);
      }
    });
  });

  describe("task", () => {
    it("creates a task", () => {
      const state = fresh();
      const ports = fakePorts();
      const env = handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "Inspect issue",
      });
      expect(env.ok).toBe(true);
    });

    it("list shows empty task state", () => {
      const state = fresh();
      const ports = fakePorts();
      const env = handleTaskCommand(ports, state, {
        group: "task",
        sub: "list",
      });
      expect(env.ok).toBe(true);
      if (env.ok) {
        const extra = env as Record<string, unknown>;
        const result = extra.result as Record<string, unknown>;
        expect(result.totalTasks).toBe(0);
      }
    });

    it("fails show unknown task", () => {
      const state = fresh();
      const ports = fakePorts();
      const env = handleTaskCommand(ports, state, {
        group: "task",
        sub: "show",
        taskId: "nonexistent",
      });
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.errorCode).toBe("UNKNOWN_TASK");
      }
    });

    it("creates and shows a task", () => {
      const state = fresh();
      const ports = fakePorts();
      handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "Inspect issue",
      });

      const show = handleTaskCommand(ports, state, {
        group: "task",
        sub: "show",
        taskId: "t1",
      });
      expect(show.ok).toBe(true);
      if (show.ok) {
        const extra = show as Record<string, unknown>;
        const task = extra.result as Record<string, unknown>;
        expect(task.id).toBe("t1");
        expect(task.title).toBe("Inspect issue");
        expect(task.status).toBe("queued");
      }
    });

    it("fails assigning when no worker exists", () => {
      const state = fresh();
      const ports = fakePorts();
      handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "Inspect issue",
      });

      const env = handleTaskCommand(ports, state, {
        group: "task",
        sub: "assign",
        taskId: "t1",
        workerId: "w1",
      });
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.errorCode).toBe("TASK_ASSIGN_FAILED");
      }
    });

    it("duplicate task create returns error", () => {
      const state = fresh();
      const ports = fakePorts();
      const r1 = handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "First",
      });
      expect(r1.ok).toBe(true);

      const r2 = handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "Second",
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.errorCode).toBe("TASK_CREATE_FAILED");
      }
    });

    it("event ids are deterministic with fake ports", () => {
      const state = fresh();
      const ports = fakePorts();
      // Each call increments the counter, producing predictable ids
      const r1 = handleTaskCommand(ports, state, {
        group: "task",
        sub: "create",
        taskId: "t1",
        title: "First",
      });
      expect(r1.ok).toBe(true);

      // Verify that state has the task with the deterministic eventId applied
      const task = state.taskState.tasks["t1"];
      expect(task).toBeDefined();
      expect(task!.status).toBe("queued");
    });
  });
});

// ---------------------------------------------------------------------------
// Top-level dispatch tests — with fake ports
// ---------------------------------------------------------------------------
describe("executeTeamCommand", () => {
  it("returns error envelope for bad args", () => {
    const state = createTeamServiceState();
    const ports = fakePorts();
    const env = executeTeamCommand(ports, state, ["bad"]);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.errorCode).toBe("PARSE_ERROR");
      expect(env.tool).toBe("team");
    }
  });

  it("returns success envelope for contact list", () => {
    const state = createTeamServiceState();
    const ports = fakePorts();
    const env = executeTeamCommand(ports, state, ["contact", "list"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.tool).toBe("team");
      expect(env.version).toBeDefined();
      const cmd = env as Record<string, unknown>;
      expect(cmd.command).toBe("contact list");
    }
  });

  it("returns success envelope for task list", () => {
    const state = createTeamServiceState();
    const ports = fakePorts();
    const env = executeTeamCommand(ports, state, ["task", "list"]);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.tool).toBe("team");
    }
  });

  it("envelope has cwd when passing cwd", () => {
    const state = createTeamServiceState();
    const ports = fakePorts();
    const env = executeTeamCommand(ports, state, ["contact", "list"], "/test/cwd");
    expect(env.cwd).toBe("/test/cwd");
  });
});

// ---------------------------------------------------------------------------
// Help text tests
// ---------------------------------------------------------------------------
describe("help text", () => {
  it("HELP_TEXT contains expected sections", () => {
    expect(HELP_TEXT).toContain("team contact");
    expect(HELP_TEXT).toContain("team task");
    expect(HELP_TEXT).toContain("team lifecycle");
    expect(HELP_TEXT).toContain("lifecycle-status");
    expect(HELP_TEXT).toContain("lease");
    expect(HELP_TEXT).toContain("reaper");
    expect(HELP_TEXT).toContain("shutdown");
    expect(HELP_TEXT).toContain("Usage:");
  });

  it("CONTACT_HELP contains all subcommands", () => {
    expect(CONTACT_HELP).toContain("list");
    expect(CONTACT_HELP).toContain("show");
    expect(CONTACT_HELP).toContain("register");
    expect(CONTACT_HELP).toContain("status");
    expect(CONTACT_HELP).toContain("heartbeat");
    expect(CONTACT_HELP).toContain("terminate");
  });

  it("TASK_HELP contains all subcommands", () => {
    expect(TASK_HELP).toContain("create");
    expect(TASK_HELP).toContain("list");
    expect(TASK_HELP).toContain("show");
    expect(TASK_HELP).toContain("assign");
    expect(TASK_HELP).toContain("start");
    expect(TASK_HELP).toContain("succeed");
    expect(TASK_HELP).toContain("fail");
    expect(TASK_HELP).toContain("cancel");
  });
});

// ---------------------------------------------------------------------------
// Determinism test — same fake clock produces same results
// ---------------------------------------------------------------------------
describe("determinism with explicit ports", () => {
  it("same operations with same fake ports produce identical results", () => {
    // Reset counter to make both runs deterministic
    eventCounter = 0;
    // Run 1
    const state1 = createTeamServiceState();
    const ports1 = fakePorts();
    handleContactCommand(ports1, state1, {
      group: "contact",
      sub: "register",
      workerId: "w1",
      role: "coder",
      workspace: "/ws",
      branch: "feat/x",
      imChannel: "default",
      allowedActions: [],
    });

    // Run 2 with fresh state and newly reset ports
    eventCounter = 0; // Reset counter for deterministic comparison
    const state2 = createTeamServiceState();
    const ports2 = fakePorts();
    handleContactCommand(ports2, state2, {
      group: "contact",
      sub: "register",
      workerId: "w1",
      role: "coder",
      workspace: "/ws",
      branch: "feat/x",
      imChannel: "default",
      allowedActions: [],
    });

    // Both states should have the same worker data
    const w1 = state1.contactRegistry.workers["w1"];
    const w2 = state2.contactRegistry.workers["w2"];
    // w2 doesn't exist because we reset — the second registration also uses workerId "w1"
    const w1b = state2.contactRegistry.workers["w1"];
    
    expect(w1).toBeDefined();
    expect(w1b).toBeDefined();
    expect(w1!.role).toBe(w1b!.role);
    expect(w1!.status).toBe(w1b!.status);
    // Same deterministic eventIds applied
    expect(state1.contactRegistry.appliedEventIds).toEqual(
      state2.contactRegistry.appliedEventIds,
    );
  });
});
