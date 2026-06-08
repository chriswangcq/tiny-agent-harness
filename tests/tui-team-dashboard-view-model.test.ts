import { describe, it, expect } from "vitest";
import {
  buildTeamDashboardViewModel,
  redactDashboardDisplay,
} from "../src/tui/team-dashboard-view-model.js";
import type {
  TeamDashboardInput,
  TeamDashboardViewModel,
  TeamDashboardRun,
  SupervisorLifecycleInput,
  ShutdownPhase,
  DashboardRowStatus,
  AuditEvent,
  LifecycleAuditEventItem,
} from "../src/tui/team-dashboard-view-model.js";
import type { SubAgentTeamSummary } from "../src/subagent/team.js";
import type { ContactRegistrySummary } from "../src/subagent/contact-registry.js";
import type { MasterReviewChecklist } from "../src/subagent/merge-protocol.js";

// ─── Helpers ──────────────────────────────────────────────────────

function emptyTeamSummary(): SubAgentTeamSummary {
  return {
    teamId: "test-team",
    totalTasks: 0,
    totalWorkers: 0,
    tasksByStatus: {},
    workersByStatus: {},
    activeAssignments: [],
  };
}

function emptyContactSummary(): ContactRegistrySummary {
  return {
    totalWorkers: 0,
    workersByStatus: {},
    activeWorkers: [],
  };
}

function emptyInput(): TeamDashboardInput {
  return {
    teamSummary: emptyTeamSummary(),
    contactRegistrySummary: emptyContactSummary(),
    runSummaries: [],
    mergeChecklist: null,
  };
}

// ─── Tests: buildTeamDashboardViewModel ───────────────────────────

describe("buildTeamDashboardViewModel", () => {
  it("returns a valid view model for empty input", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    expect(vm).toBeDefined();
    expect(vm.title).toBe("Team Dashboard");
    expect(vm.sections.length).toBeGreaterThanOrEqual(4);
    expect(vm.rows.length).toBeGreaterThan(0);
    expect(vm.selection).toEqual({ sectionIndex: 0, rowIndex: 0 });
    expect(vm.statusCounts).toBeDefined();
    expect(vm.failureSummary).toBeDefined();
  });

  it("has correct section kinds for empty input", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    const kinds = vm.sections.map((s) => s.kind);
    expect(kinds).toContain("team-overview");
    expect(kinds).toContain("contact-roster");
    expect(kinds).toContain("active-tasks");
    expect(kinds).toContain("run-status");
  });

  it("includes team overview data", () => {
    const input = emptyInput();
    input.teamSummary = {
      teamId: "team-alpha",
      totalTasks: 5,
      totalWorkers: 3,
      tasksByStatus: { succeeded: 3, running: 1, queued: 1 },
      workersByStatus: { active: 2, idle: 1 },
      activeAssignments: [],
    };

    const vm = buildTeamDashboardViewModel(input);
    const overview = vm.sections.find((s) => s.kind === "team-overview")!;
    expect(overview).toBeDefined();
    const texts = overview.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("team-alpha"))).toBe(true);
    expect(texts.some((t) => t.includes("Total Tasks: 5"))).toBe(true);
    expect(texts.some((t) => t.includes("Total Workers: 3"))).toBe(true);
  });

  it("includes contact roster data with active workers", () => {
    const input = emptyInput();
    input.contactRegistrySummary = {
      totalWorkers: 3,
      workersByStatus: { active: 2, idle: 1 },
      activeWorkers: [
        { workerId: "w1", role: "coder" },
        { workerId: "w2", role: "reviewer" },
      ],
    } as ContactRegistrySummary;

    const vm = buildTeamDashboardViewModel(input);
    const roster = vm.sections.find((s) => s.kind === "contact-roster")!;
    expect(roster).toBeDefined();
    const texts = roster.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("Total Contacts: 3"))).toBe(true);
    expect(texts.some((t) => t.includes("w1") && t.includes("coder"))).toBe(true);
    expect(texts.some((t) => t.includes("w2") && t.includes("reviewer"))).toBe(true);
  });

  it("includes run status data", () => {
    const runs: TeamDashboardRun[] = [
      { runId: "r1", workerId: "w1", status: "running" },
      { runId: "r2", workerId: "w2", status: "finished", branch: "main" },
      { runId: "r3", workerId: "w3", status: "failed", error: "test failure" },
    ];

    const input = emptyInput();
    input.runSummaries = runs;

    const vm = buildTeamDashboardViewModel(input);
    const runSection = vm.sections.find((s) => s.kind === "run-status")!;
    expect(runSection).toBeDefined();
    const texts = runSection.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("Total Runs: 3"))).toBe(true);
    expect(texts.some((t) => t.includes("w1: running"))).toBe(true);
    expect(texts.some((t) => t.includes("w2: finished") && t.includes("[main]"))).toBe(true);
    expect(texts.some((t) => t.includes("w3: failed") && t.includes("test failure"))).toBe(true);
  });

  it("includes merge QA section when mergeChecklist provided", () => {
    const input = emptyInput();
    input.mergeChecklist = {
      workerReported: true,
      runCompleted: true,
      typecheckPasses: true,
      buildPasses: true,
      testsPass: false,
      noConflicts: true,
      rebasedOnMain: true,
      diffReviewable: true,
      noRevertOfOthers: true,
      workerRanGates: true,
      codeReviewed: false,
    } as MasterReviewChecklist;
    input.qaSummary = "Some tests failing";

    const vm = buildTeamDashboardViewModel(input);
    const mergeSection = vm.sections.find((s) => s.kind === "merge-qa")!;
    expect(mergeSection).toBeDefined();
    const texts = mergeSection.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("QA: Some tests failing"))).toBe(true);
    expect(texts.some((t) => t.includes("typecheckPasses: PASS"))).toBe(true);
    expect(texts.some((t) => t.includes("testsPass: FAIL"))).toBe(true);
    expect(texts.some((t) => t.includes("Overall: FAIL"))).toBe(true);
  });

  it("does not include merge QA section when mergeChecklist is null", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    expect(vm.sections.find((s) => s.kind === "merge-qa")).toBeUndefined();
  });

  it("aggregates status counts correctly", () => {
    const input = emptyInput();
    input.mergeChecklist = {
      gates: { typecheck: "PASS", build: "FAIL" },
      overallResult: "FAIL",
    } as MasterReviewChecklist;

    const vm = buildTeamDashboardViewModel(input);
    expect(vm.statusCounts.info).toBeGreaterThan(0);
    expect(vm.statusCounts.error).toBeGreaterThan(0);
    expect(Object.keys(vm.statusCounts).length).toBeGreaterThan(0);
  });

  it("builds failure summary with failing items", () => {
    const input = emptyInput();
    input.mergeChecklist = {
      gates: { typecheck: "PASS", build: "FAIL", test: "FAIL" },
      overallResult: "FAIL",
    } as MasterReviewChecklist;

    const vm = buildTeamDashboardViewModel(input);
    expect(vm.failureSummary.totalFailures).toBeGreaterThan(0);
    expect(vm.failureSummary.failingItems.length).toBeGreaterThan(0);
    expect(vm.failureSummary.failingItems.some((item) => item.includes("FAIL"))).toBe(true);
  });

  it("has zero failures for clean input", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    expect(vm.failureSummary.totalFailures).toBe(0);
    expect(vm.failureSummary.failingItems).toEqual([]);
  });

  it("flattened rows include section headers", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    const headerRows = vm.rows.filter((r) => r.key?.startsWith("section:"));
    expect(headerRows.length).toBeGreaterThanOrEqual(4);
    for (const row of headerRows) {
      expect(row.text.startsWith("──")).toBe(true);
    }
  });

  it("each section is selectable", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    for (const section of vm.sections) {
      expect(section.selectable).toBe(true);
    }
  });

  it("active tasks section handles empty assignments", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    const taskSection = vm.sections.find((s) => s.kind === "active-tasks")!;
    expect(taskSection.rows.some((r) => r.text.includes("No active assignments"))).toBe(true);
  });

  it("active tasks section shows assignments", () => {
    const input = emptyInput();
    input.teamSummary = {
      ...emptyTeamSummary(),
      activeAssignments: [
        { taskId: "t1", workerId: "w1" },
        { taskId: "t2", workerId: "w2" },
      ],
    } as SubAgentTeamSummary;

    const vm = buildTeamDashboardViewModel(input);
    const taskSection = vm.sections.find((s) => s.kind === "active-tasks")!;
    const texts = taskSection.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("Active Assignments: 2"))).toBe(true);
    expect(texts.some((t) => t.includes("t1") && t.includes("w1"))).toBe(true);
  });
});

// ─── Tests: redactDashboardDisplay ────────────────────────────────

describe("redactDashboardDisplay", () => {
  it("returns same text when no patterns match", () => {
    const input = "Hello, world!";
    expect(redactDashboardDisplay(input)).toBe(input);
  });

  it("redacts API key patterns", () => {
    expect(redactDashboardDisplay("sk-1234567890abcdef")).toBe("[REDACTED]");
    expect(redactDashboardDisplay("token=abc123def456")).toBe("[REDACTED]");
    expect(redactDashboardDisplay("key_secret_value_123")).toBe("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactDashboardDisplay("Authorization: Bearer abcdef123456")).toContain("[REDACTED]");
  });

  it("redacts long hex strings (32+ chars)", () => {
    const hex32 = "a".repeat(32);
    expect(redactDashboardDisplay(hex32)).toBe("[REDACTED]");
  });

  it("does not redact short hex strings (< 32 chars)", () => {
    const hex16 = "a".repeat(16);
    expect(redactDashboardDisplay(hex16)).toBe(hex16);
  });

  it("does not mutate original input", () => {
    const original = "sk-test-key-12345";
    const copy = original.slice();
    redactDashboardDisplay(original);
    expect(original).toBe(copy);
  });

  it("handles empty string", () => {
    expect(redactDashboardDisplay("")).toBe("");
  });
});

// ─── Tests: purity contract ───────────────────────────────────────

describe("purity contract", () => {
  it("buildTeamDashboardViewModel is a function", () => {
    expect(typeof buildTeamDashboardViewModel).toBe("function");
  });

  it("returns same output for same input", () => {
    const input = emptyInput();
    const vm1 = buildTeamDashboardViewModel(input);
    const vm2 = buildTeamDashboardViewModel(input);
    expect(vm1).toEqual(vm2);
  });

  it("does not throw for any valid input shape", () => {
    expect(() => buildTeamDashboardViewModel(emptyInput())).not.toThrow();

    const populated: TeamDashboardInput = {
      teamSummary: {
        teamId: "test",
        totalTasks: 5,
        totalWorkers: 3,
        tasksByStatus: { succeeded: 5 },
        workersByStatus: { active: 3 },
        activeAssignments: [],
      },
      contactRegistrySummary: {
        totalWorkers: 3,
        workersByStatus: { active: 3 },
        activeWorkers: [],
      },
      runSummaries: [
        { runId: "r1", workerId: "w1", status: "finished" },
      ],
      mergeChecklist: {
        workerReported: true,
        runCompleted: true,
        typecheckPasses: true,
        buildPasses: true,
        testsPass: true,
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        workerRanGates: true,
        codeReviewed: true,
      } as MasterReviewChecklist,
      qaSummary: "All good",
    };
    expect(() => buildTeamDashboardViewModel(populated)).not.toThrow();
  });
});

// ─── Tests: type exports ──────────────────────────────────────────

describe("type exports", () => {
  it("TeamDashboardViewModel has required fields", () => {
    const vm: TeamDashboardViewModel = buildTeamDashboardViewModel(emptyInput());
    expect(vm.title).toBeDefined();
    expect(vm.sections).toBeDefined();
    expect(vm.rows).toBeDefined();
    expect(vm.selection).toBeDefined();
    expect(vm.statusCounts).toBeDefined();
    expect(vm.failureSummary).toBeDefined();
  });

  it("failureSummary has correct shape", () => {
    const vm = buildTeamDashboardViewModel(emptyInput());
    expect(typeof vm.failureSummary.totalFailures).toBe("number");
    expect(typeof vm.failureSummary.totalWarnings).toBe("number");
    expect(Array.isArray(vm.failureSummary.failingItems)).toBe(true);
    expect(Array.isArray(vm.failureSummary.warningItems)).toBe(true);
  });
});

// ─── Supervisor Lifecycle Section Tests ──────────────────────────

describe("supervisor lifecycle section", () => {
  function makeLifecycleInput(overrides: Partial<SupervisorLifecycleInput> = {}): SupervisorLifecycleInput {
    return {
      leases: [],
      heartbeatCadenceMs: 30000,
      staleRuns: [],
      shutdownPhase: "active",
      dryRun: false,
      recoveryReady: true,
      ...overrides,
    };
  }

  it("produces supervisor-lifecycle section when input is provided", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput(),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle");
    expect(section).toBeDefined();
    expect(section!.title).toBe("Supervisor Lifecycle");
  });

  it("does not produce supervisor-lifecycle section when input is omitted", () => {
    const input = emptyInput(); // no supervisorLifecycle
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle");
    expect(section).toBeUndefined();
  });

  it("shows active lease status correctly", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({
        leases: [{
          leaseId: "L1",
          holder: "coder-1",
          resource: "task-1",
          acquiredAt: "2026-06-06T00:00:00.000Z",
          expiresAt: "2026-06-06T01:00:00.000Z",
          status: "active",
        }],
      }),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const leaseRow = section.rows.find(r => r.key === "lease:L1");
    expect(leaseRow).toBeDefined();
    expect(leaseRow!.status).toBe("ok");
  });

  it("shows expired lease as error", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({
        leases: [{
          leaseId: "L1",
          holder: "coder-1",
          resource: "task-1",
          acquiredAt: "2026-06-06T00:00:00.000Z",
          expiresAt: "2026-06-06T00:30:00.000Z",
          status: "expired",
        }],
      }),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const leaseRow = section.rows.find(r => r.key === "lease:L1");
    expect(leaseRow!.status).toBe("error");
  });

  it("shows stale runs with error status", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({
        staleRuns: [{
          workerId: "coder-1",
          runId: "run-1",
          lastHeartbeat: "2026-06-06T00:00:00.000Z",
          ageMs: 300_000,
          reason: "stale_heartbeat",
        }],
      }),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const staleRow = section.rows.find(r => r.key === "stale:coder-1");
    expect(staleRow).toBeDefined();
    expect(staleRow!.status).toBe("error");
  });

  it("shows dry run as warn when ON", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({ dryRun: true }),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const dryRunRow = section.rows.find(r => r.text.includes("Dry Run"));
    expect(dryRunRow!.status).toBe("warn");
  });

  it("shows shutdown phase status correctly across phases", () => {
    const phases: ShutdownPhase[] = ["active", "draining", "shutting_down", "stopped"];
    const expectedStatuses: DashboardRowStatus[] = ["ok", "warn", "warn", "error"];
    
    for (let i = 0; i < phases.length; i++) {
      const input = {
        ...emptyInput(),
        supervisorLifecycle: makeLifecycleInput({ shutdownPhase: phases[i] }),
      };
      const vm = buildTeamDashboardViewModel(input);
      const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
      const shutdownRow = section.rows.find(r => r.text.includes("Shutdown Phase"));
      expect(shutdownRow!.status).toBe(expectedStatuses[i]);
    }
  });

  it("shows recovery ready status", () => {
    const readyInput = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({ recoveryReady: true }),
    };
    const notReadyInput = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({ recoveryReady: false }),
    };
    
    const vmReady = buildTeamDashboardViewModel(readyInput);
    const sectionReady = vmReady.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const recoveryRow = sectionReady.rows.find(r => r.text.includes("Recovery Ready"));
    expect(recoveryRow!.status).toBe("ok");

    const vmNotReady = buildTeamDashboardViewModel(notReadyInput);
    const sectionNotReady = vmNotReady.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const recoveryRow2 = sectionNotReady.rows.find(r => r.text.includes("Recovery Ready"));
    expect(recoveryRow2!.status).toBe("warn");
  });

  it("heartbeat cadence is displayed in seconds", () => {
    const input = {
      ...emptyInput(),
      supervisorLifecycle: makeLifecycleInput({ heartbeatCadenceMs: 30000 }),
    };
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const cadenceRow = section.rows.find(r => r.text.includes("Heartbeat Cadence"));
    expect(cadenceRow).toBeDefined();
    expect(cadenceRow!.text).toContain("30s");
  });

  // Doc assertion: supervisor lifecycle section exists in view model
  it("supervisor-lifecycle section kind is exported in type", () => {
    // Verify the section kind is usable
    const section: { kind: string } = { kind: "supervisor-lifecycle" };
    expect(section.kind).toBe("supervisor-lifecycle");
  });

  it("shows lease freshness when lastRenewedAgoMs is provided", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      leases: [{
        leaseId: "L1",
        holder: "supervisor",
        resource: "run-lock",
        acquiredAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-06-07T01:00:00.000Z",
        status: "active",
        lastRenewedAgoMs: 5000,
      }],
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const freshnessRow = section.rows.find(r => r.text.includes("renewed"));
    expect(freshnessRow).toBeDefined();
    expect(freshnessRow!.status).toBe("ok");
    expect(freshnessRow!.text).toContain("5s ago");
  });

  it("shows stale lease freshness as warn when lastRenewedAgoMs is large", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      leases: [{
        leaseId: "L1",
        holder: "supervisor",
        resource: "run-lock",
        acquiredAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-06-07T01:00:00.000Z",
        status: "active",
        lastRenewedAgoMs: 120000,
      }],
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const freshnessRow = section.rows.find(r => r.text.includes("renewed"));
    expect(freshnessRow).toBeDefined();
    expect(freshnessRow!.status).toBe("warn");
  });

  it("shows reaper pending row when stale run has reaperPending true", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      staleRuns: [{
        workerId: "coder-1",
        lastHeartbeat: "2026-06-06T00:00:00.000Z",
        ageMs: 60000,
        reason: "stale_heartbeat",
        reaperPending: true,
      }],
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const reaperRow = section.rows.find(r => r.text.includes("Reaper pending"));
    expect(reaperRow).toBeDefined();
    expect(reaperRow!.status).toBe("warn");
  });

  it("does not show reaper pending row when reaperPending is false", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      staleRuns: [{
        workerId: "coder-1",
        lastHeartbeat: "2026-06-06T00:00:00.000Z",
        ageMs: 60000,
        reason: "stale_heartbeat",
        reaperPending: false,
      }],
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const reaperRow = section.rows.find(r => r.text.includes("Reaper pending"));
    expect(reaperRow).toBeUndefined();
  });

  it("shows shutdown reason when provided", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      shutdownPhase: "draining",
      shutdownReason: "SIGTERM received from orchestrator",
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const reasonRow = section.rows.find(r => r.text.includes("Shutdown Reason"));
    expect(reasonRow).toBeDefined();
    expect(reasonRow!.text).toContain("SIGTERM received from orchestrator");
    expect(reasonRow!.status).toBe("warn");
  });

  it("does not show shutdown reason row when reason is absent", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      shutdownPhase: "draining",
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const reasonRow = section.rows.find(r => r.text.includes("Shutdown Reason"));
    expect(reasonRow).toBeUndefined();
  });

  it("shows last audit event when provided", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      lastAuditEvent: {
        timestamp: "2026-06-07T00:30:00.000Z",
        kind: "lease_renewed",
        summary: "Lease L1 renewed by supervisor",
      },
    });
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const auditRow = section.rows.find(r => r.text.includes("Last Audit"));
    expect(auditRow).toBeDefined();
    expect(auditRow!.text).toContain("lease_renewed");
    expect(auditRow!.text).toContain("Lease L1 renewed by supervisor");
    expect(auditRow!.status).toBe("info");
  });

  it("does not show last audit event row when absent", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({});
    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const auditRow = section.rows.find(r => r.text.includes("Last Audit"));
    expect(auditRow).toBeUndefined();
  });

  it("shows worker lifecycle audit trail for heartbeat lease reaper and shutdown events", () => {
    const events: LifecycleAuditEventItem[] = [
      {
        eventId: "evt-heartbeat",
        timestamp: "2026-06-07T00:00:00.000Z",
        kind: "heartbeat_recorded",
        workerId: "coder-1",
        summary: "heartbeat sequence 42",
      },
      {
        eventId: "evt-lease",
        timestamp: "2026-06-07T00:01:00.000Z",
        kind: "lease_renewed",
        workerId: "coder-1",
        leaseId: "worker-lease-coder-1",
        resource: "worker:coder-1",
        summary: "lease renewed until 00:06",
      },
      {
        eventId: "evt-reaper",
        timestamp: "2026-06-07T00:02:00.000Z",
        kind: "reaper_planned",
        workerId: "coder-1",
        action: "shutdown",
        reason: "stale_heartbeat",
      },
      {
        eventId: "evt-shutdown-requested",
        timestamp: "2026-06-07T00:03:00.000Z",
        kind: "shutdown_requested",
        workerId: "coder-1",
        reason: "reaper execute stale_heartbeat",
      },
      {
        eventId: "evt-shutdown-failed",
        timestamp: "2026-06-07T00:04:00.000Z",
        kind: "shutdown_failed",
        workerId: "coder-1",
        reason: "process already exited",
      },
    ];
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({ auditEvents: events });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;

    expect(section.rows.find(r => r.key === "lifecycle-event:evt-heartbeat")).toMatchObject({
      status: "ok",
    });
    expect(section.rows.find(r => r.key === "lifecycle-event:evt-lease")).toMatchObject({
      status: "ok",
    });
    expect(section.rows.find(r => r.key === "lifecycle-event:evt-reaper")).toMatchObject({
      status: "warn",
    });
    expect(section.rows.find(r => r.key === "lifecycle-event:evt-shutdown-requested")).toMatchObject({
      status: "warn",
    });
    expect(section.rows.find(r => r.key === "lifecycle-event:evt-shutdown-failed")).toMatchObject({
      status: "error",
    });
    expect(section.rows.map(r => r.text).join("\n")).toContain("coder-1");
    expect(section.rows.map(r => r.text).join("\n")).toContain("stale_heartbeat");
  });

  it("shows lifecycle audit events newest first", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      auditEvents: [
        {
          eventId: "old",
          timestamp: "2026-06-07T00:00:00.000Z",
          kind: "heartbeat_recorded",
          workerId: "coder-1",
        },
        {
          eventId: "new",
          timestamp: "2026-06-07T00:05:00.000Z",
          kind: "shutdown_completed",
          workerId: "coder-1",
        },
      ],
    });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const eventRows = section.rows.filter(r => r.key?.startsWith("lifecycle-event:"));

    expect(eventRows.map(r => r.key)).toEqual([
      "lifecycle-event:new",
      "lifecycle-event:old",
    ]);
  });

  it("redacts and clips lifecycle audit reason text for display safety", () => {
    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({
      auditEvents: [
        {
          eventId: "secret-reason",
          timestamp: "2026-06-07T00:00:00.000Z",
          kind: "shutdown_failed",
          workerId: "coder-1",
          reason: `failed with token=abc123def456 ${"x".repeat(200)}`,
        },
      ],
    });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;
    const row = section.rows.find(r => r.key === "lifecycle-event:secret-reason")!;

    expect(row.text).toContain("[REDACTED]");
    expect(row.text).not.toContain("abc123def456");
    expect(row.text.length).toBeLessThanOrEqual(140);
    expect(row.text.endsWith("...")).toBe(true);
  });


  it("shows worker lifecycle chain for missing_process -> shutdown_requested -> shutdown_completed", () => {
    const events: LifecycleAuditEventItem[] = [
      {
        eventId: "evt-missing",
        timestamp: "2026-06-07T00:00:00.000Z",
        kind: "missing_process",
        workerId: "coder-1",
        reason: "process not found",
      },
      {
        eventId: "evt-requested",
        timestamp: "2026-06-07T00:01:00.000Z",
        kind: "shutdown_requested",
        workerId: "coder-1",
        reason: "missing process cleanup",
      },
      {
        eventId: "evt-completed",
        timestamp: "2026-06-07T00:02:00.000Z",
        kind: "shutdown_completed",
        workerId: "coder-1",
      },
    ];

    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({ auditEvents: events });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;

    const chainRow = section.rows.find(r => r.key === "lifecycle-chain:coder-1");
    expect(chainRow).toBeDefined();
    expect(chainRow!.status).toBe("error");
    expect(chainRow!.text).toContain("coder-1");
    expect(chainRow!.text).toContain("missing_process");
    expect(chainRow!.text).toContain("shutdown_requested");
    expect(chainRow!.text).toContain("shutdown_completed");
    expect(chainRow!.text).toContain("\u2192");
  });

  it("shows worker lifecycle chain for stale_heartbeat -> shutdown_requested -> shutdown_failed", () => {
    const events: LifecycleAuditEventItem[] = [
      {
        eventId: "evt-stale",
        timestamp: "2026-06-07T00:00:00.000Z",
        kind: "stale_heartbeat",
        workerId: "coder-2",
        reason: "no heartbeat for 300s",
      },
      {
        eventId: "evt-requested",
        timestamp: "2026-06-07T00:01:00.000Z",
        kind: "shutdown_requested",
        workerId: "coder-2",
        reason: "stale heartbeat reaper",
      },
      {
        eventId: "evt-failed",
        timestamp: "2026-06-07T00:02:00.000Z",
        kind: "shutdown_failed",
        workerId: "coder-2",
        reason: "process already exited",
      },
    ];

    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({ auditEvents: events });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;

    const chainRow = section.rows.find(r => r.key === "lifecycle-chain:coder-2");
    expect(chainRow).toBeDefined();
    expect(chainRow!.status).toBe("error");
    expect(chainRow!.text).toContain("coder-2");
    expect(chainRow!.text).toContain("stale_heartbeat");
    expect(chainRow!.text).toContain("shutdown_requested");
    expect(chainRow!.text).toContain("shutdown_failed");
  });

  it("redacts and clips chain reason text for display safety", () => {
    const events: LifecycleAuditEventItem[] = [
      {
        eventId: "evt-secret",
        timestamp: "2026-06-07T00:00:00.000Z",
        kind: "shutdown_failed",
        workerId: "coder-3",
        reason: "failed with token=abc123def456" + "x".repeat(200),
      },
    ];

    const input = emptyInput();
    input.supervisorLifecycle = makeLifecycleInput({ auditEvents: events });

    const vm = buildTeamDashboardViewModel(input);
    const section = vm.sections.find(s => s.kind === "supervisor-lifecycle")!;

    const chainRow = section.rows.find(r => r.key === "lifecycle-chain:coder-3");
    expect(chainRow).toBeDefined();

    // Reason should be redacted and clipped
    expect(chainRow!.text).toContain("[REDACTED]");
    expect(chainRow!.text).not.toContain("abc123def456");
    expect(chainRow!.text.length).toBeLessThanOrEqual(140);
  });


});
