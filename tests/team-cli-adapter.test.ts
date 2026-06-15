import { describe, expect, it } from "vitest";
import {
  createInMemoryFsPort,
  planTeamScopedDirectoryLayout,
  readTeamDirectory,
  readTeamDirectoryEvents,
} from "../src/subagent/directory-store.js";
import {
  executeTeamAdapterCommand,
  type TeamCliAdapterPorts,
} from "../src/subagent/team-cli-adapter.js";

function fakePorts(): TeamCliAdapterPorts {
  let counter = 0;
  return {
    fs: createInMemoryFsPort(),
    nowIso: () => "2026-06-08T12:00:00.000Z",
    newEventId: (prefix, seed) => {
      counter += 1;
      return `${prefix}-${seed}-${counter.toString().padStart(3, "0")}`;
    },
  };
}

describe("team CLI adapter", () => {
  it("persists roster commands under explicit project-scoped team state", async () => {
    const ports = fakePorts();
    const stateRoot = "/state";

    await executeTeamAdapterCommand(ports, ["create", "team-p6"], { stateRoot });
    await executeTeamAdapterCommand(
      ports,
      ["--team", "team-p6", "member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot },
    );
    await executeTeamAdapterCommand(
      ports,
      [
        "--team",
        "team-p6",
        "member",
        "update",
        "coder-1",
        "--json",
        '{"runId":"run-worker-1","assignment":{"id":"a1","title":"Fix dispatch","status":"assigned"}}',
      ],
      { stateRoot },
    );

    const snapshot = await readTeamDirectory(
      ports.fs,
      planTeamScopedDirectoryLayout(stateRoot, "team-p6"),
    );
    expect(snapshot).not.toHaveProperty("taskState");
    expect(snapshot.roster.members["coder-1"]).toMatchObject({
      memberId: "coder-1",
      role: "coder",
      channel: "worker-channel",
      runId: "run-worker-1",
      assignment: {
        id: "a1",
        title: "Fix dispatch",
        status: "assigned",
      },
    });

    const events = await readTeamDirectoryEvents(
      ports.fs,
      planTeamScopedDirectoryLayout(stateRoot, "team-p6"),
    );
    expect(events.parseErrors).toEqual([]);
    expect(events.validEvents.map((event) => event.kind)).toEqual([
      "team_created",
      "roster_event",
      "roster_event",
    ]);
  });

  it("rejects removed task commands instead of dispatching implicitly", async () => {
    const ports = fakePorts();
    const stateRoot = "/state";

    await executeTeamAdapterCommand(ports, ["create", "team-p6"], { stateRoot });
    const result = await executeTeamAdapterCommand(
      ports,
      ["--team", "team-p6", "task", "assign", "ticket-1", "coder-1"],
      { stateRoot },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("PARSE_ERROR");
      expect(result.error).toContain("Use tiny-agent im admin post");
    }
  });

  it("requires team creation before member commands", async () => {
    const ports = fakePorts();
    const result = await executeTeamAdapterCommand(
      ports,
      ["--team", "team-p6", "member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot: "/state" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("TEAM_STATE_NOT_FOUND");
    }
  });

  it("requires explicit team id for non-create commands", async () => {
    const ports = fakePorts();
    const result = await executeTeamAdapterCommand(
      ports,
      ["member", "add", "coder-1", "coder", "worker-channel"],
      { stateRoot: "/state" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("TEAM_ID_REQUIRED");
      expect(result.error).toContain("--team");
    }
  });
});
