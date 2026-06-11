import { describe, expect, it } from "vitest";
import {
  appendTeamDirectoryEvents,
  createInMemoryFsPort,
  createTeamDirectorySnapshot,
  planTeamScopedDirectoryLayout,
  readTeamDirectory,
  readTeamDirectoryEvents,
  replayTeamDirectoryEvents,
  validateTeamDirectoryEvent,
  validateTeamDirectorySnapshot,
  writeTeamDirectory,
  type TeamDirectoryEvent,
} from "../src/subagent/directory-store.js";
import { createTeamRosterState } from "../src/subagent/team-roster.js";

const T0 = "2026-06-05T00:00:00.000Z";
const T1 = "2026-06-05T00:01:00.000Z";

function teamCreated(teamId = "team-p6"): TeamDirectoryEvent {
  return {
    schemaVersion: 1,
    kind: "team_created",
    eventId: "evt-team-created",
    timestamp: T0,
    teamId,
  };
}

function memberAdded(teamId = "team-p6"): TeamDirectoryEvent {
  return {
    schemaVersion: 1,
    kind: "roster_event",
    eventId: "evt-member-added",
    timestamp: T1,
    teamId,
    event: {
      kind: "member_added",
      eventId: "evt-member-added",
      memberId: "coder-1",
      role: "coder",
      channel: "default",
      metadata: { workspace: "/ws" },
    },
  };
}

describe("team directory store", () => {
  it("plans project-scoped team paths without task directories", () => {
    expect(planTeamScopedDirectoryLayout("/root", "team-alpha")).toEqual({
      teamId: "team-alpha",
      teamDir: "/root/teams/team-alpha",
      stateFile: "/root/teams/team-alpha/state.json",
      eventsFile: "/root/teams/team-alpha/events.jsonl",
      runsDir: "/root/teams/team-alpha/runs",
      membersDir: "/root/teams/team-alpha/members",
    });
  });

  it("creates and validates roster-only snapshots", () => {
    const roster = createTeamRosterState("team-p6");
    const snapshot = createTeamDirectorySnapshot(roster, T0);
    expect(snapshot).toEqual({
      schemaVersion: 1,
      teamId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
      roster,
    });
    expect(snapshot).not.toHaveProperty("taskState");
    expect(validateTeamDirectorySnapshot(snapshot)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects snapshots without roster", () => {
    const result = validateTeamDirectorySnapshot({
      schemaVersion: 1,
      teamId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("roster"))).toBe(true);
  });

  it("rejects removed task events", () => {
    const result = validateTeamDirectoryEvent({
      schemaVersion: 1,
      kind: "task_event",
      eventId: "evt-task",
      timestamp: T0,
      teamId: "team-p6",
      event: { kind: "task_submitted", taskId: "ticket-1" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toContain("Unsupported kind");
  });

  it("replays roster events into a snapshot", () => {
    const snapshot = replayTeamDirectoryEvents([teamCreated(), memberAdded()]);
    expect(snapshot).not.toHaveProperty("taskState");
    expect(snapshot.roster.members["coder-1"]).toMatchObject({
      memberId: "coder-1",
      role: "coder",
      channel: "default",
      metadata: { workspace: "/ws" },
    });
    expect(snapshot.updatedAt).toBe(T1);
  });

  it("reads from event stream before falling back to state file", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamScopedDirectoryLayout("/root", "team-p6");
    await appendTeamDirectoryEvents(fs, layout, [teamCreated(), memberAdded()]);
    await writeTeamDirectory(
      fs,
      layout,
      createTeamDirectorySnapshot(createTeamRosterState("team-p6"), "stale"),
    );

    const snapshot = await readTeamDirectory(fs, layout);
    expect(snapshot.roster.members["coder-1"]?.role).toBe("coder");
    expect(snapshot.updatedAt).toBe(T1);
  });

  it("deduplicates appended events by event id", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamScopedDirectoryLayout("/root", "team-p6");
    const first = await appendTeamDirectoryEvents(fs, layout, [teamCreated()]);
    const second = await appendTeamDirectoryEvents(fs, layout, [teamCreated(), memberAdded()]);

    expect(first).toEqual({ status: "appended", appended: 1, duplicates: 0 });
    expect(second).toEqual({ status: "appended", appended: 1, duplicates: 1 });

    const events = await readTeamDirectoryEvents(fs, layout);
    expect(events.parseErrors).toEqual([]);
    expect(events.validEvents.map((event) => event.eventId)).toEqual([
      "evt-team-created",
      "evt-member-added",
    ]);
  });
});
