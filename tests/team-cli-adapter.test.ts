import { describe, expect, it } from "vitest";
import {
  createInMemoryFsPort,
  planTeamDirectoryLayout,
  readTeamDirectory,
} from "../src/subagent/directory-store.js";
import {
  executeTeamAdapterCommand,
  type TeamCliAdapterPorts,
} from "../src/subagent/team-cli-adapter.js";
import type { UserMessage } from "../src/types/environment.js";

function fakePorts(): TeamCliAdapterPorts & {
  posted: Array<{ stateRoot: string; runId: string; message: UserMessage }>;
} {
  let counter = 0;
  const posted: Array<{ stateRoot: string; runId: string; message: UserMessage }> = [];
  return {
    fs: createInMemoryFsPort(),
    nowIso: () => "2026-06-08T12:00:00.000Z",
    newEventId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${seed}-${counter.toString().padStart(3, "0")}`;
    },
    newMessageId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${seed}-${counter.toString().padStart(3, "0")}`;
    },
    im: {
      async postUserMessage(input) {
        posted.push(input);
      },
    },
    posted,
  };
}

describe("team CLI adapter", () => {
  it("persists team commands and dispatches task assignments through run-scoped IM", async () => {
    const ports = fakePorts();
    const stateRoot = "/state";

    await executeTeamAdapterCommand(ports, ["create", "team-p6"], { stateRoot });
    await executeTeamAdapterCommand(
      ports,
      ["member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot },
    );
    await executeTeamAdapterCommand(
      ports,
      ["member", "update", "coder-1", "--json", '{"runId":"run-worker-1"}'],
      { stateRoot },
    );
    await executeTeamAdapterCommand(
      ports,
      ["task", "create", "ticket-1", "Fix dispatch"],
      { stateRoot },
    );

    const assigned = await executeTeamAdapterCommand(
      ports,
      [
        "task",
        "assign",
        "ticket-1",
        "coder-1",
        "--text",
        "Please fix dispatch and report evidence.",
      ],
      { stateRoot },
    );

    expect(assigned.ok).toBe(true);
    expect(ports.posted).toHaveLength(1);
    expect(ports.posted[0]).toMatchObject({
      stateRoot,
      runId: "run-worker-1",
      message: {
        channel: "worker-channel",
        role: "user",
        text: "Please fix dispatch and report evidence.",
        metadata: {
          from: "team",
          teamId: "team-p6",
          taskId: "ticket-1",
          memberId: "coder-1",
        },
      },
    });

    const snapshot = await readTeamDirectory(
      ports.fs,
      planTeamDirectoryLayout(stateRoot),
    );
    expect(snapshot.taskState.tasks["ticket-1"]?.dispatch).toMatchObject({
      channel: "worker-channel",
      memberId: "coder-1",
      status: "sent",
      sentAt: "2026-06-08T12:00:00.000Z",
    });
  });

  it("records dispatch failure when a member has no run id", async () => {
    const ports = fakePorts();
    const stateRoot = "/state";

    await executeTeamAdapterCommand(ports, ["create", "team-p6"], { stateRoot });
    await executeTeamAdapterCommand(
      ports,
      ["member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot },
    );
    await executeTeamAdapterCommand(
      ports,
      ["task", "create", "ticket-1", "Fix dispatch"],
      { stateRoot },
    );

    const assigned = await executeTeamAdapterCommand(
      ports,
      ["task", "assign", "ticket-1", "coder-1"],
      { stateRoot },
    );

    expect(assigned.ok).toBe(false);
    if (!assigned.ok) {
      expect(assigned.errorCode).toBe("TEAM_DISPATCH_TARGET_MISSING");
    }
    expect(ports.posted).toHaveLength(0);

    const snapshot = await readTeamDirectory(
      ports.fs,
      planTeamDirectoryLayout(stateRoot),
    );
    expect(snapshot.taskState.tasks["ticket-1"]?.dispatch).toMatchObject({
      status: "failed",
      error: expect.stringContaining("has no runId"),
    });
  });

  it("requires team creation before member or task commands", async () => {
    const ports = fakePorts();
    const result = await executeTeamAdapterCommand(
      ports,
      ["member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot: "/state" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("TEAM_STATE_NOT_FOUND");
    }
  });
});
