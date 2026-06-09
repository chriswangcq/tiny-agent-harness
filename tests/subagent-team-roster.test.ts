import { describe, expect, it } from "vitest";
import {
  applyTeamRosterEvent,
  createTeamRosterState,
  summarizeTeamRoster,
  lookupMember,
  listMembersByRole,
  listMembersByStatus,
  type TeamRosterEvent,
  type TeamRosterState,
} from "../src/subagent/team-roster.js";
import { summarizeTeamRoster as summarizeFromBarrel } from "../src/subagent/index.js";
import { summarizeTeamRoster as summarizeFromRoot } from "../src/index.js";

function applyAll(
  state: TeamRosterState,
  events: TeamRosterEvent[],
): TeamRosterState {
  return events.reduce((current, event) => {
    const result = applyTeamRosterEvent(current, event);
    if (result.status !== "applied") {
      throw new Error(`event ${event.eventId} was ${result.status}`);
    }
    return result.state;
  }, state);
}

describe("team roster domain", () => {
  it("adds members without requiring workspace, branch, or ledger fields", () => {
    const state = createTeamRosterState("team-p6");

    const r1 = applyTeamRosterEvent(state, {
      kind: "member_added",
      eventId: "e1",
      memberId: "coder-1",
      role: "coder",
      channel: "im:coder-1",
    });

    expect(r1.status).toBe("applied");
    expect(r1.state.members["coder-1"]).toEqual({
      memberId: "coder-1",
      role: "coder",
      channel: "im:coder-1",
      status: "idle",
    });

    const dup = applyTeamRosterEvent(r1.state, {
      kind: "member_added",
      eventId: "e2",
      memberId: "coder-1",
      role: "reviewer",
      channel: "im:other",
    });
    expect(dup.status).toBe("rejected");
    expect(dup.rejection.code).toBe("member_exists");
  });

  it("keeps workspace, branch, and ledger as optional metadata facts", () => {
    const result = applyTeamRosterEvent(createTeamRosterState("team-p6"), {
      kind: "member_added",
      eventId: "e1",
      memberId: "coder-1",
      role: "coder",
      channel: "im:coder-1",
      metadata: {
        workspace: "/ws/p6-01",
        branch: "codex/p6/01",
        ledgerId: "ledger-123",
      },
    });

    expect(result.status).toBe("applied");
    expect(result.state.members["coder-1"]?.metadata).toEqual({
      workspace: "/ws/p6-01",
      branch: "codex/p6/01",
      ledgerId: "ledger-123",
    });
    expect(result.state.members["coder-1"]).not.toHaveProperty("workspace");
    expect(result.state.members["coder-1"]).not.toHaveProperty("branch");
    expect(result.state.members["coder-1"]).not.toHaveProperty("ledgerId");
  });

  it("applies updates without touching lifecycle fields", () => {
    const base = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
      {
        kind: "member_heartbeat",
        eventId: "e2",
        memberId: "coder-1",
        timestamp: "2026-06-05T10:00:00.000Z",
      },
    ]);

    const result = applyTeamRosterEvent(base, {
      kind: "member_updated",
      eventId: "e3",
      memberId: "coder-1",
      patch: {
        runId: "run-123",
        currentTask: "fix type errors",
        assignment: { id: "T-1", title: "Typecheck", status: "in_progress" },
        metadata: { workspace: "/ws/p6-01-updated" },
      },
    });

    expect(result.status).toBe("applied");
    const member = result.state.members["coder-1"];
    expect(member.runId).toBe("run-123");
    expect(member.currentTask).toBe("fix type errors");
    expect(member.assignment).toEqual({
      id: "T-1",
      title: "Typecheck",
      status: "in_progress",
    });
    expect(member.metadata).toEqual({ workspace: "/ws/p6-01-updated" });
    expect(member.lastHeartbeat).toBe("2026-06-05T10:00:00.000Z");
  });

  it("rejects updates on terminated members", () => {
    const base = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
      {
        kind: "member_terminated",
        eventId: "e2",
        memberId: "coder-1",
      },
    ]);

    const r = applyTeamRosterEvent(base, {
      kind: "member_updated",
      eventId: "e3",
      memberId: "coder-1",
      patch: { currentTask: "nope" },
    });
    expect(r.status).toBe("rejected");
    expect(r.rejection.code).toBe("member_already_terminated");
  });

  it("transitions status through valid paths and blocks terminated revival", () => {
    const base = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
    ]);

    const active = applyTeamRosterEvent(base, {
      kind: "member_status_changed",
      eventId: "e2",
      memberId: "coder-1",
      status: "active",
    });
    expect(active.status).toBe("applied");
    expect(active.state.members["coder-1"].status).toBe("active");

    const terminated = applyTeamRosterEvent(active.state, {
      kind: "member_status_changed",
      eventId: "e3",
      memberId: "coder-1",
      status: "terminated",
    });
    expect(terminated.status).toBe("applied");

    const revival = applyTeamRosterEvent(terminated.state, {
      kind: "member_status_changed",
      eventId: "e4",
      memberId: "coder-1",
      status: "active",
    });
    expect(revival.status).toBe("rejected");
    expect(revival.rejection.code).toBe("invalid_transition");
  });

  it("handles idempotent duplicate event ids", () => {
    const r1 = applyTeamRosterEvent(createTeamRosterState("team-p6"), {
      kind: "member_added",
      eventId: "e1",
      memberId: "coder-1",
      role: "coder",
      channel: "im:coder-1",
    });
    expect(r1.status).toBe("applied");

    const dup = applyTeamRosterEvent(r1.state, {
      kind: "member_added",
      eventId: "e1",
      memberId: "coder-2",
      role: "reviewer",
      channel: "im:reviewer-1",
    });
    expect(dup.status).toBe("duplicate");
    expect(dup.state).toBe(r1.state);
  });

  it("records heartbeats and evidence timestamps", () => {
    const base = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
    ]);

    const r1 = applyTeamRosterEvent(base, {
      kind: "member_heartbeat",
      eventId: "e2",
      memberId: "coder-1",
      timestamp: "2026-06-05T10:00:00Z",
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.members["coder-1"].lastHeartbeat).toBe("2026-06-05T10:00:00Z");
    expect(r1.state.members["coder-1"].lastEvidence).toBeUndefined();

    const r2 = applyTeamRosterEvent(r1.state, {
      kind: "member_heartbeat",
      eventId: "e3",
      memberId: "coder-1",
      timestamp: "2026-06-05T10:05:00Z",
      evidence: "commit abc123",
    });
    expect(r2.status).toBe("applied");
    expect(r2.state.members["coder-1"].lastHeartbeat).toBe("2026-06-05T10:05:00Z");
    expect(r2.state.members["coder-1"].lastEvidence).toBe("2026-06-05T10:05:00Z");
  });

  it("terminates members and treats repeated termination as duplicate", () => {
    const base = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
    ]);

    const r1 = applyTeamRosterEvent(base, {
      kind: "member_terminated",
      eventId: "e2",
      memberId: "coder-1",
      reason: "task done",
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.members["coder-1"].status).toBe("terminated");

    const r2 = applyTeamRosterEvent(r1.state, {
      kind: "member_terminated",
      eventId: "e3",
      memberId: "coder-1",
    });
    expect(r2.status).toBe("duplicate");
  });

  it("summarizes roster with counts and filters", () => {
    const state = applyAll(createTeamRosterState("team-p6"), [
      {
        kind: "member_added",
        eventId: "e1",
        memberId: "coder-1",
        role: "coder",
        channel: "im:coder-1",
      },
      {
        kind: "member_added",
        eventId: "e2",
        memberId: "reviewer-1",
        role: "reviewer",
        channel: "im:reviewer-1",
      },
      {
        kind: "member_added",
        eventId: "e3",
        memberId: "coder-2",
        role: "coder",
        channel: "im:coder-2",
      },
      {
        kind: "member_status_changed",
        eventId: "e4",
        memberId: "coder-1",
        status: "active",
      },
      {
        kind: "member_status_changed",
        eventId: "e5",
        memberId: "coder-2",
        status: "offline",
      },
    ]);

    const summary = summarizeTeamRoster(state);
    expect(summary.teamId).toBe("team-p6");
    expect(summary.totalMembers).toBe(3);
    expect(summary.membersByStatus).toEqual({
      active: 1,
      idle: 1,
      stale: 0,
      offline: 1,
      terminated: 0,
    });
    expect(summary.membersByRole).toEqual({ coder: 2, reviewer: 1 });
    expect(summary.activeMembers.map((member) => member.memberId)).toEqual([
      "coder-1",
      "reviewer-1",
    ]);

    const coders = listMembersByRole(state, "coder");
    expect(coders.map((member) => member.memberId)).toEqual(["coder-1", "coder-2"]);

    const idleMembers = listMembersByStatus(state, "idle");
    expect(idleMembers).toHaveLength(1);
    expect(idleMembers[0].memberId).toBe("reviewer-1");

    const found = lookupMember(state, "coder-1");
    expect(found?.role).toBe("coder");
    expect(found?.status).toBe("active");
    expect(lookupMember(state, "no-one")).toBeUndefined();
  });

  it("exports summary helpers from subagent and root barrels", () => {
    expect(summarizeFromBarrel).toBe(summarizeTeamRoster);
    expect(summarizeFromRoot).toBe(summarizeTeamRoster);
  });
});
