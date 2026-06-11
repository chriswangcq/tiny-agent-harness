import type {
  RuntimeProcessExit,
  RuntimeProcessKind,
  RuntimeProcessRecord,
} from "./process-registry.js";

export type RuntimeCapability =
  | "run"
  | "terminal-host"
  | "pty-session"
  | "mcp"
  | "worker"
  | "codeq"
  | "model-gateway";

export type RuntimeEventBase = {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  producer: string;
  runId?: string;
  correlationId?: string;
  causationId?: string;
};

export type RuntimeProcessEvent =
  | (RuntimeEventBase & {
      type: "process_planned";
      process: RuntimeProcessRecord;
    })
  | (RuntimeEventBase & {
      type: "process_started";
      process: RuntimeProcessRecord;
    })
  | (RuntimeEventBase & {
      type: "process_heartbeat";
      processId: string;
      pid?: number;
      kind: RuntimeProcessKind;
      heartbeatAt: string;
    })
  | (RuntimeEventBase & {
      type: "process_exited";
      processId: string;
      kind: RuntimeProcessKind;
      exit: RuntimeProcessExit;
    })
  | (RuntimeEventBase & {
      type: "process_crashed";
      processId: string;
      kind: RuntimeProcessKind;
      exit: RuntimeProcessExit;
    });

export type RuntimeCapabilityEvent = RuntimeEventBase & {
  type: "capability_lifecycle";
  capability: RuntimeCapability;
  processId?: string;
  status: "planned" | "ready" | "degraded" | "stopped";
  message?: string;
};

export type RuntimeEvent = RuntimeProcessEvent | RuntimeCapabilityEvent;

export type RuntimeEventInput = {
  id: string;
  timestamp: string;
  producer: string;
  runId?: string;
  correlationId?: string;
  causationId?: string;
};

export function processPlannedEvent(
  base: RuntimeEventInput,
  process: RuntimeProcessRecord,
): RuntimeEvent {
  return { ...eventBase(base), type: "process_planned", process };
}

export function processStartedEvent(
  base: RuntimeEventInput,
  process: RuntimeProcessRecord,
): RuntimeEvent {
  return { ...eventBase(base), type: "process_started", process };
}

export function processHeartbeatEvent(
  base: RuntimeEventInput,
  process: RuntimeProcessRecord,
): RuntimeEvent {
  return {
    ...eventBase(base),
    type: "process_heartbeat",
    processId: process.id,
    pid: process.pid,
    kind: process.kind,
    heartbeatAt: process.lastHeartbeatAt ?? base.timestamp,
  };
}

export function processExitedOrCrashedEvent(
  base: RuntimeEventInput,
  process: RuntimeProcessRecord,
): RuntimeEvent {
  if (!process.exit) {
    throw new Error(`Process ${process.id} has no exit payload`);
  }
  if (process.status !== "exited" && process.status !== "crashed") {
    throw new Error(`Process ${process.id} is ${process.status}, not terminal`);
  }
  return {
    ...eventBase(base),
    type: process.status === "exited" ? "process_exited" : "process_crashed",
    processId: process.id,
    kind: process.kind,
    exit: process.exit,
  };
}

export function capabilityLifecycleEvent(
  base: RuntimeEventInput,
  input: {
    capability: RuntimeCapability;
    status: RuntimeCapabilityEvent["status"];
    processId?: string;
    message?: string;
  },
): RuntimeEvent {
  return {
    ...eventBase(base),
    type: "capability_lifecycle",
    capability: input.capability,
    status: input.status,
    processId: input.processId,
    message: input.message,
  };
}

function eventBase(input: RuntimeEventInput): RuntimeEventBase {
  return {
    schemaVersion: 1,
    id: input.id,
    timestamp: input.timestamp,
    producer: input.producer,
    runId: input.runId,
    correlationId: input.correlationId,
    causationId: input.causationId,
  };
}
