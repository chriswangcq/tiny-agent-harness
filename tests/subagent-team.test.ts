import { describe, expect, it } from "vitest";
import {
  applySubAgentTeamEvent,
  createSubAgentTeamState,
  listActiveSubAgentAssignments,
  summarizeSubAgentTeam,
  type SubAgentTeamEvent,
  type SubAgentTeamState,
} from "../src/subagent/team.js";
import { summarizeSubAgentTeam as summarizeFromBarrel } from "../src/subagent/index.js";
import { summarizeSubAgentTeam as summarizeFromRoot } from "../src/index.js";

function applyAll(
  state: SubAgentTeamState,
  events: SubAgentTeamEvent[],
): SubAgentTeamState {
  return events.reduce((current, event) => {
    const result = applySubAgentTeamEvent(current, event);
    if (result.status !== "applied") {
      throw new Error(`event ${event.eventId} was ${result.status}`);
    }
    return result.state;
  }, state);
}

describe("sub-agent team FSM core", () => {
  it("assigns, starts, completes, and releases a worker", () => {
    const state = applyAll(createSubAgentTeamState("team-a"), [
      {
        kind: "task_submitted",
        eventId: "e1",
        taskId: "task-1",
        title: "Inspect issue",
      },
      {
        kind: "member_added",
        eventId: "e2",
        workerId: "worker-1",
        label: "reviewer",
      },
      {
        kind: "task_assigned",
        eventId: "e3",
        taskId: "task-1",
        workerId: "worker-1",
      },
      {
        kind: "task_started",
        eventId: "e4",
        taskId: "task-1",
        workerId: "worker-1",
      },
      {
        kind: "task_succeeded",
        eventId: "e5",
        taskId: "task-1",
        output: { ok: true },
      },
    ]);

    expect(state.tasks["task-1"]).toMatchObject({
      status: "succeeded",
      workerId: "worker-1",
      output: { ok: true },
    });
    expect(state.workers["worker-1"]).toMatchObject({
      status: "idle",
      currentTaskId: undefined,
    });
    expect(state.appliedEventIds).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("records failures and releases assigned workers", () => {
    const running = applyAll(createSubAgentTeamState("team-a"), [
      { kind: "task_submitted", eventId: "e1", taskId: "task-1", title: "Run tests" },
      { kind: "member_added", eventId: "e2", workerId: "worker-1" },
      { kind: "task_assigned", eventId: "e3", taskId: "task-1", workerId: "worker-1" },
      { kind: "task_started", eventId: "e4", taskId: "task-1" },
    ]);

    const result = applySubAgentTeamEvent(running, {
      kind: "task_failed",
      eventId: "e5",
      taskId: "task-1",
      error: "test failed",
    });

    expect(result.status).toBe("applied");
    expect(result.state.tasks["task-1"]).toMatchObject({
      status: "failed",
      error: "test failed",
    });
    expect(result.state.workers["worker-1"]?.status).toBe("idle");
  });

  it("cancels queued tasks and rejects cancellation of terminal tasks", () => {
    const queued = applyAll(createSubAgentTeamState("team-a"), [
      { kind: "task_submitted", eventId: "e1", taskId: "task-1", title: "Wait" },
    ]);
    const cancelled = applySubAgentTeamEvent(queued, {
      kind: "task_cancelled",
      eventId: "e2",
      taskId: "task-1",
      reason: "no longer needed",
    });

    expect(cancelled.status).toBe("applied");
    expect(cancelled.state.tasks["task-1"]).toMatchObject({
      status: "cancelled",
      cancelReason: "no longer needed",
    });

    const rejected = applySubAgentTeamEvent(cancelled.state, {
      kind: "task_cancelled",
      eventId: "e3",
      taskId: "task-1",
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection.code).toBe("task_terminal");
    expect(rejected.state).toBe(cancelled.state);
  });

  it("treats duplicate event ids as idempotent no-ops", () => {
    const submitted = applySubAgentTeamEvent(createSubAgentTeamState("team-a"), {
      kind: "task_submitted",
      eventId: "e1",
      taskId: "task-1",
      title: "Inspect",
    });
    if (submitted.status !== "applied") {
      throw new Error("expected submit");
    }

    const duplicate = applySubAgentTeamEvent(submitted.state, {
      kind: "task_submitted",
      eventId: "e1",
      taskId: "task-2",
      title: "Different payload ignored",
    });

    expect(duplicate).toEqual({
      status: "duplicate",
      state: submitted.state,
    });
  });

  it("rejects invalid assignment without mutating state", () => {
    const state = applyAll(createSubAgentTeamState("team-a"), [
      { kind: "task_submitted", eventId: "e1", taskId: "task-1", title: "Inspect" },
      { kind: "member_added", eventId: "e2", workerId: "worker-1" },
      { kind: "task_submitted", eventId: "e3", taskId: "task-2", title: "Build" },
      { kind: "member_added", eventId: "e4", workerId: "worker-2" },
      { kind: "task_assigned", eventId: "e5", taskId: "task-1", workerId: "worker-1" },
    ]);

    const rejected = applySubAgentTeamEvent(state, {
      kind: "task_assigned",
      eventId: "e6",
      taskId: "task-2",
      workerId: "worker-1",
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection.code).toBe("worker_not_available");
    expect(rejected.state).toBe(state);
  });

  it("marks a busy worker offline and fails the active task", () => {
    const running = applyAll(createSubAgentTeamState("team-a"), [
      { kind: "task_submitted", eventId: "e1", taskId: "task-1", title: "Inspect" },
      { kind: "member_added", eventId: "e2", workerId: "worker-1" },
      { kind: "task_assigned", eventId: "e3", taskId: "task-1", workerId: "worker-1" },
      { kind: "task_started", eventId: "e4", taskId: "task-1" },
    ]);

    const offline = applySubAgentTeamEvent(running, {
      kind: "worker_offline",
      eventId: "e5",
      workerId: "worker-1",
      reason: "heartbeat lost",
    });

    expect(offline.status).toBe("applied");
    expect(offline.state.workers["worker-1"]).toMatchObject({
      status: "offline",
      currentTaskId: undefined,
    });
    expect(offline.state.tasks["task-1"]).toMatchObject({
      status: "failed",
      error: "heartbeat lost",
    });
  });

  it("summarizes counts and active assignments", () => {
    const state = applyAll(createSubAgentTeamState("team-a"), [
      { kind: "task_submitted", eventId: "e1", taskId: "task-1", title: "Inspect" },
      { kind: "task_submitted", eventId: "e2", taskId: "task-2", title: "Write" },
      { kind: "member_added", eventId: "e3", workerId: "worker-2" },
      { kind: "member_added", eventId: "e4", workerId: "worker-1" },
      { kind: "task_assigned", eventId: "e5", taskId: "task-1", workerId: "worker-2" },
      { kind: "task_started", eventId: "e6", taskId: "task-1" },
    ]);

    expect(listActiveSubAgentAssignments(state)).toEqual([
      {
        taskId: "task-1",
        taskTitle: "Inspect",
        taskStatus: "running",
        workerId: "worker-2",
        workerStatus: "busy",
      },
    ]);
    expect(summarizeSubAgentTeam(state)).toEqual({
      teamId: "team-a",
      totalTasks: 2,
      totalWorkers: 2,
      tasksByStatus: {
        queued: 1,
        assigned: 0,
        running: 1,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      },
      workersByStatus: {
        idle: 1,
        busy: 1,
        offline: 0,
      },
      activeAssignments: [
        {
          taskId: "task-1",
          taskTitle: "Inspect",
          taskStatus: "running",
          workerId: "worker-2",
          workerStatus: "busy",
        },
      ],
    });
  });

  it("exports summary helpers from subagent and root barrels", () => {
    expect(summarizeFromBarrel).toBe(summarizeSubAgentTeam);
    expect(summarizeFromRoot).toBe(summarizeSubAgentTeam);
  });
});
