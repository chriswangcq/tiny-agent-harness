import { describe, it, expect } from "vitest";
import {
  executeLifecycleCommand,
  buildLifecycleInput,
  DEFAULT_LIFECYCLE_CONFIG,
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
  it("reaper requires worker list via error message", () => {
    const ports = makePorts();
    const reg = makeRegistryWithWorkers([{ workerId: "w1" }]);
    const result = executeLifecycleCommand(ports, ["reaper", "list"], undefined, makeLookupFn(reg));

    // Reaper requires full worker list; CLI signals this
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("USAGE");
    expect(result.error).toContain("Reaper requires");
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
  it("exports executeLifecycleCommand, buildLifecycleInput, DEFAULT_LIFECYCLE_CONFIG", () => {
    expect(typeof executeLifecycleCommand).toBe("function");
    expect(typeof buildLifecycleInput).toBe("function");
    expect(DEFAULT_LIFECYCLE_CONFIG).toBeDefined();
    expect(DEFAULT_LIFECYCLE_CONFIG.heartbeatMaxAgeMs).toBe(300_000);
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
