/**
 * P6-09 local team runtime smoke tests.
 *
 * Exercises the core runtime loop using only pure FSM functions
 * (same patterns as existing P6-01~P6-06 unit tests).
 * No real filesystem, network, time, or external dependencies.
 *
 * P6-07/P6-08: TODO/skip — extensible placeholders.
 */

import { describe, expect, it } from "vitest";

// P6-01: Contact registry
import {
  applyContactRegistryEvent,
  createContactRegistryState,
  lookupWorker,
  listWorkersByRole,
  listWorkersByStatus,
  summarizeContactRegistry,
  type ContactRegistryEvent,
  type ContactRegistryState,
} from "../src/subagent/contact-registry.js";

// P6-02: Directory store
import {
  planTeamDirectoryLayout,
  createTeamDirectorySnapshot,
  validateTeamDirectorySnapshot,
} from "../src/subagent/directory-store.js";

// P6-03: Team FSM
import {
  applySubAgentTeamEvent,
  createSubAgentTeamState,
  listActiveSubAgentAssignments,
  summarizeSubAgentTeam,
  type SubAgentTeamEvent,
  type SubAgentTeamState,
} from "../src/subagent/team.js";

// P6-04: Local worker launcher planning
import {
  planRunScopedWorkerPaths,
  planWorkerLaunch,
  buildSpawnCommand,
  type WorkerLaunchParams,
} from "../src/subagent/local-worker-launcher.js";

// P6-05: Status projector
import {
  projectWorkerStatus,
  type ProjectorInput,
  type ProjectorConfig,
} from "../src/subagent/status-projector.js";
import type { WorkerContact } from "../src/subagent/contact-registry.js";

// P6-06: Handoff evidence
import {
  normalizeHandoffObject,
  validateHandoffEvidence,
  deriveGatesFromEvidence,
  summarizeHandoffEvidence,
  type WorkerHandoffEvidence,
} from "../src/subagent/worker-handoff-evidence.js";

// ===========================================================================
// Helpers
// ===========================================================================

function applyContactEvents(
  state: ContactRegistryState,
  events: ContactRegistryEvent[],
): ContactRegistryState {
  return events.reduce((s, e) => {
    const r = applyContactRegistryEvent(s, e);
    if (r.status !== "applied") throw new Error(`contact ${e.eventId}: ${r.status}`);
    return r.state;
  }, state);
}

function applyTeamEvents(
  state: SubAgentTeamState,
  events: SubAgentTeamEvent[],
): SubAgentTeamState {
  return events.reduce((s, e) => {
    const r = applySubAgentTeamEvent(s, e);
    if (r.status !== "applied") throw new Error(`team ${e.eventId}: ${r.status}`);
    return r.state;
  }, state);
}

/** Build a minimal WorkerContact for projector input */
function makeContact(overrides: Partial<WorkerContact> = {}): WorkerContact {
  return {
    workerId: "coder-1",
    role: "coder",
    workspace: "/ws/p6",
    branch: "codex/p6/09",
    imChannel: "p6-09",
    allowedActions: ["read", "write", "test"],
    status: "active",
    lastHeartbeat: "2026-06-06T11:59:00.000Z",
    lastEvidence: "2026-06-06T11:58:00.000Z",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ProjectorConfig> = {}): ProjectorConfig {
  return {
    now: "2026-06-06T12:00:00.000Z",
    heartbeatMaxAgeMs: 300_000,
    evidenceMaxAgeMs: 600_000,
    imSilenceMaxAgeMs: 900_000,
    ledgerStallMaxAgeMs: 900_000,
    runStallMaxAgeMs: 600_000,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<WorkerHandoffEvidence> = {}): WorkerHandoffEvidence {
  return normalizeHandoffObject({
    childLedgerId: "L20260606-153739",
    childLedgerStatus: "closed",
    commit: "abc123def456",
    branch: "codex/p6/09",
    workspace: "/tmp/test-workspace",
    changedFiles: ["tests/subagent-team-runtime-smoke.test.ts"],
    commands: ["npm run typecheck", "npm run build", "npm test"],
    gates: { typecheck: "PASS" as const, build: "PASS" as const, test: "PASS" as const },
    overallResult: "PASS" as const,
    residualRisk: "Low — additive only",
    mergeRecommendation: "approve" as const,
    ...overrides,
  });
}

// ===========================================================================
// P6-01: Contact registry smoke
// ===========================================================================

describe("P6-01 contact registry smoke", () => {
  it("registers workers, supports lookup and summary", () => {
    const state = applyContactEvents(createContactRegistryState("team-p6-09"), [
      {
        kind: "worker_registered", eventId: "e1", workerId: "coder-1",
        role: "coder", workspace: "/ws/p6-09", branch: "codex/p6/09",
        imChannel: "p6-09", allowedActions: ["read", "write", "test"],
      },
      {
        kind: "worker_registered", eventId: "e2", workerId: "reviewer-1",
        role: "reviewer", workspace: "/ws/p6-09", branch: "codex/p6/09",
        imChannel: "p6-09-review", allowedActions: ["read", "review"],
      },
    ]);

    expect(lookupWorker(state, "coder-1")).toBeDefined();
    expect(lookupWorker(state, "coder-1")!.role).toBe("coder");
    expect(listWorkersByRole(state, "coder")).toHaveLength(1);
    // Newly registered workers are idle by default
    expect(listWorkersByStatus(state, "idle")).toHaveLength(2);

    const summary = summarizeContactRegistry(state);
    expect(summary.totalWorkers).toBe(2);
    expect(summary.workersByStatus.idle).toBe(2);
  });
});

// ===========================================================================
// P6-02: Directory store smoke
// ===========================================================================

describe("P6-02 directory store smoke", () => {
  it("plans team directory layout", () => {
    const layout = planTeamDirectoryLayout("/home/project");
    expect(layout.teamDir).toBe("/home/project/team");
    expect(layout.registryFile).toBe("/home/project/team/contact-registry.json");
    expect(layout.eventsFile).toBe("/home/project/team/events.jsonl");
  });

  it("creates valid snapshot from registry", () => {
    const registry = createContactRegistryState("team-p6-09");
    // API: createTeamDirectorySnapshot(state, now, createdAt?)
    const snapshot = createTeamDirectorySnapshot(
      registry,
      "2026-06-06T12:00:00.000Z",
    );
    const validation = validateTeamDirectorySnapshot(snapshot);
    expect(validation.valid).toBe(true);
    expect(snapshot.registryId).toBe("team-p6-09");
  });
});

// ===========================================================================
// P6-03: Team FSM smoke
// ===========================================================================

describe("P6-03 team FSM smoke", () => {
  it("runs full lifecycle: register → submit → assign → start → succeed", () => {
    const state = applyTeamEvents(createSubAgentTeamState("team-p6-09"), [
      { kind: "worker_registered", eventId: "e1", workerId: "w1", label: "coder" },
      { kind: "task_submitted", eventId: "e2", taskId: "t1", title: "Smoke test" },
      { kind: "task_assigned", eventId: "e3", taskId: "t1", workerId: "w1" },
      { kind: "task_started", eventId: "e4", taskId: "t1" },
      { kind: "task_succeeded", eventId: "e5", taskId: "t1", output: { ok: true } },
    ]);

    expect(state.tasks["t1"]!.status).toBe("succeeded");
    expect(state.tasks["t1"]!.workerId).toBe("w1");
    expect(state.workers["w1"]!.status).toBe("idle");
    expect(state.workers["w1"]!.currentTaskId).toBeUndefined();
    expect(state.appliedEventIds).toEqual(["e1", "e2", "e3", "e4", "e5"]);

    const summary = summarizeSubAgentTeam(state);
    expect(summary.totalTasks).toBe(1);
    expect(summary.tasksByStatus.succeeded).toBe(1);
  });

  it("handles task failure", () => {
    const state = applyTeamEvents(createSubAgentTeamState("team-p6-09"), [
      { kind: "worker_registered", eventId: "e1", workerId: "w1", label: "coder" },
      { kind: "task_submitted", eventId: "e2", taskId: "t1", title: "Failing" },
      { kind: "task_assigned", eventId: "e3", taskId: "t1", workerId: "w1" },
      { kind: "task_started", eventId: "e4", taskId: "t1" },
      { kind: "task_failed", eventId: "e5", taskId: "t1", error: "failure" },
    ]);

    expect(state.tasks["t1"]!.status).toBe("failed");
    expect(state.tasks["t1"]!.error).toBe("failure");
    expect(state.workers["w1"]!.status).toBe("idle");
    expect(summarizeSubAgentTeam(state).tasksByStatus.failed).toBe(1);
  });

  it("lists active assignments", () => {
    const state = applyTeamEvents(createSubAgentTeamState("team-p6-09"), [
      { kind: "worker_registered", eventId: "e1", workerId: "w1", label: "coder" },
      { kind: "task_submitted", eventId: "e2", taskId: "t1", title: "T1" },
      { kind: "task_assigned", eventId: "e3", taskId: "t1", workerId: "w1" },
      { kind: "task_started", eventId: "e4", taskId: "t1" },
    ]);

    const active = listActiveSubAgentAssignments(state);
    expect(active).toHaveLength(1);
    expect(active[0].taskId).toBe("t1");
  });
});

// ===========================================================================
// P6-04: Worker launcher planning smoke
// ===========================================================================

describe("P6-04 worker launcher planning smoke", () => {
  it("plans run-scoped worker paths", () => {
    const paths = planRunScopedWorkerPaths("/home/project", "run-001", "coder-1");
    // API returns RunScopedWorkerPaths: { runWorkerDir, runWorkerStateFile, runWorkerLogFile }
    expect(paths.runWorkerDir).toContain("run-001");
    expect(paths.runWorkerDir).toContain("coder-1");
    expect(paths.runWorkerStateFile).toBeDefined();
  });

  it("plans worker launch", () => {
    // API: planWorkerLaunch(params: WorkerLaunchParams)
    // WorkerLaunchParams requires: stateRoot, runId, workerId, workspace, branch, channel, taskPrompt, role, allowedActions, now
    const params: WorkerLaunchParams = {
      workerId: "coder-1",
      role: "coder",
      stateRoot: "/home/project",
      runId: "run-001",
      workspace: "/home/project",
      branch: "codex/p6/09",
      channel: "p6-09",
      taskPrompt: "Smoke test task",
      allowedActions: ["read", "write", "test"],
      now: "2026-06-06T12:00:00.000Z",
    };
    const plan = planWorkerLaunch(params);
    expect(plan.workerId).toBe("coder-1");
    expect(plan.runId).toBe("run-001");
    expect(plan.spawnCommand).toBeDefined();
    expect(plan.spawnCommand.command).toBeDefined();
    expect(Array.isArray(plan.spawnCommand.args)).toBe(true);
  });

  it("builds spawn command", () => {
    // buildSpawnCommand takes a WorkerLaunchPlan
    const plan = planWorkerLaunch({
      workerId: "coder-1",
      runId: "run-001",
      stateRoot: "/home/project",
      branch: "codex/p6/09",
      channel: "p6-09",
      role: "coder",
      workspace: "/home/project",
      taskPrompt: "Fix tests",
      allowedActions: ["read", "write", "test"],
      now: "2026-06-06T12:00:00.000Z",
    });
    const cmd = buildSpawnCommand(plan);
    expect(cmd.command).toBeDefined();
    // The spawn command uses --channel <channel> not workerId directly
    expect(cmd.args.join(" ")).toContain("--channel");
    expect(cmd.args.join(" ")).toContain("p6-09");
    expect(cmd.args.join(" ")).toContain("--state-dir");
  });
});

// ===========================================================================
// P6-05: Status projector smoke
// ===========================================================================

describe("P6-05 status projector smoke", () => {
  it("classifies healthy worker", () => {
    const r = projectWorkerStatus({
      contact: makeContact(),
      config: makeConfig(),
    });
    // WorkerStatusProjection uses 'status' not 'code'
    expect(r.status).toBe("healthy");
    expect(r.contactStatus).toBe("active");
  });

  it("detects stale heartbeat", () => {
    const r = projectWorkerStatus({
      contact: makeContact({ lastHeartbeat: "2026-06-06T11:50:00.000Z" }),
      config: makeConfig(),
    });
    expect(r.status).toBe("degraded");
    // riskFlags (not warnings) contains heartbeat-related flag
    expect(r.riskFlags.length).toBeGreaterThan(0);
  });

  it("classifies terminated worker", () => {
    const r = projectWorkerStatus({
      contact: makeContact({ status: "terminated" }),
      config: makeConfig(),
    });
    expect(r.status).toBe("terminated");
  });
});

// ===========================================================================
// P6-06: Handoff evidence smoke
// ===========================================================================

describe("P6-06 handoff evidence smoke", () => {
  it("validates valid evidence", () => {
    const r = validateHandoffEvidence(makeEvidence());
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("derives gates", () => {
    const g = deriveGatesFromEvidence(makeEvidence());
    // EvidenceDerivedGates returns boolean flags, not commands
    expect(g.typecheckPasses).toBe(true);
    expect(g.buildPasses).toBe(true);
    expect(g.testsPass).toBe(true);
    expect(g.workerRanGates).toBe(true);
  });

  it("detects invalid evidence", () => {
    const r = validateHandoffEvidence(
      normalizeHandoffObject({ commit: "abc", branch: "p6/09" } as Partial<WorkerHandoffEvidence>) as WorkerHandoffEvidence,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("summarizes evidence", () => {
    // summarizeHandoffEvidence returns a string
    const s = summarizeHandoffEvidence(makeEvidence());
    expect(typeof s).toBe("string");
    expect(s).toContain("PASS");
  });
});

// ===========================================================================
// E2E runtime chain
// ===========================================================================

describe("E2E runtime chain", () => {
  it("chains: register contact → create team → plan launch → project status → record evidence", () => {
    // 1. Contact registry
    const registry = applyContactEvents(createContactRegistryState("team-p6-09"), [
      {
        kind: "worker_registered", eventId: "e1", workerId: "coder-1",
        role: "coder", workspace: "/tmp/e2e-test", branch: "codex/p6/09",
        imChannel: "p6-09", allowedActions: ["read", "write", "test"],
      },
    ]);
    expect(lookupWorker(registry, "coder-1")).toBeDefined();

    // 2. Directory store snapshot
    const snapshot = createTeamDirectorySnapshot(
      registry,
      "2026-06-06T12:00:00.000Z",
    );
    expect(validateTeamDirectorySnapshot(snapshot).valid).toBe(true);

    // 3. Team FSM
    const teamState = applyTeamEvents(createSubAgentTeamState("team-p6-09"), [
      { kind: "worker_registered", eventId: "te1", workerId: "coder-1", label: "coder" },
      { kind: "task_submitted", eventId: "te2", taskId: "t1", title: "E2E task" },
      { kind: "task_assigned", eventId: "te3", taskId: "t1", workerId: "coder-1" },
      { kind: "task_started", eventId: "te4", taskId: "t1" },
      { kind: "task_succeeded", eventId: "te5", taskId: "t1", output: { ok: true } },
    ]);
    expect(teamState.tasks["t1"]!.status).toBe("succeeded");

    // 4. Worker launcher plan
    const plan = planWorkerLaunch({
      workerId: "coder-1",
      role: "coder",
      stateRoot: "/tmp/e2e-test",
      runId: "run-e2e-001",
      workspace: "/tmp/e2e-test",
      branch: "codex/p6/09",
      channel: "p6-09",
      taskPrompt: "E2E task",
      allowedActions: ["read", "write", "test"],
      now: "2026-06-06T12:00:00.000Z",
    });
    expect(plan.runId).toBe("run-e2e-001");

    // 5. Status projector
    const proj = projectWorkerStatus({
      contact: {
        workerId: "coder-1",
        role: "coder",
        workspace: "/tmp/e2e-test",
        branch: "codex/p6/09",
        imChannel: "p6-09",
        allowedActions: ["read", "write", "test"],
        status: "active",
        lastHeartbeat: "2026-06-06T11:59:00.000Z",
        lastEvidence: "2026-06-06T11:58:00.000Z",
        runId: plan.runId,
        ledgerId: "L20260606-153739",
      },
      config: {
        now: "2026-06-06T12:00:00.000Z",
        heartbeatMaxAgeMs: 300_000,
        evidenceMaxAgeMs: 600_000,
        imSilenceMaxAgeMs: 900_000,
        ledgerStallMaxAgeMs: 900_000,
        runStallMaxAgeMs: 600_000,
      },
    });
    expect(proj.status).toBe("healthy");

    // 6. Handoff evidence
    const evidence = makeEvidence();
    expect(validateHandoffEvidence(evidence).valid).toBe(true);
    const summary = summarizeHandoffEvidence(evidence);
    expect(summary).toContain("PASS");
  });
});

// ===========================================================================
// P6-07/P6-08 placeholder (TODO/skip)
// ===========================================================================

describe("P6-07/P6-08 placeholder (TODO)", () => {
  it.todo("P6-07: merge protocol — extend smoke tests when merged");
  it.todo("P6-08: team CLI integration tests — extend smoke tests when merged");
});
