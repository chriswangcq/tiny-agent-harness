import { mkdirSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SupervisorLifecycleEvent } from "../src/subagent/supervisor-store.js";
import {
  TeamLifecycleAuditReader,
  projectLifecycleAuditEvents,
  readTeamLifecycleAuditProjection,
} from "../src/tui/lifecycle-audit-projection.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempTeamDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "tah-lifecycle-audit-"));
  tmpDirs.push(root);
  const teamDir = path.join(root, ".tiny-agent", "teams", "team-1");
  mkdirSync(path.join(teamDir, "supervisor"), { recursive: true });
  return teamDir;
}

function appendEvents(
  teamDir: string,
  lines: Array<SupervisorLifecycleEvent | string>,
): void {
  const filePath = path.join(teamDir, "supervisor", "lifecycle-events.jsonl");
  for (const line of lines) {
    appendFileSync(
      filePath,
      typeof line === "string" ? `${line}\n` : `${JSON.stringify(line)}\n`,
      "utf-8",
    );
  }
}

function event(
  eventId: string,
  type: SupervisorLifecycleEvent["type"],
  payload: Record<string, unknown>,
  timestamp = "2026-06-07T00:00:00.000Z",
): SupervisorLifecycleEvent {
  return { eventId, type, timestamp, payload };
}

describe("projectLifecycleAuditEvents", () => {
  it("maps heartbeat lease reaper and shutdown supervisor events to auditEvents", () => {
    const auditEvents = projectLifecycleAuditEvents([
      event("hb-1", "heartbeat_recorded", {
        workerId: "coder-1",
        sequence: 3,
        cadenceMs: 30000,
      }),
      event("lease-1", "lease_renewed", {
        workerId: "coder-1",
        leaseId: "lease-coder-1",
        resource: "worker-lease",
        newExpiresAt: "2026-06-07T00:06:00.000Z",
      }),
      event("reaper-1", "reaper_planned", {
        candidateWorkerId: "coder-1",
        plannedAction: "shutdown",
        reason: "stale_heartbeat",
      }),
      event("shutdown-1", "shutdown_failed", {
        workerId: "coder-1",
        reason: "process already exited",
      }),
    ]);

    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventId: "hb-1",
        kind: "heartbeat_recorded",
        workerId: "coder-1",
        summary: "heartbeat recorded",
      }),
      expect.objectContaining({
        eventId: "lease-1",
        kind: "lease_renewed",
        workerId: "coder-1",
        leaseId: "lease-coder-1",
        resource: "worker-lease",
        summary: "lease renewed until 2026-06-07T00:06:00.000Z",
      }),
      expect.objectContaining({
        eventId: "reaper-1",
        kind: "reaper_planned",
        workerId: "coder-1",
        action: "shutdown",
        reason: "stale_heartbeat",
        summary: "reaper planned shutdown",
      }),
      expect.objectContaining({
        eventId: "shutdown-1",
        kind: "shutdown_failed",
        workerId: "coder-1",
        reason: "process already exited",
        summary: "shutdown failed",
      }),
    ]);
  });

  it("preserves supervisor-level shutdown events without inventing worker ids", () => {
    const [auditEvent] = projectLifecycleAuditEvents([
      event("shutdown-all", "shutdown_requested", {
        phase: "draining",
        requestedBy: "operator",
        reason: "maintenance window",
      }),
    ]);

    expect(auditEvent).toMatchObject({
      eventId: "shutdown-all",
      kind: "shutdown_requested",
      reason: "maintenance window",
      summary: "shutdown requested by operator",
    });
    expect(auditEvent).not.toHaveProperty("workerId");
  });
});

describe("readTeamLifecycleAuditProjection", () => {
  it("reads team-scoped lifecycle-events.jsonl into accumulated auditEvents", () => {
    const teamDir = makeTempTeamDir();
    appendEvents(teamDir, [
      event("hb-1", "heartbeat_recorded", { workerId: "coder-1" }),
      event("lease-1", "lease_acquired", {
        workerId: "coder-1",
        leaseId: "lease-coder-1",
        resource: "worker-lease",
        expiresAt: "2026-06-07T00:06:00.000Z",
      }),
    ]);

    const result = readTeamLifecycleAuditProjection({ teamDir });

    expect(result.state.byteOffset).toBeGreaterThan(0);
    expect(result.state.auditEvents.map((item) => item.eventId)).toEqual([
      "hb-1",
      "lease-1",
    ]);
    expect(result.parseErrors).toEqual([]);
  });

  it("uses byte offset state to read only appended lifecycle events", () => {
    const teamDir = makeTempTeamDir();
    appendEvents(teamDir, [
      event("hb-1", "heartbeat_recorded", { workerId: "coder-1" }),
    ]);
    const first = readTeamLifecycleAuditProjection({ teamDir });

    appendEvents(teamDir, [
      event("shutdown-1", "shutdown_completed", {
        workerId: "coder-1",
        totalWorkersTerminated: 1,
      }),
    ]);
    const second = readTeamLifecycleAuditProjection({
      teamDir,
      previousState: first.state,
    });

    expect(second.newAuditEvents.map((item) => item.eventId)).toEqual([
      "shutdown-1",
    ]);
    expect(second.state.auditEvents.map((item) => item.eventId)).toEqual([
      "hb-1",
      "shutdown-1",
    ]);
  });

  it("reports malformed and invalid JSONL lines without blocking valid events", () => {
    const teamDir = makeTempTeamDir();
    appendEvents(teamDir, [
      "not json",
      { eventId: "bad", type: "not_real" as SupervisorLifecycleEvent["type"], timestamp: "2026-06-07T00:00:00.000Z", payload: {} },
      event("ok", "reaper_skipped", {
        candidateWorkerId: "coder-1",
        reason: "worker recovered",
      }),
    ]);

    const result = readTeamLifecycleAuditProjection({ teamDir });

    expect(result.parseErrors.length).toBe(2);
    expect(result.state.auditEvents).toEqual([
      expect.objectContaining({
        eventId: "ok",
        workerId: "coder-1",
        kind: "reaper_skipped",
      }),
    ]);
  });

  it("caps accumulated auditEvents to maxEvents newest by timestamp", () => {
    const teamDir = makeTempTeamDir();
    appendEvents(teamDir, [
      event("old", "heartbeat_recorded", { workerId: "coder-1" }, "2026-06-07T00:00:00.000Z"),
      event("middle", "heartbeat_recorded", { workerId: "coder-1" }, "2026-06-07T00:01:00.000Z"),
      event("new", "shutdown_completed", { workerId: "coder-1" }, "2026-06-07T00:02:00.000Z"),
    ]);

    const result = readTeamLifecycleAuditProjection({ teamDir, maxEvents: 2 });

    expect(result.state.auditEvents.map((item) => item.eventId)).toEqual([
      "middle",
      "new",
    ]);
  });
});

describe("TeamLifecycleAuditReader", () => {
  it("keeps offset state between reads", () => {
    const teamDir = makeTempTeamDir();
    const reader = new TeamLifecycleAuditReader({ teamDir });
    appendEvents(teamDir, [
      event("hb-1", "heartbeat_recorded", { workerId: "coder-1" }),
    ]);

    const first = reader.read();
    const second = reader.read();

    expect(first.newAuditEvents).toHaveLength(1);
    expect(second.newAuditEvents).toEqual([]);
    expect(second.state.auditEvents).toHaveLength(1);
  });
});
