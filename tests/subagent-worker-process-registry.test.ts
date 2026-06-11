import { describe, expect, it } from "vitest";
import {
  createTeamMemberRunProcessRecord,
  launchLocalWorker,
  markTeamMemberRunProcessRunning,
  planWorkerLaunch,
  type TeamRosterState,
  type TeamRosterEvent,
  type TeamRosterResult,
} from "../src/subagent/index.js";
import type { RuntimeProcessRecord } from "../src/runtime/index.js";

const NOW = "2026-06-11T00:00:00.000Z";

function makePlan() {
  return planWorkerLaunch({
    stateRoot: "/state",
    teamId: "team-main",
    memberId: "worker-1",
    runId: "run-main",
    assignmentId: "assignment-main",
    workerId: "worker-1",
    workspace: "/repo-worker",
    branch: "worker/branch",
    channel: "worker-channel",
    taskPrompt: "Do the task",
    role: "coder",
    allowedActions: ["edit", "test"],
    now: NOW,
  });
}

function makeRoster() {
  const state: TeamRosterState = {
    members: {},
    appliedEventIds: [],
  };
  return {
    async load() {
      return state;
    },
    async apply(event: TeamRosterEvent): Promise<TeamRosterResult> {
      state.appliedEventIds.push(event.eventId);
      if (event.kind === "member_added") {
        state.members[event.memberId] = {
          memberId: event.memberId,
          role: event.role,
          channel: event.channel,
          metadata: event.metadata,
          status: "idle",
        };
      }
      if (event.kind === "member_updated") {
        state.members[event.memberId] = {
          ...state.members[event.memberId]!,
          ...event.patch,
        };
      }
      if (event.kind === "member_status_changed") {
        state.members[event.memberId] = {
          ...state.members[event.memberId]!,
          status: event.status,
        };
      }
      return { status: "applied", state };
    },
  };
}

describe("worker process registry helpers", () => {
  it("converts a worker launch plan into a team-member-owned run process record", () => {
    const record = createTeamMemberRunProcessRecord(makePlan());

    expect(record).toMatchObject({
      id: "team-member-run:team-main:worker-1:run-main",
      kind: "run",
      owner: {
        scope: "team-member",
        teamId: "team-main",
        memberId: "worker-1",
        runId: "run-main",
      },
      status: "planned",
      command: {
        executable: "tiny-agent",
        cwd: "/repo-worker",
      },
      statePath: "/state/teams/team-main/members/worker-1/state.json",
      logPath: "/state/teams/team-main/members/worker-1/output.log",
      metadata: {
        role: "coder",
        assignmentId: "assignment-main",
      },
    });
  });

  it("marks successful worker launches as running process records", () => {
    const record = markTeamMemberRunProcessRunning(makePlan(), {
      pid: 4242,
      now: "2026-06-11T00:00:01.000Z",
    });

    expect(record).toMatchObject({
      status: "running",
      pid: 4242,
      startedAt: "2026-06-11T00:00:01.000Z",
      lastHeartbeatAt: "2026-06-11T00:00:01.000Z",
    });
  });
});

describe("launchLocalWorker process registry integration", () => {
  it("writes a running team-member run process record through the optional port", async () => {
    const records: RuntimeProcessRecord[] = [];
    const result = await launchLocalWorker(makePlan(), {
      clock: { nowISO: () => "2026-06-11T00:00:01.000Z" },
      ids: {
        newId: (() => {
          let index = 0;
          return () => `event-${++index}`;
        })(),
      },
      git: {
        async checkout() {
          return { success: true, branch: "worker/branch" };
        },
      },
      spawn: {
        async spawn() {
          return { pid: 4242, stdout: "", stderr: "", exitCode: 0 };
        },
      },
      roster: makeRoster(),
      workerState: {
        async write() {},
      },
      processRegistry: {
        async upsert(record) {
          records.push(record);
        },
      },
    });

    expect(result.kind).toBe("launch_success");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "run",
      owner: {
        scope: "team-member",
        teamId: "team-main",
        memberId: "worker-1",
        runId: "run-main",
      },
      status: "running",
      pid: 4242,
    });
  });
});
