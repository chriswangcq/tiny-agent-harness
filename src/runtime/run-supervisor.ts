import {
  classifyProcessFreshness,
  createRuntimeProcess,
  markProcessCrashed,
  markProcessExited,
  markProcessRunning,
  markProcessStarting,
  recordProcessHeartbeat,
  type RuntimeProcessKind,
  type RuntimeProcessOwner,
  type RuntimeProcessRecord,
} from "./process-registry.js";
import {
  processExitedOrCrashedEvent,
  processHeartbeatEvent,
  processPlannedEvent,
  processStartedEvent,
  type RuntimeEvent,
  type RuntimeEventInput,
} from "./events.js";
import type { JsonProcessRegistryStore } from "./process-store.js";

export type SpawnedProcessPort = {
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  stdin?: NodeJS.WritableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?: () => void;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export type ProcessStdioMode = "ignore" | "pipe";

export type ProcessSpawnerPort = {
  spawn(
    executable: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: readonly [ProcessStdioMode, ProcessStdioMode, ProcessStdioMode];
      detached?: boolean;
    },
  ): SpawnedProcessPort;
};

export type RunSupervisorDeps = {
  store: Pick<JsonProcessRegistryStore, "find" | "list" | "upsert">;
  spawner: ProcessSpawnerPort;
  nowIso: () => string;
  nowEpochMs: () => number;
  events?: {
    append(event: RuntimeEvent): void;
  };
  newEventId?: () => string;
  eventProducer?: string;
};

export type StartRunProcessInput = {
  processId: string;
  owner: RuntimeProcessOwner;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath?: string;
  statePath?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type StartManagedProcessInput = StartRunProcessInput & {
  kind: RuntimeProcessKind;
  stdio?: readonly [ProcessStdioMode, ProcessStdioMode, ProcessStdioMode];
  detached?: boolean;
};

export type StartedRunProcess = {
  process: RuntimeProcessRecord;
  child: SpawnedProcessPort;
};

export class RunSupervisor {
  constructor(private readonly deps: RunSupervisorDeps) {}

  startRunProcess(input: StartRunProcessInput): StartedRunProcess {
    return this.startProcess({
      ...input,
      kind: "run",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  startProcess(input: StartManagedProcessInput): StartedRunProcess {
    const planned = createRuntimeProcess({
      id: input.processId,
      kind: input.kind,
      owner: input.owner,
      command: {
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        envKeys: Object.keys(input.env).sort(),
      },
      now: this.deps.nowIso(),
      logPath: input.logPath,
      statePath: input.statePath,
      metadata: input.metadata,
    });
    this.deps.store.upsert(planned);
    this.emitProcessEvent(planned, "planned");

    const starting = markProcessStarting(planned, {
      now: this.deps.nowIso(),
    });
    this.deps.store.upsert(starting);

    let child: SpawnedProcessPort;
    try {
      child = this.deps.spawner.spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: input.stdio ?? ["ignore", "pipe", "pipe"],
        detached: input.detached,
      });
    } catch (error) {
      const crashed = markProcessCrashed(starting, {
        now: this.deps.nowIso(),
        message: error instanceof Error ? error.message : String(error),
      });
      this.deps.store.upsert(crashed);
      throw error;
    }

    const running = markProcessRunning(starting, {
      now: this.deps.nowIso(),
      pid: child.pid ?? -1,
    });
    this.deps.store.upsert(running);
    this.emitProcessEvent(running, "started");

    child.once("exit", (code, signal) => {
      const current = this.deps.store.find(input.processId) ?? running;
      if (current.status === "exited" || current.status === "crashed") {
        return;
      }
      const next =
        code === 0 && signal === null
          ? markProcessExited(current, {
              now: this.deps.nowIso(),
              exitCode: code,
              signal,
            })
          : markProcessCrashed(current, {
              now: this.deps.nowIso(),
              exitCode: code,
              signal,
              message: `process exited with code=${code} signal=${signal}`,
            });
      this.deps.store.upsert(next);
      this.emitTerminalProcessEvent(next);
    });

    return { process: running, child };
  }

  attachRunId(input: {
    processId: string;
    runId: string;
    runDir?: string;
  }): RuntimeProcessRecord {
    const process = this.requireProcess(input.processId);
    const next: RuntimeProcessRecord = {
      ...process,
      owner: { scope: "run", runId: input.runId },
      statePath: input.runDir ?? process.statePath,
      updatedAt: this.deps.nowIso(),
      metadata: {
        ...(process.metadata ?? {}),
        runId: input.runId,
      },
    };
    this.deps.store.upsert(next);
    return next;
  }

  heartbeat(processId: string): RuntimeProcessRecord {
    const process = this.requireProcess(processId);
    const next = recordProcessHeartbeat(process, { now: this.deps.nowIso() });
    this.deps.store.upsert(next);
    this.emitProcessEvent(next, "heartbeat");
    return next;
  }

  reapStale(input: {
    staleAfterMs: number;
    message?: string;
  }): RuntimeProcessRecord[] {
    const reaped: RuntimeProcessRecord[] = [];
    for (const process of this.deps.store.list()) {
      const freshness = classifyProcessFreshness({
        process,
        nowEpochMs: this.deps.nowEpochMs(),
        staleAfterMs: input.staleAfterMs,
      });
      if (freshness.status !== "stale") {
        continue;
      }
      const crashed = markProcessCrashed(process, {
        now: this.deps.nowIso(),
        message:
          input.message ??
          `process heartbeat stale for ${freshness.ageMs}ms`,
      });
      this.deps.store.upsert(crashed);
      this.emitTerminalProcessEvent(crashed);
      reaped.push(crashed);
    }
    return reaped;
  }

  list(): RuntimeProcessRecord[] {
    return this.deps.store.list();
  }

  private requireProcess(processId: string): RuntimeProcessRecord {
    const process = this.deps.store.find(processId);
    if (!process) {
      throw new Error(`Unknown process record: ${processId}`);
    }
    return process;
  }

  private emitProcessEvent(
    process: RuntimeProcessRecord,
    phase: "planned" | "started" | "heartbeat",
  ): void {
    const base = this.eventBase(process);
    if (!base) {
      return;
    }
    if (phase === "planned") {
      this.deps.events?.append(processPlannedEvent(base, process));
    } else if (phase === "started") {
      this.deps.events?.append(processStartedEvent(base, process));
    } else {
      this.deps.events?.append(processHeartbeatEvent(base, process));
    }
  }

  private emitTerminalProcessEvent(process: RuntimeProcessRecord): void {
    const base = this.eventBase(process);
    if (!base) {
      return;
    }
    this.deps.events?.append(processExitedOrCrashedEvent(base, process));
  }

  private eventBase(process: RuntimeProcessRecord): RuntimeEventInput | undefined {
    if (!this.deps.events || !this.deps.newEventId) {
      return undefined;
    }
    return {
      id: this.deps.newEventId(),
      timestamp: this.deps.nowIso(),
      producer: this.deps.eventProducer ?? "run-supervisor",
      runId: runIdForOwner(process.owner),
      correlationId: process.id,
    };
  }
}

function runIdForOwner(owner: RuntimeProcessOwner): string | undefined {
  if (
    owner.scope === "run" ||
    owner.scope === "session" ||
    owner.scope === "team-member"
  ) {
    return owner.runId;
  }
  return undefined;
}
