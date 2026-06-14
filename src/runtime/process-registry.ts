export type RuntimeProcessKind =
  | "run"
  | "terminal-host"
  | "pty-session"
  | "codeq-host"
  | "skill-host"
  | "mcp-host"
  | "model-gateway";

export type RuntimeProcessStatus =
  | "planned"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "crashed";

export type RuntimeProcessOwner =
  | {
      scope: "project";
      projectId: string;
    }
  | {
      scope: "run";
      runId: string;
    }
  | {
      scope: "team";
      teamId: string;
    }
  | {
      scope: "team-member";
      teamId: string;
      memberId: string;
      runId: string;
    }
  | {
      scope: "session";
      runId: string;
      sessionId: string;
    };

export type RuntimeProcessCommand = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  envKeys?: readonly string[];
};

export type RuntimeProcessExit = {
  exitedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
};

export type RuntimeProcessRecord = {
  schemaVersion: 1;
  id: string;
  kind: RuntimeProcessKind;
  owner: RuntimeProcessOwner;
  status: RuntimeProcessStatus;
  command: RuntimeProcessCommand;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  parentProcessId?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  statePath?: string;
  logPath?: string;
  exit?: RuntimeProcessExit;
  metadata?: Record<string, string | number | boolean | null>;
};

export type RuntimeProcessSnapshot = {
  schemaVersion: 1;
  version: number;
  updatedAt: string;
  processes: RuntimeProcessRecord[];
};

export type ProcessFreshness =
  | { status: "not-running"; reason: RuntimeProcessStatus }
  | { status: "unknown"; reason: "missing-heartbeat" | "invalid-heartbeat" }
  | { status: "fresh"; ageMs: number }
  | { status: "stale"; ageMs: number };

export type CreateRuntimeProcessInput = {
  id: string;
  kind: RuntimeProcessKind;
  owner: RuntimeProcessOwner;
  command: RuntimeProcessCommand;
  now: string;
  parentProcessId?: string;
  statePath?: string;
  logPath?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

const TERMINAL_STATUSES: ReadonlySet<RuntimeProcessStatus> = new Set([
  "exited",
  "crashed",
]);

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid process record: ${field} must be non-empty`);
  }
}

function assertCanTransition(
  process: RuntimeProcessRecord,
  nextStatus: RuntimeProcessStatus,
): void {
  if (TERMINAL_STATUSES.has(process.status)) {
    throw new Error(
      `Invalid process transition: ${process.id} is already ${process.status}`,
    );
  }
  if (process.status === "planned" && nextStatus === "stopping") {
    throw new Error(
      `Invalid process transition: ${process.id} cannot stop before it starts`,
    );
  }
}

function withUpdated(
  process: RuntimeProcessRecord,
  patch: Partial<RuntimeProcessRecord>,
): RuntimeProcessRecord {
  return {
    ...process,
    ...patch,
    command: patch.command ?? process.command,
    owner: patch.owner ?? process.owner,
  };
}

export function createRuntimeProcess(
  input: CreateRuntimeProcessInput,
): RuntimeProcessRecord {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.command.executable, "command.executable");

  return {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    owner: input.owner,
    status: "planned",
    command: {
      executable: input.command.executable,
      args: [...input.command.args],
      cwd: input.command.cwd,
      envKeys: input.command.envKeys ? [...input.command.envKeys] : undefined,
    },
    createdAt: input.now,
    updatedAt: input.now,
    parentProcessId: input.parentProcessId,
    statePath: input.statePath,
    logPath: input.logPath,
    metadata: input.metadata ? { ...input.metadata } : undefined,
  };
}

export function markProcessStarting(
  process: RuntimeProcessRecord,
  input: { now: string; pid?: number },
): RuntimeProcessRecord {
  assertCanTransition(process, "starting");
  if (process.status !== "planned") {
    throw new Error(
      `Invalid process transition: ${process.id} ${process.status} -> starting`,
    );
  }
  return withUpdated(process, {
    status: "starting",
    updatedAt: input.now,
    pid: input.pid,
  });
}

export function markProcessRunning(
  process: RuntimeProcessRecord,
  input: { now: string; pid: number },
): RuntimeProcessRecord {
  assertCanTransition(process, "running");
  if (process.status !== "planned" && process.status !== "starting") {
    throw new Error(
      `Invalid process transition: ${process.id} ${process.status} -> running`,
    );
  }
  return withUpdated(process, {
    status: "running",
    updatedAt: input.now,
    startedAt: process.startedAt ?? input.now,
    lastHeartbeatAt: input.now,
    pid: input.pid,
    exit: undefined,
  });
}

export function recordProcessHeartbeat(
  process: RuntimeProcessRecord,
  input: { now: string },
): RuntimeProcessRecord {
  if (process.status !== "running" && process.status !== "stopping") {
    throw new Error(
      `Invalid process heartbeat: ${process.id} is ${process.status}`,
    );
  }
  return withUpdated(process, {
    updatedAt: input.now,
    lastHeartbeatAt: input.now,
  });
}

export function markProcessStopping(
  process: RuntimeProcessRecord,
  input: { now: string },
): RuntimeProcessRecord {
  assertCanTransition(process, "stopping");
  if (process.status !== "starting" && process.status !== "running") {
    throw new Error(
      `Invalid process transition: ${process.id} ${process.status} -> stopping`,
    );
  }
  return withUpdated(process, {
    status: "stopping",
    updatedAt: input.now,
  });
}

export function markProcessExited(
  process: RuntimeProcessRecord,
  input: { now: string; exitCode?: number | null; signal?: string | null },
): RuntimeProcessRecord {
  assertCanTransition(process, "exited");
  return withUpdated(process, {
    status: "exited",
    updatedAt: input.now,
    exit: {
      exitedAt: input.now,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
    },
  });
}

export function markProcessCrashed(
  process: RuntimeProcessRecord,
  input: {
    now: string;
    exitCode?: number | null;
    signal?: string | null;
    message?: string;
  },
): RuntimeProcessRecord {
  assertCanTransition(process, "crashed");
  return withUpdated(process, {
    status: "crashed",
    updatedAt: input.now,
    exit: {
      exitedAt: input.now,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      message: input.message,
    },
  });
}

export function classifyProcessFreshness(input: {
  process: RuntimeProcessRecord;
  nowEpochMs: number;
  staleAfterMs: number;
}): ProcessFreshness {
  if (input.process.status !== "running" && input.process.status !== "stopping") {
    return { status: "not-running", reason: input.process.status };
  }

  if (!input.process.lastHeartbeatAt) {
    return { status: "unknown", reason: "missing-heartbeat" };
  }

  const heartbeatMs = Date.parse(input.process.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return { status: "unknown", reason: "invalid-heartbeat" };
  }

  const ageMs = Math.max(0, input.nowEpochMs - heartbeatMs);
  if (ageMs > input.staleAfterMs) {
    return { status: "stale", ageMs };
  }
  return { status: "fresh", ageMs };
}

export function createEmptyProcessSnapshot(input: {
  now: string;
}): RuntimeProcessSnapshot {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: input.now,
    processes: [],
  };
}

export function upsertProcessRecord(
  snapshot: RuntimeProcessSnapshot,
  process: RuntimeProcessRecord,
  input: { now: string },
): RuntimeProcessSnapshot {
  const processes = snapshot.processes.filter((item) => item.id !== process.id);
  processes.push(process);
  processes.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    version: snapshot.version + 1,
    updatedAt: input.now,
    processes,
  };
}
