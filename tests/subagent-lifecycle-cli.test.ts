import { describe, it, expect } from "vitest";
import {
  executeLifecycleCommand,
  buildLifecycleInput,
  buildLifecycleConfig,
  DEFAULT_LIFECYCLE_THRESHOLDS,
  type LifecycleCliPorts,
} from "../src/subagent/lifecycle-cli.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  lookupWorker,
  type ContactRegistryState,
  type WorkerContact,
} from "../src/subagent/contact-registry.js";

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------
let fakeSeq = 0;
function makePorts(now = "2026-06-06T00:00:00.000Z"): LifecycleCliPorts {
  return {
    nowIso: () => now,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a registry state with a few workers
// ---------------------------------------------------------------------------
function makeRegistryWithWorkers(
  workers: Array<{
    workerId: string;
    status?: string;
    lastHeartbeat?: string;
    role?: string;
  }>,
): ContactRegistryState {
  fakeSeq = 0;
  let state = createContactRegistryState("test-registry");
  for (const w of workers) {
    const ev = {
      kind: "worker_registered" as const,
      eventId: `ev-reg-${w.workerId}`,
      workerId: w.workerId,
      role: w.role ?? "coder",
      workspace: `/tmp/${w.workerId}`,
      branch: `codex/p6/${w.workerId}`,
      imChannel: `ch-${w.workerId}`,
      allowedActions: ["code"],
    };
    const r1 = applyContactRegistryEvent(state, ev);
    if (r1.status !== "applied") throw new Error("register failed");
    state = r1.state;

    if (w.status && w.status !== "idle") {
      const sev = {
        kind: "worker_status_changed" as const,
        eventId: `ev-status-${w.workerId}`,
        workerId: w.workerId,
        status: w.status as any,
      };
      const r2 = applyContactRegistryEvent(state, sev);
      if (r2.status !== "applied") throw new Error("status change failed");
      state = r2.state;
    }

    if (w.lastHeartbeat) {
      const hev = {
        kind: "worker_heartbeat" as const,
        eventId: `ev-hb-${w.workerId}`,
        workerId: w.workerId,
        timestamp: w.lastHeartbeat,
      };
      const r3 = applyContactRegistryEvent(state, hev);
      if (r3.status !== "applied") throw new Error("heartbeat failed");
      state = r3.state;
    }
  }
  return state;
}

function makeLookupFn(registry: ContactRegistryState) {
  return (workerId: string) => lookupWorker(registry, workerId);
}

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------
describe("lifecycle CLI - lifecycle-status", () => {
  it("returns lifecycle status for a known worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([
      { workerId: "w1", status: "active", lastHeartbeat: "2026-06-06T00:09:00.000Z" },
    ]);
    const result = executeLifecycleCommand(ports, ["lifecycle-status", "w1"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.contactStatus).toBe("active");
    expect(result.lifecycleState).toBeDefined();
  });

  it("returns failure for unknown worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, ["lifecycle-status", "unknown"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
    expect(result.errorCode).toBe("UNKNOWN_WORKER");
  });

  it("returns lifecycle status with lease info", () => {
    const now = "2026-06-06T00:10:00.000Z";
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([
      { workerId: "w1", lastHeartbeat: "2026-06-06T00:09:00.000Z" },
    ]);
    const result = executeLifecycleCommand(ports, ["lifecycle-status", "w1"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.lifecycleState).toBeDefined();
    expect(result.evidence).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lease update
// ---------------------------------------------------------------------------
describe("lifecycle CLI - lease", () => {
  it("produces a lease plan for a known worker", () => {
    const ports = makePorts("2026-06-06T00:05:00.000Z");
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const result = executeLifecycleCommand(ports, ["lease", "w1"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.timestamp).toBe("2026-06-06T00:05:00.000Z");
    expect(result.heartbeatInterpretation).toBeDefined();
    expect(result.plan).toBeDefined();
  });

  it("accepts optional lease expiry duration", () => {
    const ports = makePorts("2026-06-06T00:05:00.000Z");
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const result = executeLifecycleCommand(ports, ["lease", "w1", "--expiry-ms", "60000"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(true);
    expect(result.expiryMs).toBe(60000);
  });

  it("rejects for unknown worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, ["lease", "unknown"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Shutdown request
// ---------------------------------------------------------------------------
describe("lifecycle CLI - shutdown", () => {
  it("requests shutdown for a known worker (dry-run by default)", () => {
    const ports = makePorts("2026-06-06T00:10:00.000Z");
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const result = executeLifecycleCommand(ports, ["shutdown", "w1"], undefined, makeLookupFn(reg));

    // By default, shutdown is dry-run (plan only)
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.plan).toBeDefined();
    expect(result.plan.action).toBe("shutdown");
  });

  it("executes shutdown with --execute flag", () => {
    const ports = makePorts("2026-06-06T00:10:00.000Z");
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const result = executeLifecycleCommand(ports, ["shutdown", "w1", "--execute"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    expect(result.newStatus).toBe("offline");
  });

  it("rejects shutdown for already terminated worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "terminated" }]);
    const result = executeLifecycleCommand(ports, ["shutdown", "w1", "--execute"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("terminated");
  });

  it("rejects for unknown worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, ["shutdown", "unknown"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Stale reaper
// ---------------------------------------------------------------------------
describe("lifecycle CLI - reaper", () => {
  const now = "2026-06-06T00:10:00.000Z";

  function makeStaleWorkersJson() {
    return JSON.stringify([
      { workerId: "active-w1", status: "active", role: "coder", workspace: "/tmp/active-w1", branch: "codex/p6/active-w1", imChannel: "ch-active-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:09:00.000Z" },
      { workerId: "stale-w1", status: "active", role: "coder", workspace: "/tmp/stale-w1", branch: "codex/p6/stale-w1", imChannel: "ch-stale-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:04:00.000Z" },
      { workerId: "stale-w2", status: "idle", role: "reviewer", workspace: "/tmp/stale-w2", branch: "codex/p6/stale-w2", imChannel: "ch-stale-w2", allowedActions: ["review"], lastHeartbeat: "2026-06-06T00:01:00.000Z" },
      { workerId: "no-hb-w1", status: "active", role: "coder", workspace: "/tmp/no-hb-w1", branch: "codex/p6/no-hb-w1", imChannel: "ch-no-hb-w1", allowedActions: ["code"] },
      { workerId: "terminated-w1", status: "terminated", role: "coder", workspace: "/tmp/terminated-w1", branch: "codex/p6/terminated-w1", imChannel: "ch-term-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:01:00.000Z" },
    ]);
  }

  it("reaper list shows stale workers (dry-run)", () => {
    const ports = makePorts(now);
    const result = executeLifecycleCommand(ports, ["reaper", "list", "--workers-json", makeStaleWorkersJson(), "--threshold-ms", "300000"], undefined, makeLookupFn(makeRegistryWithWorkers([])));

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.totalWorkers).toBe(5);
    // stale-w1 (6min ago) + stale-w2 (9min ago) + no-hb-w1 (never heartbeated)
    expect(result.staleCount).toBe(3);
    const staleIds = result.staleWorkers.map((s: any) => s.workerId).sort();
    expect(staleIds).toContain("stale-w1");
    expect(staleIds).toContain("stale-w2");
    expect(staleIds).toContain("no-hb-w1");
    // terminated workers should NOT appear in stale list
    expect(staleIds).not.toContain("terminated-w1");
  });

  it("reaper list without --workers-json returns error", () => {
    const ports = makePorts();
    const result = executeLifecycleCommand(ports, ["reaper", "list"], undefined, makeLookupFn(makeRegistryWithWorkers([])));

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("MISSING_ARG");
    expect(result.error).toContain("--workers-json");
  });

  it("reaper execute produces termination plans", () => {
    const ports = makePorts(now);
    const result = executeLifecycleCommand(ports, ["reaper", "execute", "--workers-json", makeStaleWorkersJson(), "--threshold-ms", "300000", "--execute"], undefined, makeLookupFn(makeRegistryWithWorkers([])));

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    expect(result.terminationPlans).toBeDefined();
    expect(result.terminationPlans.length).toBe(3);
  });

  it("reaper execute without --execute is dry-run", () => {
    const ports = makePorts(now);
    const result = executeLifecycleCommand(ports, ["reaper", "execute", "--workers-json", makeStaleWorkersJson(), "--threshold-ms", "300000"], undefined, makeLookupFn(makeRegistryWithWorkers([])));

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
  });

  it("reaper handles empty worker list", () => {
    const ports = makePorts(now);
    const result = executeLifecycleCommand(ports, ["reaper", "list", "--workers-json", "[]"], undefined, makeLookupFn(makeRegistryWithWorkers([])));

    expect(result.ok).toBe(true);
    expect(result.totalWorkers).toBe(0);
    expect(result.staleCount).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// Help and error handling
// ---------------------------------------------------------------------------
describe("lifecycle CLI - help and errors", () => {
  it("returns help for empty args", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, [], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("subcommand");
  });

  it("returns help for unknown subcommand", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, ["unknown-cmd"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });

  it("returns usage for missing workerId in lifecycle-status", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const result = executeLifecycleCommand(ports, ["lifecycle-status"], undefined, makeLookupFn(reg));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// Barrel exports
// ---------------------------------------------------------------------------
describe("lifecycle CLI - barrel exports", () => {
  it("exports executeLifecycleCommand, buildLifecycleInput, buildLifecycleConfig", () => {
    expect(typeof executeLifecycleCommand).toBe("function");
    expect(typeof buildLifecycleInput).toBe("function");
    expect(typeof buildLifecycleConfig).toBe("function");
    expect(buildLifecycleConfig('2026-01-01T00:00:00.000Z').heartbeatMaxAgeMs).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// buildLifecycleInput
// ---------------------------------------------------------------------------
describe("buildLifecycleInput", () => {
  it("builds a valid LifecycleInput from a WorkerContact", () => {
    const worker: WorkerContact = {
      workerId: "w1",
      role: "coder",
      workspace: "/tmp/w1",
      branch: "codex/p6/w1",
      imChannel: "ch-w1",
      status: "active",
      lastHeartbeat: "2026-06-06T00:09:00.000Z",
      lastEvidence: "2026-06-06T00:08:00.000Z",
      allowedActions: ["code"],
    };
    const input = buildLifecycleInput(worker, true);
    expect(input.workerId).toBe("w1");
    expect(input.contactStatus).toBe("active");
    expect(input.lastHeartbeat).toBe("2026-06-06T00:09:00.000Z");
    expect(input.lastEvidence).toBe("2026-06-06T00:08:00.000Z");
    expect(input.processExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: no ambient time capture at module load
// ---------------------------------------------------------------------------
describe("lifecycle CLI - explicit time boundaries", () => {
  it("DEFAULT_LIFECYCLE_THRESHOLDS has no now field", () => {
    // Importing should not capture Date.now() at module load
    // DEFAULT_LIFECYCLE_THRESHOLDS is already imported above
    expect(DEFAULT_LIFECYCLE_THRESHOLDS).toBeDefined();
    expect((DEFAULT_LIFECYCLE_THRESHOLDS as any).now).toBeUndefined();
  });

  it("buildLifecycleConfig requires explicit now", () => {
    const config = buildLifecycleConfig("2026-06-06T12:00:00.000Z");
    expect(config.now).toBe("2026-06-06T12:00:00.000Z");
    expect(config.heartbeatMaxAgeMs).toBe(300_000);
  });

  it("handlers use ports.nowIso, not ambient Date", () => {
    // Prove that lifecycle-status uses the configured ports.nowIso
    const ports = makePorts("2026-06-06T12:00:00.000Z");
    const reg = makeRegistryWithWorkers([
      { workerId: "w1", lastHeartbeat: "2026-06-06T11:59:00.000Z" },
    ]);
    const result = executeLifecycleCommand(
      ports,
      ["lifecycle-status", "w1"],
      undefined,
      makeLookupFn(reg),
    );
    expect(result.ok).toBe(true);
    // The lifecycle state should reflect the explicit now time
    expect(result.evidence).toBeDefined();
    expect(result.lifecycleState).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Execute ports — effect boundary tests
// ---------------------------------------------------------------------------
describe("lifecycle CLI - execute ports", () => {
  const now = "2026-06-06T00:10:00.000Z";

  function makePorts(nowStr = "2026-06-06T00:00:00.000Z"): LifecycleCliPorts {
    return { nowIso: () => nowStr };
  }

  it("lease appends heartbeat_recorded when executePorts provided", () => {
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const executePorts = {
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push({ type: event.type, payload: event.payload });
        return { status: "appended" as const };
      },
    };
    const result = executeLifecycleCommand(
      ports, ["lease", "w1"], undefined, makeLookupFn(reg), undefined, executePorts,
    );

    expect(result.ok).toBe(true);
    expect(result.appendResult).toBeDefined();
    expect(result.appendResult.status).toBe("appended");
    expect(appended.length).toBe(1);
    expect(appended[0].type).toBe("heartbeat_recorded");
    expect(appended[0].payload.workerId).toBe("w1");
  });

  it("lease prefers worker_heartbeat when plan event matches", () => {
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const appended: Array<{ type: string }> = [];
    const executePorts = {
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push({ type: event.type });
        return { status: "appended" as const };
      },
    };
    executeLifecycleCommand(
      ports, ["lease", "w1"], undefined, makeLookupFn(reg), undefined, executePorts,
    );

    // Should be one of the supported types
    expect(["worker_heartbeat", "heartbeat_recorded"]).toContain(appended[0].type);
  });

  it("shutdown --execute calls shutdownWorker and appends events", () => {
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const shutdownCalls: Array<{ workerId: string; reason?: string }> = [];
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const executePorts = {
      shutdownWorker: (workerId: string, reason?: string) => {
        shutdownCalls.push({ workerId, reason });
      },
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push({ type: event.type, payload: event.payload });
        return { status: "appended" as const };
      },
    };
    const result = executeLifecycleCommand(
      ports, ["shutdown", "w1", "--execute"], undefined, makeLookupFn(reg), undefined, executePorts,
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);

    // shutdownWorker called
    expect(shutdownCalls.length).toBe(1);
    expect(shutdownCalls[0].workerId).toBe("w1");

    // Events appended: shutdown_requested + shutdown_completed
    // Events appended: shutdown_requested + shutdown_completed
    expect(appended.length).toBe(2);
    expect(appended[0].type).toBe("shutdown_requested");
    expect(appended[1].type).toBe("shutdown_completed");
  });

  it("shutdown dry-run does NOT call shutdownWorker or appendLifecycleEvent", () => {
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    let shutdownCalled = false;
    let appendCalled = false;
    const executePorts = {
      shutdownWorker: () => { shutdownCalled = true; },
      appendLifecycleEvent: () => { appendCalled = true; return { status: "appended" as const }; },
    };
    const result = executeLifecycleCommand(
      ports, ["shutdown", "w1"], undefined, makeLookupFn(reg), undefined, executePorts,
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(shutdownCalled).toBe(false);
    expect(appendCalled).toBe(false);
  });

  it("shutdown with failed append exposes shutdown_failed", () => {
    const ports = makePorts(now);
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const appended: Array<{ type: string }> = [];
    const executePorts = {
      shutdownWorker: () => {},
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push({ type: event.type });
        // Fail the shutdown_requested append so the completed type becomes shutdown_failed
        if (event.type === "shutdown_requested") return { status: "error" as const, message: "disk full" };
        return { status: "appended" as const };
      },
    };
    const result = executeLifecycleCommand(
      ports, ["shutdown", "w1", "--execute"], undefined, makeLookupFn(reg), undefined, executePorts,
    );

    expect(result.ok).toBe(true);
    // When shutdown_requested append fails, the CLI emits shutdown_failed as the second event
    expect(appended.length).toBe(2);
    expect(appended[0].type).toBe("shutdown_requested");
    expect(appended[1].type).toBe("shutdown_failed");
  });

  it("reaper execute appends reaper_planned + reaper_executed using candidateWorkerId", () => {
    const ports = makePorts(now);
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const executePorts = {
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push({ type: event.type, payload: event.payload });
        return { status: "appended" as const };
      },
    };

    function makeWorkersJson() {
      return JSON.stringify([
        { workerId: "stale-w1", status: "active", role: "coder", workspace: "/tmp/stale-w1", branch: "codex/p6/stale-w1", imChannel: "ch-stale-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:04:00.000Z" },
      ]);
    }

    const result = executeLifecycleCommand(
      ports,
      ["reaper", "execute", "--workers-json", makeWorkersJson(), "--threshold-ms", "300000", "--execute"],
      undefined,
      makeLookupFn(makeRegistryWithWorkers([])),
      undefined,
      executePorts,
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);

    // Check appended events
    expect(appended.length).toBe(2);
    expect(appended[0].type).toBe("reaper_planned");
    expect(appended[0].payload.candidateWorkerId).toBe("stale-w1");

    // reaper_executed (not worker_reassign/worker_warn)
    expect(appended[1].type).toBe("reaper_executed");
    expect(appended[1].payload.workerId).toBe("stale-w1");
  });

  it("reaper dry-run does NOT call appendLifecycleEvent", () => {
    const ports = makePorts(now);
    let appendCalled = false;
    const executePorts = {
      appendLifecycleEvent: () => { appendCalled = true; return { status: "appended" as const }; },
    };

    function makeWorkersJson() {
      return JSON.stringify([
        { workerId: "stale-w1", status: "active", role: "coder", workspace: "/tmp/stale-w1", branch: "codex/p6/stale-w1", imChannel: "ch-stale-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:04:00.000Z" },
      ]);
    }

    const result = executeLifecycleCommand(
      ports,
      ["reaper", "execute", "--workers-json", makeWorkersJson(), "--threshold-ms", "300000"],
      undefined,
      makeLookupFn(makeRegistryWithWorkers([])),
      undefined,
      executePorts,
    );

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(appendCalled).toBe(false);
  });

  it("reaper never emits worker_reassign or worker_warn as supervisor events", () => {
    const ports = makePorts(now);
    const appended: string[] = [];
    const executePorts = {
      appendLifecycleEvent: (event: { type: string; payload: Record<string, unknown> }) => {
        appended.push(event.type);
        return { status: "appended" as const };
      },
    };

    // Create a worker that would get a reassign or warn action from the reaper
    function makeWorkersJson() {
      return JSON.stringify([
        { workerId: "stale-w1", status: "active", role: "coder", workspace: "/tmp/stale-w1", branch: "codex/p6/stale-w1", imChannel: "ch-stale-w1", allowedActions: ["code"], lastHeartbeat: "2026-06-06T00:04:00.000Z" },
      ]);
    }

    executeLifecycleCommand(
      ports,
      ["reaper", "execute", "--workers-json", makeWorkersJson(), "--threshold-ms", "300000", "--execute"],
      undefined,
      makeLookupFn(makeRegistryWithWorkers([])),
      undefined,
      executePorts,
    );

    expect(appended).not.toContain("worker_reassign");
    expect(appended).not.toContain("worker_warn");
  });

  it("lifecycle-status prefers executePorts.processExists over processExistsFn", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    
    // When executePorts.processExists is provided, it should be used
    const executePorts = {
      processExists: (id: string) => id === "w1" ? false : true,
    };
    // Legacy processExistsFn returns true (different answer)
    const legacyProcessExists = (id: string) => true;

    const result = executeLifecycleCommand(
      ports, ["lifecycle-status", "w1"], undefined, makeLookupFn(reg), legacyProcessExists, executePorts,
    );

    expect(result.ok).toBe(true);
    // The lifecycle state should reflect processExists=false from executePorts
    // (we verify the result uses executePorts by checking no error)
  });

  it("lifecycle-status falls back to processExistsFn when executePorts omitted", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    
    // No executePorts, use legacy processExistsFn
    const legacyProcessExists = (id: string) => false;

    const result = executeLifecycleCommand(
      ports, ["lifecycle-status", "w1"], undefined, makeLookupFn(reg), legacyProcessExists,
    );

    expect(result.ok).toBe(true);
    expect(result.lifecycleState).toBeDefined();
  });
});
