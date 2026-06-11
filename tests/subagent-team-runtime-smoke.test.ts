/**
 * P6-09 local team runtime smoke tests.
 *
 * Exercises the core runtime loop using pure domain functions
 * (same patterns as existing P6-01~P6-06 unit tests).
 * No real filesystem, network, time, or external dependencies.
 *
 * P6-07/P6-08: TODO/skip — extensible placeholders.
 */

import { describe, expect, it } from "vitest";

// P6-01: Team roster
import {
  applyTeamRosterEvent,
  createTeamRosterState,
  lookupMember,
  listMembersByRole,
  listMembersByStatus,
  summarizeTeamRoster,
  type TeamRosterEvent,
  type TeamRosterState,
} from "../src/subagent/team-roster.js";

// P6-02: Directory store
import {
  planTeamScopedDirectoryLayout,
  createTeamDirectorySnapshot,
  validateTeamDirectorySnapshot,
} from "../src/subagent/directory-store.js";

// P6-04: Local worker launcher planning
import {
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
import type { TeamMember } from "../src/subagent/team-roster.js";

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

function applyRosterEvents(
  state: TeamRosterState,
  events: TeamRosterEvent[],
): TeamRosterState {
  return events.reduce((s, e) => {
    const r = applyTeamRosterEvent(s, e);
    if (r.status !== "applied") throw new Error(`roster ${e.eventId}: ${r.status}`);
    return r.state;
  }, state);
}

/** Build a minimal TeamMember for projector input */
function makeMember(
  overrides: Partial<TeamMember> & { workerId?: string; ledgerId?: string } = {},
): TeamMember {
  const memberId = overrides.memberId ?? overrides.workerId ?? "coder-1";
  const { workerId: _workerId, ledgerId: _ledgerId, memberId: _memberId, ...rest } = overrides;
  return {
    memberId,
    role: "coder",
    channel: "p6-09",
    metadata: {
      workspace: "/ws/p6",
      branch: "codex/p6/09",
      allowedActions: "read,write,test",
      ...(overrides.ledgerId ? { ledgerId: overrides.ledgerId } : {}),
    },
    status: "active",
    lastHeartbeat: "2026-06-06T11:59:00.000Z",
    lastEvidence: "2026-06-06T11:58:00.000Z",
    ...rest,
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
// P6-01: Team roster smoke
// ===========================================================================

describe("P6-01 team roster smoke", () => {
  it("adds members, supports lookup and summary", () => {
    const state = applyRosterEvents(createTeamRosterState("team-p6-09"), [
      {
        kind: "member_added", eventId: "e1", memberId: "coder-1",
        role: "coder", channel: "p6-09",
        metadata: { workspace: "/ws/p6-09", branch: "codex/p6/09" },
      },
      {
        kind: "member_added", eventId: "e2", memberId: "reviewer-1",
        role: "reviewer", channel: "p6-09-review",
        metadata: { workspace: "/ws/p6-09", branch: "codex/p6/09" },
      },
    ]);

    expect(lookupMember(state, "coder-1")).toBeDefined();
    expect(lookupMember(state, "coder-1")!.role).toBe("coder");
    expect(listMembersByRole(state, "coder")).toHaveLength(1);
    // Newly registered workers are idle by default
    expect(listMembersByStatus(state, "idle")).toHaveLength(2);

    const summary = summarizeTeamRoster(state);
    expect(summary.totalMembers).toBe(2);
    expect(summary.membersByStatus.idle).toBe(2);
  });
});

// ===========================================================================
// P6-02: Directory store smoke
// ===========================================================================

describe("P6-02 directory store smoke", () => {
  it("plans team directory layout", () => {
    const layout = planTeamScopedDirectoryLayout("/home/project", "team-p6-09");
    expect(layout.teamDir).toBe("/home/project/teams/team-p6-09");
    expect(layout.stateFile).toBe("/home/project/teams/team-p6-09/state.json");
    expect(layout.eventsFile).toBe("/home/project/teams/team-p6-09/events.jsonl");
  });

  it("creates valid snapshot from roster", () => {
    const roster = createTeamRosterState("team-p6-09");
    const snapshot = createTeamDirectorySnapshot(roster, "2026-06-06T12:00:00.000Z");
    const validation = validateTeamDirectorySnapshot(snapshot);
    expect(validation.valid).toBe(true);
    expect(snapshot.teamId).toBe("team-p6-09");
  });
});

// ===========================================================================
// P6-04: Worker launcher planning smoke
// ===========================================================================

describe("P6-04 worker launcher planning smoke", () => {
  it("plans worker launch", () => {
    // API: planWorkerLaunch(params: WorkerLaunchParams)
    // WorkerLaunchParams requires explicit team/member owner inputs.
    const params: WorkerLaunchParams = {
      workerId: "coder-1",
      teamId: "team-p6-09",
      memberId: "coder-1",
      role: "coder",
      stateRoot: "/home/project",
      runId: "run-001",
      assignmentId: "assignment-smoke",
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
      teamId: "team-p6-09",
      memberId: "coder-1",
      runId: "run-001",
      assignmentId: "assignment-smoke",
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
    expect(cmd.args.join(" ")).not.toContain("--channel");
    expect(cmd.args.join(" ")).toContain("--state-dir");
  });
});

// ===========================================================================
// P6-05: Status projector smoke
// ===========================================================================

describe("P6-05 status projector smoke", () => {
  it("classifies healthy worker", () => {
    const r = projectWorkerStatus({
      member: makeMember(),
      config: makeConfig(),
    });
    // WorkerStatusProjection uses 'status' not 'code'
    expect(r.status).toBe("healthy");
    expect(r.memberStatus).toBe("active");
  });

  it("detects stale heartbeat", () => {
    const r = projectWorkerStatus({
      member: makeMember({ lastHeartbeat: "2026-06-06T11:50:00.000Z" }),
      config: makeConfig(),
    });
    expect(r.status).toBe("degraded");
    // riskFlags (not warnings) contains heartbeat-related flag
    expect(r.riskFlags.length).toBeGreaterThan(0);
  });

  it("classifies terminated worker", () => {
    const r = projectWorkerStatus({
      member: makeMember({ status: "terminated" }),
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
  it("chains: add member -> create team -> plan launch -> project status -> record evidence", () => {
    // 1. Team roster
    const roster = applyRosterEvents(createTeamRosterState("team-p6-09"), [
      {
        kind: "member_added", eventId: "e1", memberId: "coder-1",
        role: "coder", channel: "p6-09",
        metadata: { workspace: "/tmp/e2e-test", branch: "codex/p6/09" },
      },
    ]);
    expect(lookupMember(roster, "coder-1")).toBeDefined();

    // 2. Directory store snapshot
    const snapshot = createTeamDirectorySnapshot(roster, "2026-06-06T12:00:00.000Z");
    expect(validateTeamDirectorySnapshot(snapshot).valid).toBe(true);

    // 3. Worker launcher plan
    const plan = planWorkerLaunch({
      workerId: "coder-1",
      teamId: "team-p6-09",
      memberId: "coder-1",
      role: "coder",
      stateRoot: "/tmp/e2e-test",
      runId: "run-e2e-001",
      assignmentId: "t1",
      workspace: "/tmp/e2e-test",
      branch: "codex/p6/09",
      channel: "p6-09",
      taskPrompt: "E2E task",
      allowedActions: ["read", "write", "test"],
      now: "2026-06-06T12:00:00.000Z",
    });
    expect(plan.runId).toBe("run-e2e-001");

    // 4. Status projector
    const proj = projectWorkerStatus({
      member: makeMember({
        memberId: "coder-1",
        runId: plan.runId,
        ledgerId: "L20260606-153739",
      }),
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

    // 5. Handoff evidence
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
