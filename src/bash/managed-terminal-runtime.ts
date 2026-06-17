import { TerminalService } from "../application/terminal-service.js";
import { createTerminalRunPort } from "../application/terminal-run-port.js";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ManagedTerminalMode } from "../application/managed-shell.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServicePorts,
} from "../application/terminal-ports.js";
import type { TerminalPort } from "../run/orchestrator.js";
import { ManagedPtySession, type ForegroundInspector } from "./managed-session.js";
import {
  chunkTextByUtf8Bytes,
  planPtyWrite,
} from "./pty-write-pacing.js";

const DEFAULT_POST_WRITE_READ_DELAY_MS = 100;
const DEFAULT_STARTUP_READ_DELAY_MS = 100;

export type ManagedTerminalRuntimeOptions = {
  defaultSessionId: string;
  cwd: string;
  promptNonce: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  sessionsDir?: string;
  screenRows?: number;
  screenCols?: number;
  postWriteReadDelayMs?: number;
  startupReadDelayMs?: number;
  foregroundInspector?: ForegroundInspector;
  terminalMode?: ManagedTerminalMode;
};

type RuntimeSession = {
  pty: ManagedPtySession;
  snapshot: TerminalRuntimeSnapshot;
  startupDrained: boolean;
};

export class ManagedTerminalRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private currentSession: string;

  constructor(private readonly options: ManagedTerminalRuntimeOptions) {
    this.currentSession = options.defaultSessionId;
  }

  createRunPort(): TerminalPort {
    const service = new TerminalService(this.createPorts(), {
      defaultSessionId: this.options.defaultSessionId,
      promptNonce: this.options.promptNonce,
      screenRows: this.screenRows(),
      screenCols: this.screenCols(),
    });
    return createTerminalRunPort(service);
  }

  private createPorts(): TerminalServicePorts {
    return {
      pty: {
        write: async (session, data) => {
          const entry = this.ensureSession(session);
          await this.drainStartup(entry);
          const pty = entry.pty;
          const pacing = planPtyWrite(data);
          const chunks = chunkTextByUtf8Bytes(data, pacing.chunkBytes);
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index]!;
            pty.write(chunk);
            if (index < chunks.length - 1) {
              await waitBetweenPtyWrites(pacing.interChunkDelayMs);
            }
          }
          await delay(this.options.postWriteReadDelayMs ?? DEFAULT_POST_WRITE_READ_DELAY_MS);
        },
        read: async (session, cursor, options) => {
          const entry = this.ensureSession(session);
          await this.drainStartup(entry);
          const start = parseCursor(cursor);
          const timedOut = await this.waitForPromptIfRequested(entry, options);
          const output = entry.pty.readOutputSince(start);
          const screen = await entry.pty.readScreenWindow({
            startLine: options?.screenStartLine,
            lineCount: options?.screenLineCount,
          });
          const logRef = entry.pty.snapshot.outputLog?.ref ?? `managed-pty://${session}`;
          return {
            chunk: output.chunk,
            logRef: {
              kind: "log",
              ref: logRef,
              startOffset: output.startOffset,
              endOffset: output.endOffset,
            },
            screen: {
              text: screen.text,
              rows: screen.rows,
              cols: screen.cols,
              window: { ...screen.window },
              truncated: screen.hasScrollback,
              logRef: { path: logRef },
            },
            ...(timedOut ? { timedOut } : {}),
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
          await this.drainStartup(restarted);
          return cloneSnapshot(restarted.snapshot);
        },
      },
      sessions: {
        getCurrent: async () => this.currentSession,
        setCurrent: async (session) => {
          this.currentSession = session;
        },
        list: async () => {
          this.ensureSession(this.currentSession);
          const snapshots: TerminalRuntimeSnapshot[] = [];
          for (const entry of this.sessions.values()) {
            await this.drainStartup(entry);
            snapshots.push(cloneSnapshot(entry.snapshot));
          }
          return snapshots;
        },
        load: async (session) => {
          const entry =
            this.sessions.get(session) ??
            (session === this.currentSession ? this.ensureSession(session) : undefined);
          if (entry === undefined) {
            return null;
          }
          await this.drainStartup(entry);
          const snapshot = cloneSnapshot(entry.snapshot);
          if (snapshot.terminal.alive) {
            const fg = entry.pty.detectForegroundProcess();
            snapshot.terminal = { ...snapshot.terminal, foregroundProcess: fg };
          }
          return snapshot;
        },
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
    this.sessions.get(session)?.pty.dispose();

    const pty = new ManagedPtySession({
      id: session,
      promptNonce: this.options.promptNonce,
      cwd: cwd ?? this.options.cwd,
      shell: this.options.shell,
      shellArgs: this.options.shellArgs,
      env: this.options.env,
      cols: this.screenCols(),
      rows: this.screenRows(),
      outputLogPath: this.sessionLogPath(session),
      foregroundInspector: this.options.foregroundInspector,
      terminalMode: this.options.terminalMode,
    });
    pty.spawn();

    const entry: RuntimeSession = {
      pty,
      snapshot: cloneSnapshot(pty.snapshot),
      startupDrained: false,
    };
    this.sessions.set(session, entry);
    return entry;
  }

  private sessionLogPath(session: string): string | undefined {
    if (this.options.sessionsDir === undefined) {
      return undefined;
    }
    return path.join(this.options.sessionsDir, sessionLogFileName(session));
  }

  private async drainStartup(entry: RuntimeSession): Promise<void> {
    if (entry.startupDrained) {
      return;
    }

    await waitUntil(
      () => hasObservedStartupPrompt(entry.pty.snapshot),
      this.options.startupReadDelayMs ?? DEFAULT_STARTUP_READ_DELAY_MS,
    );
    if (hasObservedStartupPrompt(entry.pty.snapshot)) {
      entry.snapshot = cloneSnapshot(entry.pty.snapshot);
    }
    entry.startupDrained = true;
  }

  private screenRows(): number {
    return this.options.screenRows ?? 24;
  }

  private screenCols(): number {
    return this.options.screenCols ?? 80;
  }

  private async waitForPromptIfRequested(
    entry: RuntimeSession,
    options:
      | {
          waitForPromptMs?: number;
          afterPromptSeq?: number;
        }
      | undefined,
  ): Promise<boolean> {
    const timeoutMs = options?.waitForPromptMs ?? 0;
    if (timeoutMs <= 0) {
      return false;
    }
    const afterPromptSeq =
      options?.afterPromptSeq ??
      entry.snapshot.terminal.lastShellPrompt?.promptSeq ??
      -1;
    const returned = await waitUntil(
      () => {
        const terminal = entry.pty.snapshot.terminal;
        const promptSeq = terminal.lastShellPrompt?.promptSeq ?? -1;
        return !terminal.alive || promptSeq > afterPromptSeq;
      },
      timeoutMs,
    );
    return !returned;
  }
}

function waitBetweenPtyWrites(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    return delay(delayMs);
  }
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (condition() || timeoutMs <= 0) {
    return condition();
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(5, deadline - Date.now()));
    if (condition()) {
      return true;
    }
  }
  return condition();
}

function hasObservedStartupPrompt(snapshot: TerminalRuntimeSnapshot): boolean {
  return (
    snapshot.parserState.totalBytes > 0 &&
    snapshot.terminal.lastShellPrompt?.lastReturnCode !== null
  );
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || !/^\d+$/u.test(cursor)) {
    return 0;
  }
  return Number.parseInt(cursor, 10);
}

function sessionLogFileName(session: string): string {
  const slug = session.replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 80) || "session";
  const hash = createHash("sha256").update(session).digest("hex").slice(0, 10);
  return `${slug}-${hash}.log`;
}

function cloneSnapshot(snapshot: TerminalRuntimeSnapshot): TerminalRuntimeSnapshot {
  return {
    ...snapshot,
    terminal: structuredClone(snapshot.terminal),
    parserState: { ...snapshot.parserState },
    outputLog: snapshot.outputLog === undefined ? undefined : { ...snapshot.outputLog },
  };
}
