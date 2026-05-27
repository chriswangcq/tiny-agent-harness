import { TerminalService } from "../application/terminal-service.js";
import { createTerminalRunPort } from "../application/terminal-run-port.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServicePorts,
} from "../application/terminal-ports.js";
import type { TerminalPort } from "../run/orchestrator.js";
import type { PtyActionLimits } from "../terminal/validator.js";
import type { TerminalObservationLimits } from "../terminal/observation.js";
import { ManagedPtySession } from "./managed-session.js";

export type ManagedTerminalRuntimeOptions = {
  defaultSessionId: string;
  cwd: string;
  promptNonce: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  actionLimits: PtyActionLimits;
  observationLimits: TerminalObservationLimits;
  nowIso?: () => string;
  monotonicMs?: () => number;
  newId?: (prefix: string) => string;
  newNonce?: () => string;
};

type RuntimeSession = {
  pty: ManagedPtySession;
  snapshot: TerminalRuntimeSnapshot;
};

export class ManagedTerminalRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(private readonly options: ManagedTerminalRuntimeOptions) {}

  createRunPort(): TerminalPort {
    const service = new TerminalService(this.createPorts(), {
      defaultSessionId: this.options.defaultSessionId,
      promptNonce: this.options.promptNonce,
      actionLimits: this.options.actionLimits,
      observationLimits: this.options.observationLimits,
    });
    return createTerminalRunPort(service);
  }

  private createPorts(): TerminalServicePorts {
    return {
      clock: {
        nowIso: () => this.options.nowIso?.() ?? new Date().toISOString(),
        monotonicMs: () => this.options.monotonicMs?.() ?? Date.now(),
      },
      ids: {
        newId: (prefix) => this.options.newId?.(prefix) ?? `${prefix}-${Date.now()}`,
        newNonce: () => this.options.newNonce?.() ?? this.options.promptNonce,
      },
      pty: {
        write: async (session, data) => {
          this.ensureSession(session).pty.write(data);
        },
        read: async (session, cursor) => {
          const entry = this.ensureSession(session);
          const start = parseCursor(cursor);
          const output = entry.pty.readOutputSince(start);
          return {
            chunk: output.chunk,
            logRef: {
              kind: "log",
              ref: `managed-pty://${session}`,
              startOffset: output.startOffset,
              endOffset: output.endOffset,
            },
          };
        },
        interrupt: async (session) => {
          this.ensureSession(session).pty.interrupt();
        },
        terminate: async (session) => {
          this.ensureSession(session).pty.terminate();
        },
        restart: async (session, options) => {
          const restarted = this.restartSession(session, options?.cwd);
          return cloneSnapshot(restarted.snapshot);
        },
      },
      sessions: {
        load: async (session) => cloneSnapshot(this.ensureSession(session).snapshot),
        save: async (snapshot) => {
          const entry = this.ensureSession(snapshot.session);
          entry.snapshot = cloneSnapshot(snapshot);
        },
      },
      logger: {
        event: () => {},
      },
    };
  }

  private ensureSession(session: string): RuntimeSession {
    const existing = this.sessions.get(session);
    if (existing !== undefined) {
      return existing;
    }

    return this.restartSession(session);
  }

  private restartSession(session: string, cwd?: string): RuntimeSession {
    this.sessions.get(session)?.pty.terminate();

    const pty = new ManagedPtySession({
      id: session,
      promptNonce: this.options.promptNonce,
      cwd: cwd ?? this.options.cwd,
      shell: this.options.shell,
      shellArgs: this.options.shellArgs,
      env: this.options.env,
    });
    pty.spawn();

    const entry: RuntimeSession = {
      pty,
      snapshot: cloneSnapshot(pty.snapshot),
    };
    this.sessions.set(session, entry);
    return entry;
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || !/^\d+$/u.test(cursor)) {
    return 0;
  }
  return Number.parseInt(cursor, 10);
}

function cloneSnapshot(snapshot: TerminalRuntimeSnapshot): TerminalRuntimeSnapshot {
  return {
    ...snapshot,
    owner: structuredClone(snapshot.owner),
    parserState: { ...snapshot.parserState },
    outputLog: snapshot.outputLog === undefined ? undefined : { ...snapshot.outputLog },
  };
}
