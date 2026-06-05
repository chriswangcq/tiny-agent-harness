import { describe, expect, it } from "vitest";
import {
  applyContactRegistryEvent,
  createContactRegistryState,
  summarizeContactRegistry,
  lookupWorker,
  listWorkersByRole,
  listWorkersByStatus,
  type ContactRegistryEvent,
  type ContactRegistryState,
} from "../src/subagent/contact-registry.js";
import { summarizeContactRegistry as summarizeFromBarrel } from "../src/subagent/index.js";
import { summarizeContactRegistry as summarizeFromRoot } from "../src/index.js";

function applyAll(
  state: ContactRegistryState,
  events: ContactRegistryEvent[],
): ContactRegistryState {
  return events.reduce((current, event) => {
    const result = applyContactRegistryEvent(current, event);
    if (result.status !== "applied") {
      throw new Error(`event ${event.eventId} was ${result.status}`);
    }
    return result.state;
  }, state);
}

describe("contact registry domain", () => {
  it("registers workers and rejects duplicates", () => {
    const state = createContactRegistryState("team-p6");

    const r1 = applyContactRegistryEvent(state, {
      kind: "worker_registered",
      eventId: "e1",
      workerId: "coder-1",
      role: "coder",
      workspace: "/ws/p6-01",
      branch: "codex/p6/01",
      imChannel: "p6-01",
      allowedActions: ["read", "write", "test"],
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.workers["coder-1"]).toMatchObject({
      workerId: "coder-1",
      role: "coder",
      status: "idle",
    });

    const dup = applyContactRegistryEvent(r1.state, {
      kind: "worker_registered",
      eventId: "e2",
      workerId: "coder-1",
      role: "reviewer",
      workspace: "/other",
      branch: "other",
      imChannel: "other",
      allowedActions: [],
    });
    expect(dup.status).toBe("rejected");
    expect(dup.rejection.code).toBe("worker_exists");
  });

  it("applies updates without touching lifecycle fields", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws/p6-01",
        branch: "codex/p6/01",
        imChannel: "p6-01",
        allowedActions: ["read", "write"],
      },
    ]);

    const result = applyContactRegistryEvent(base, {
      kind: "worker_updated",
      eventId: "e2",
      workerId: "coder-1",
      patch: {
        workspace: "/ws/p6-01-updated",
        ledgerId: "ledger-123",
        currentTask: "fix type errors",
        ticket: { id: "T-1", title: "Typecheck", status: "in_progress" },
      },
    });
    expect(result.status).toBe("applied");
    const w = result.state.workers["coder-1"];
    expect(w.workspace).toBe("/ws/p6-01-updated");
    expect(w.ledgerId).toBe("ledger-123");
    expect(w.currentTask).toBe("fix type errors");
    expect(w.ticket).toEqual({ id: "T-1", title: "Typecheck", status: "in_progress" });
  });

  it("rejects updates on terminated workers", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws",
        branch: "main",
        imChannel: "ch1",
        allowedActions: [],
      },
      {
        kind: "worker_terminated",
        eventId: "e2",
        workerId: "coder-1",
      },
    ]);

    const r = applyContactRegistryEvent(base, {
      kind: "worker_updated",
      eventId: "e3",
      workerId: "coder-1",
      patch: { currentTask: "nope" },
    });
    expect(r.status).toBe("rejected");
    expect(r.rejection.code).toBe("worker_already_terminated");
  });

  it("transitions status through valid paths", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws",
        branch: "main",
        imChannel: "ch1",
        allowedActions: [],
      },
    ]);

    // idle -> active
    const r1 = applyContactRegistryEvent(base, {
      kind: "worker_status_changed",
      eventId: "e2",
      workerId: "coder-1",
      status: "active",
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.workers["coder-1"].status).toBe("active");

    // active -> idle
    const r2 = applyContactRegistryEvent(r1.state, {
      kind: "worker_status_changed",
      eventId: "e3",
      workerId: "coder-1",
      status: "idle",
    });
    expect(r2.status).toBe("applied");

    // idle -> stale
    const r3 = applyContactRegistryEvent(r2.state, {
      kind: "worker_status_changed",
      eventId: "e4",
      workerId: "coder-1",
      status: "stale",
    });
    expect(r3.status).toBe("applied");

    // stale -> offline
    const r4 = applyContactRegistryEvent(r3.state, {
      kind: "worker_status_changed",
      eventId: "e5",
      workerId: "coder-1",
      status: "offline",
    });
    expect(r4.status).toBe("applied");
  });

  it("rejects invalid status transitions", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws",
        branch: "main",
        imChannel: "ch1",
        allowedActions: [],
      },
    ]);

    // Cannot go from idle to terminated directly? Actually idle -> terminated IS valid
    // Let's test idle -> invalid status (if we had one)

    // active -> terminated is valid
    const r1 = applyContactRegistryEvent(base, {
      kind: "worker_status_changed",
      eventId: "e2",
      workerId: "coder-1",
      status: "active",
    });
    expect(r1.status).toBe("applied");

    // Then terminate
    const r2 = applyContactRegistryEvent(r1.state, {
      kind: "worker_status_changed",
      eventId: "e3",
      workerId: "coder-1",
      status: "terminated",
    });
    expect(r2.status).toBe("applied");

    // From terminated, no transitions allowed
    const r3 = applyContactRegistryEvent(r2.state, {
      kind: "worker_status_changed",
      eventId: "e4",
      workerId: "coder-1",
      status: "active",
    });
    expect(r3.status).toBe("rejected");
    expect(r3.rejection.code).toBe("invalid_transition");
  });

  it("handles idempotent duplicate event ids", () => {
    const r1 = applyContactRegistryEvent(createContactRegistryState("team-p6"), {
      kind: "worker_registered",
      eventId: "e1",
      workerId: "coder-1",
      role: "coder",
      workspace: "/ws",
      branch: "main",
      imChannel: "ch1",
      allowedActions: [],
    });
    expect(r1.status).toBe("applied");

    const dup = applyContactRegistryEvent(r1.state, {
      kind: "worker_registered",
      eventId: "e1",
      workerId: "coder-2",
      role: "reviewer",
      workspace: "/ws2",
      branch: "main",
      imChannel: "ch2",
      allowedActions: [],
    });
    expect(dup.status).toBe("duplicate");
    expect(dup.state).toBe(r1.state);
  });

  it("records heartbeats and evidence timestamps", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws",
        branch: "main",
        imChannel: "ch1",
        allowedActions: [],
      },
    ]);

    const r1 = applyContactRegistryEvent(base, {
      kind: "worker_heartbeat",
      eventId: "e2",
      workerId: "coder-1",
      timestamp: "2026-06-05T10:00:00Z",
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.workers["coder-1"].lastHeartbeat).toBe("2026-06-05T10:00:00Z");
    expect(r1.state.workers["coder-1"].lastEvidence).toBeUndefined();

    const r2 = applyContactRegistryEvent(r1.state, {
      kind: "worker_heartbeat",
      eventId: "e3",
      workerId: "coder-1",
      timestamp: "2026-06-05T10:05:00Z",
      evidence: "commit abc123",
    });
    expect(r2.status).toBe("applied");
    expect(r2.state.workers["coder-1"].lastHeartbeat).toBe("2026-06-05T10:05:00Z");
    expect(r2.state.workers["coder-1"].lastEvidence).toBe("2026-06-05T10:05:00Z");
  });

  it("terminates workers and rejects double termination", () => {
    const base = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws",
        branch: "main",
        imChannel: "ch1",
        allowedActions: [],
      },
    ]);

    const r1 = applyContactRegistryEvent(base, {
      kind: "worker_terminated",
      eventId: "e2",
      workerId: "coder-1",
      reason: "task done",
    });
    expect(r1.status).toBe("applied");
    expect(r1.state.workers["coder-1"].status).toBe("terminated");

    const r2 = applyContactRegistryEvent(r1.state, {
      kind: "worker_terminated",
      eventId: "e3",
      workerId: "coder-1",
    });
    expect(r2.status).toBe("duplicate");
  });

  it("summarizes registry with counts and filters", () => {
    const state = applyAll(createContactRegistryState("team-p6"), [
      {
        kind: "worker_registered",
        eventId: "e1",
        workerId: "coder-1",
        role: "coder",
        workspace: "/ws/p6-01",
        branch: "codex/p6/01",
        imChannel: "p6-01",
        allowedActions: ["read", "write", "test"],
      },
      {
        kind: "worker_registered",
        eventId: "e2",
        workerId: "reviewer-1",
        role: "reviewer",
        workspace: "/ws/review",
        branch: "main",
        imChannel: "review",
        allowedActions: ["review"],
      },
      {
        kind: "worker_registered",
        eventId: "e3",
        workerId: "coder-2",
        role: "coder",
        workspace: "/ws/p6-02",
        branch: "codex/p6/02",
        imChannel: "p6-02",
        allowedActions: ["read", "write"],
      },
      {
        kind: "worker_status_changed",
        eventId: "e4",
        workerId: "coder-1",
        status: "active",
      },
      {
        kind: "worker_status_changed",
        eventId: "e5",
        workerId: "coder-2",
        status: "offline",
      },
    ]);

    const summary = summarizeContactRegistry(state);
    expect(summary.registryId).toBe("team-p6");
    expect(summary.totalWorkers).toBe(3);
    expect(summary.workersByStatus).toEqual({
      active: 1,
      idle: 1,
      stale: 0,
      offline: 1,
      terminated: 0,
    });
    expect(summary.workersByRole).toEqual({ coder: 2, reviewer: 1 });
    expect(summary.activeWorkers).toHaveLength(2);

    const coders = listWorkersByRole(state, "coder");
    expect(coders).toHaveLength(2);
    expect(coders.map((w) => w.workerId)).toEqual(["coder-1", "coder-2"]);

    const idleWorkers = listWorkersByStatus(state, "idle");
    expect(idleWorkers).toHaveLength(1);
    expect(idleWorkers[0].workerId).toBe("reviewer-1");

    const found = lookupWorker(state, "coder-1");
    expect(found).toBeDefined();
    expect(found!.role).toBe("coder");
    expect(found!.status).toBe("active");

    const missing = lookupWorker(state, "no-one");
    expect(missing).toBeUndefined();
  });

  it("exports summary helpers from subagent and root barrels", () => {
    expect(summarizeFromBarrel).toBe(summarizeContactRegistry);
    expect(summarizeFromRoot).toBe(summarizeContactRegistry);
  });
});
