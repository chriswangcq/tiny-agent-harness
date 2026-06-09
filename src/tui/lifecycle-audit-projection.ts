// Run-scoped lifecycle audit projection for TUI/team dashboard display.
//
// Pure projection maps durable supervisor lifecycle events to
// SupervisorLifecycleInput.auditEvents. The reader below is an adapter boundary:
// it tails runs/<runId>/supervisor/lifecycle-events.jsonl by byte
// offset and never performs reaper/shutdown decisions or process effects.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SupervisorLifecycleEvent,
  SupervisorLifecycleEventType,
} from "../subagent/supervisor-store.js";
import { validateLifecycleEvent } from "../subagent/supervisor-store.js";
import type { LifecycleAuditEventItem } from "./team-dashboard-view-model.js";

const DEFAULT_MAX_EVENTS = 200;

export type LifecycleAuditProjectionState = {
  byteOffset: number;
  auditEvents: LifecycleAuditEventItem[];
};

export type LifecycleAuditProjectionResult = {
  newAuditEvents: LifecycleAuditEventItem[];
  parseErrors: string[];
  state: LifecycleAuditProjectionState;
};

export type ReadRunLifecycleAuditProjectionInput = {
  runDir: string;
  previousState?: LifecycleAuditProjectionState;
  maxEvents?: number;
};

export type RunLifecycleAuditReaderOptions = {
  runDir: string;
  maxEvents?: number;
};

export function projectLifecycleAuditEvents(
  events: readonly SupervisorLifecycleEvent[],
): LifecycleAuditEventItem[] {
  return events.map(projectLifecycleAuditEvent);
}

export function readRunLifecycleAuditProjection(
  input: ReadRunLifecycleAuditProjectionInput,
): LifecycleAuditProjectionResult {
  const previousState = input.previousState ?? {
    byteOffset: 0,
    auditEvents: [],
  };
  const filePath = path.join(input.runDir, "supervisor", "lifecycle-events.jsonl");
  const readResult = readLifecycleJsonlSince(filePath, previousState.byteOffset);
  const validEvents: SupervisorLifecycleEvent[] = [];
  const parseErrors = [...readResult.errors];

  for (const record of readResult.records) {
    const validation = validateLifecycleEvent(record);
    if (validation.valid) {
      validEvents.push(record as SupervisorLifecycleEvent);
    } else {
      parseErrors.push(
        `Invalid lifecycle event: ${validation.errors.join("; ")}`,
      );
    }
  }

  const newAuditEvents = projectLifecycleAuditEvents(validEvents);
  const auditEvents = capAuditEvents(
    [...previousState.auditEvents, ...newAuditEvents],
    input.maxEvents ?? DEFAULT_MAX_EVENTS,
  );

  return {
    newAuditEvents,
    parseErrors,
    state: {
      byteOffset: readResult.newOffset,
      auditEvents,
    },
  };
}

export class RunLifecycleAuditReader {
  private state: LifecycleAuditProjectionState = {
    byteOffset: 0,
    auditEvents: [],
  };

  private readonly runDir: string;
  private readonly maxEvents: number;

  constructor(options: RunLifecycleAuditReaderOptions) {
    this.runDir = options.runDir;
    this.maxEvents = positiveInteger(options.maxEvents) ?? DEFAULT_MAX_EVENTS;
  }

  read(): LifecycleAuditProjectionResult {
    const result = readRunLifecycleAuditProjection({
      runDir: this.runDir,
      previousState: this.state,
      maxEvents: this.maxEvents,
    });
    this.state = result.state;
    return result;
  }

  reset(): void {
    this.state = { byteOffset: 0, auditEvents: [] };
  }
}

function projectLifecycleAuditEvent(
  event: SupervisorLifecycleEvent,
): LifecycleAuditEventItem {
  const payload = event.payload;
  return {
    eventId: event.eventId,
    timestamp: event.timestamp,
    kind: event.type,
    ...(stringPayload(payload, "workerId") ??
    stringPayload(payload, "candidateWorkerId")
      ? {
          workerId:
            stringPayload(payload, "workerId") ??
            stringPayload(payload, "candidateWorkerId"),
        }
      : {}),
    ...(stringPayload(payload, "runId")
      ? { runId: stringPayload(payload, "runId") }
      : {}),
    ...(stringPayload(payload, "leaseId")
      ? { leaseId: stringPayload(payload, "leaseId") }
      : {}),
    ...(stringPayload(payload, "resource")
      ? { resource: stringPayload(payload, "resource") }
      : {}),
    ...(eventAction(event)
      ? { action: eventAction(event) }
      : {}),
    ...(stringPayload(payload, "reason")
      ? { reason: stringPayload(payload, "reason") }
      : {}),
    summary: eventSummary(event),
  };
}

function eventAction(event: SupervisorLifecycleEvent): string | undefined {
  return (
    stringPayload(event.payload, "action") ??
    stringPayload(event.payload, "plannedAction")
  );
}

function eventSummary(event: SupervisorLifecycleEvent): string {
  const payload = event.payload;
  switch (event.type) {
    case "worker_heartbeat":
    case "heartbeat_recorded":
      return "heartbeat recorded";
    case "lease_requested":
      return "lease requested";
    case "lease_acquired": {
      const expiresAt = stringPayload(payload, "expiresAt");
      return expiresAt ? `lease acquired until ${expiresAt}` : "lease acquired";
    }
    case "lease_renewed": {
      const expiresAt =
        stringPayload(payload, "newExpiresAt") ??
        stringPayload(payload, "expiresAt");
      return expiresAt ? `lease renewed until ${expiresAt}` : "lease renewed";
    }
    case "lease_released":
      return "lease released";
    case "lease_expired":
      return "lease expired";
    case "reaper_planned": {
      const action = stringPayload(payload, "plannedAction");
      return action ? `reaper planned ${action}` : "reaper planned";
    }
    case "reaper_executed": {
      const action = stringPayload(payload, "action");
      return action ? `reaper executed ${action}` : "reaper executed";
    }
    case "reaper_skipped":
      return "reaper skipped";
    case "shutdown_requested": {
      const requestedBy = stringPayload(payload, "requestedBy");
      return requestedBy
        ? `shutdown requested by ${requestedBy}`
        : "shutdown requested";
    }
    case "shutdown_draining":
      return "shutdown draining";
    case "shutdown_completed":
      return "shutdown completed";
    case "shutdown_failed":
      return "shutdown failed";
    default:
      return event.type satisfies SupervisorLifecycleEventType;
  }
}

function readLifecycleJsonlSince(
  filePath: string,
  byteOffset: number,
): { records: unknown[]; errors: string[]; newOffset: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { records: [], errors: [], newOffset: byteOffset };
  }
  if (!stat.isFile()) {
    return { records: [], errors: [], newOffset: byteOffset };
  }
  if (stat.size <= byteOffset) {
    return { records: [], errors: [], newOffset: byteOffset };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const readFrom = Math.max(0, Math.min(byteOffset, stat.size));
    const buffer = Buffer.alloc(stat.size - readFrom);
    fs.readSync(fd, buffer, 0, buffer.length, readFrom);
    const raw = buffer.toString("utf-8");
    const records: unknown[] = [];
    const errors: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        errors.push(`Failed to parse JSONL line: ${trimmed.slice(0, 100)}`);
      }
    }
    return { records, errors, newOffset: stat.size };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close for display-only lifecycle tailing
      }
    }
  }
}

function capAuditEvents(
  events: LifecycleAuditEventItem[],
  maxEvents: number,
): LifecycleAuditEventItem[] {
  const limit = positiveInteger(maxEvents) ?? DEFAULT_MAX_EVENTS;
  return [...events]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limit);
}

function stringPayload(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}
