import { describe, it, expect } from "vitest";
import {
  createLifecycleServiceState,
  executeLifecycleCommand,
  type LifecycleCliPorts,
  type LifecycleServiceState,
} from "../src/subagent/lifecycle-cli.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  type ContactRegistryState,
} from "../src/subagent/contact-registry.js";

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------
let fakeSeq = 0;
function makePorts(now = "2026-06-06T00:00:00.000Z"): LifecycleCliPorts {
  return {
    nowIso: () => now,
    newEventId: (prefix: string) => `${prefix}-${++fakeSeq}`,
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

function makeServiceState(
  registryState: ContactRegistryState,
): LifecycleServiceState {
  return createLifecycleServiceState(registryState);
}

// Helper to get extra data from success envelope
function extra(result: any): any {
  if (!result.ok) throw new Error(`Expected success but got error: ${result.error}`);
  return result;
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
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lifecycle-status", "w1"]);

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.status).toBe("active");
    expect(result.hasHeartbeat).toBe(true);
  });

  it("returns failure for unknown worker", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lifecycle-status", "unknown"]);

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
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lifecycle-status", "w1"]);

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.lastHeartbeatAgeMs).toBeDefined();
    // ~60 seconds heartbeat age
    expect(result.lastHeartbeatAgeMs).toBeGreaterThan(50000);
    expect(result.lastHeartbeatAgeMs).toBeLessThan(70000);
  });
});

// ---------------------------------------------------------------------------
// Lease update
// ---------------------------------------------------------------------------
describe("lifecycle CLI - lease", () => {
  it("records a lease/heartbeat for a known worker", () => {
    const ports = makePorts("2026-06-06T00:05:00.000Z");
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lease", "w1"]);

    expect(result.ok).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.newHeartbeat).toBe("2026-06-06T00:05:00.000Z");
    // state should have been updated
    const updated = result.state.contactRegistry.workers["w1"];
    expect(updated.lastHeartbeat).toBe("2026-06-06T00:05:00.000Z");
  });

  it("accepts optional lease expiry duration", () => {
    const ports = makePorts("2026-06-06T00:05:00.000Z");
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lease", "w1", "--expiry-ms", "60000"]);

    expect(result.ok).toBe(true);
    expect(result.expiryMs).toBe(60000);
  });

  it("rejects for unknown worker", () => {
    const ports = makePorts();
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lease", "unknown"]);

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
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["shutdown", "w1"]);

    // By default, shutdown is dry-run (plan only)
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.workerId).toBe("w1");
    expect(result.plan).toBeDefined();
    expect(result.plan.action).toBe("shutdown");
  });

  it("executes shutdown with --execute flag", () => {
    const ports = makePorts("2026-06-06T00:10:00.000Z");
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "active" }]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["shutdown", "w1", "--execute"]);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    // Worker should now be offline
    const updated = result.state.contactRegistry.workers["w1"];
    expect(updated.status).toBe("offline");
  });

  it("rejects shutdown for already terminated worker", () => {
    const ports = makePorts();
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([{ workerId: "w1", status: "terminated" }]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["shutdown", "w1", "--execute"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("terminated");
  });

  it("rejects for unknown worker", () => {
    const ports = makePorts();
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["shutdown", "unknown"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Stale reaper
// ---------------------------------------------------------------------------
describe("lifecycle CLI - reaper", () => {
  const now = "2026-06-06T00:10:00.000Z";

  function makeStaleRegistry(): ContactRegistryState {
    fakeSeq = 0;
    return makeRegistryWithWorkers([
      { workerId: "active-w1", status: "active", lastHeartbeat: "2026-06-06T00:09:00.000Z" },
      { workerId: "stale-w1", status: "active", lastHeartbeat: "2026-06-06T00:04:00.000Z" },
      { workerId: "stale-w2", status: "idle", lastHeartbeat: "2026-06-06T00:01:00.000Z" },
      { workerId: "no-hb-w1", status: "active" },
      { workerId: "terminated-w1", status: "terminated", lastHeartbeat: "2026-06-06T00:01:00.000Z" },
    ]);
  }

  it("reaper list shows stale workers (dry-run)", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["reaper", "list", "--threshold-ms", "300000"]);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.totalWorkers).toBe(5);
    // stale-w1 (6min ago) and stale-w2 (9min ago) + no-hb-w1 (never heartbeated)
    expect(result.staleWorkers.length).toBe(3);
    const staleIds = result.staleWorkers.map((s: any) => s.workerId).sort();
    expect(staleIds).toContain("stale-w1");
    expect(staleIds).toContain("stale-w2");
    expect(staleIds).toContain("no-hb-w1");
  });

  it("reaper list with custom threshold", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["reaper", "list", "--threshold-ms", "120000"]);

    expect(result.ok).toBe(true);
    // stale-w1 (6min), stale-w2 (9min), no-hb-w1 = 3 stale
    expect(result.staleWorkers.length).toBe(3);
  });

  it("reaper list with wider threshold catches more workers", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["reaper", "list", "--threshold-ms", "60000"]);

    expect(result.ok).toBe(true);
    // active-w1: 1min ago = NOT stale (exactly at boundary with >)
    // stale-w1: 6min ago = stale, stale-w2: 9min ago = stale, no-hb-w1 = stale
    expect(result.staleWorkers.length).toBe(3);
  });

  it("reaper execute terminates stale workers", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);

    const result = executeLifecycleCommand(ports, svc, ["reaper", "execute", "--threshold-ms", "300000", "--execute"]);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    expect(result.terminatedWorkers.length).toBe(3);
    const termIds = result.terminatedWorkers.map((t: any) => t.workerId).sort();
    expect(termIds).toContain("stale-w1");
    expect(termIds).toContain("stale-w2");
    expect(termIds).toContain("no-hb-w1");

    // Verify state: stale workers should now be terminated
    const updatedState = result.state.contactRegistry;
    expect(updatedState.workers["stale-w1"].status).toBe("terminated");
    expect(updatedState.workers["stale-w2"].status).toBe("terminated");
    expect(updatedState.workers["no-hb-w1"].status).toBe("terminated");
    // active workers should NOT be terminated
    expect(updatedState.workers["active-w1"].status).toBe("active");
  });

  it("reaper execute without --execute is dry-run", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);

    const result = executeLifecycleCommand(ports, svc, ["reaper", "execute", "--threshold-ms", "300000"]);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
  });

  it("reaper handles empty registry", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);

    const result = executeLifecycleCommand(ports, svc, ["reaper", "list"]);

    expect(result.ok).toBe(true);
    expect(result.totalWorkers).toBe(0);
    expect(result.staleWorkers.length).toBe(0);
  });

  it("reaper filters out terminated workers", () => {
    const ports = makePorts(now);
    fakeSeq = 0;
    const reg = makeStaleRegistry();
    const svc = makeServiceState(reg);

    const result = executeLifecycleCommand(ports, svc, ["reaper", "list", "--threshold-ms", "300000"]);

    expect(result.ok).toBe(true);
    const staleIds = result.staleWorkers.map((s: any) => s.workerId);
    expect(staleIds).not.toContain("terminated-w1");
  });
});

// ---------------------------------------------------------------------------
// Help and error handling
// ---------------------------------------------------------------------------
describe("lifecycle CLI - help and errors", () => {
  it("returns help for empty args", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, []);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("subcommand");
  });

  it("returns help for unknown subcommand", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["unknown-cmd"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });

  it("returns usage for missing workerId in lifecycle-status", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([]);
    const svc = makeServiceState(reg);
    const result = executeLifecycleCommand(ports, svc, ["lifecycle-status"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------
describe("lifecycle CLI - barrel exports", () => {
  it("exports createLifecycleServiceState and executeLifecycleCommand", () => {
    expect(typeof createLifecycleServiceState).toBe("function");
    expect(typeof executeLifecycleCommand).toBe("function");
  });
});
