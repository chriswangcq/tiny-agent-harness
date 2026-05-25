import type {
  BashObservation,
  BashSessionSummary,
  BashControlInput,
  SessionCreateOptions,
} from "../types/index.js";
import { BashSession } from "./session.js";

// ---------------------------------------------------------------------------
// BashSessionManager
// ---------------------------------------------------------------------------

export class BashSessionManager {
  private sessions = new Map<string, BashSession>();
  private readonly logDir: string;
  private readonly defaultCwd: string;

  constructor(options?: { logDir?: string; defaultCwd?: string }) {
    this.logDir =
      options?.logDir ??
      `${process.cwd()}/.tiny-agent/sessions`;
    this.defaultCwd = options?.defaultCwd ?? process.cwd();
  }

  // -----------------------------------------------------------------------
  // Session creation
  // -----------------------------------------------------------------------

  createSession(
    id: string,
    options?: SessionCreateOptions,
  ): BashObservation {
    if (this.sessions.has(id)) {
      return {
        session: id,
        state: "idle",
        returnCode: null,
        output: "",
        outputTruncated: false,
        control: "create",
        message: `Session "${id}" already exists.`,
      };
    }

    const session = new BashSession({
      id,
      shell: options?.shell,
      cwd: options?.cwd,
      env: options?.env,
      defaultTimeoutMs: options?.defaultTimeoutMs,
      maxObservationBytes: options?.maxObservationBytes,
      logDir: this.logDir,
    });

    session.spawn();
    this.sessions.set(id, session);

    return {
      session: id,
      state: session.state,
      returnCode: null,
      output: "",
      outputTruncated: false,
      outputLogPath: session.logPath,
      control: "create",
      message: `Session "${id}" created.`,
    };
  }

  // -----------------------------------------------------------------------
  // Command execution
  // -----------------------------------------------------------------------

  async executeCommand(
    sessionId: string,
    command: string,
    timeoutMs?: number,
  ): Promise<BashObservation> {
    const session = this.getSessionOrThrow(sessionId);

    // Auto-create the session if it doesn't exist is not done here;
    // the orchestrator should create it via the "create" control first
    // or we auto-create here for the "default" session.

    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await session.executeCommand(
      commandId,
      command,
      timeoutMs,
    );

    return {
      session: sessionId,
      state: session.state,
      returnCode: result.returnCode,
      timedOut: result.timedOut || undefined,
      focusReleased: result.timedOut || undefined,
      output: result.output,
      outputTruncated: result.outputTruncated,
      outputLogPath: session.logPath,
      outputStartOffset: result.startOffset,
      outputEndOffset: result.endOffset,
    };
  }

  // -----------------------------------------------------------------------
  // Auto-create + execute (convenience for the orchestrator)
  // -----------------------------------------------------------------------

  async executeCommandAutoCreate(
    sessionId: string,
    command: string,
    timeoutMs?: number,
  ): Promise<BashObservation> {
    if (!this.sessions.has(sessionId)) {
      this.createSession(sessionId, { cwd: this.defaultCwd });
    }
    return this.executeCommand(sessionId, command, timeoutMs);
  }

  // -----------------------------------------------------------------------
  // Control handling
  // -----------------------------------------------------------------------

  async handleControl(input: BashControlInput): Promise<BashObservation> {
    switch (input.control) {
      case "list":
        return this.handleList();
      case "create":
        return this.createSession(input.session, {
          cwd: input.cwd,
          shell: input.shell,
          env: input.env,
          defaultTimeoutMs: input.defaultTimeoutMs,
          maxObservationBytes: input.maxObservationBytes,
        });
      case "status":
        return this.handleStatus(input.session);
      case "poll":
        return this.handlePoll(input.session);
      case "sendInput":
        return this.handleSendInput(input.session, input.input);
      case "interrupt":
        return this.handleInterrupt(input.session);
      case "terminate":
        return this.handleTerminate(input.session);
      case "restart":
        return this.handleRestart(input.session);
      default: {
        const _exhaustive: never = input;
        throw new Error(`Unknown control: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Individual control handlers
  // -----------------------------------------------------------------------

  private handleList(): BashObservation {
    const summaries: BashSessionSummary[] = [];

    for (const [, session] of this.sessions) {
      summaries.push({
        id: session.id,
        state: session.state,
        cwd: session.cwd,
        currentCommand: session.currentCommand?.command,
        outputLogPath: session.logPath,
        updatedAt: session.updatedAt,
      });
    }

    return {
      session: null,
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "list",
      sessions: summaries,
      message: `${summaries.length} session(s).`,
    };
  }

  private handleStatus(sessionId: string): BashObservation {
    const session = this.getSessionOrThrow(sessionId);

    const summaries: BashSessionSummary[] = [
      {
        id: session.id,
        state: session.state,
        cwd: session.cwd,
        currentCommand: session.currentCommand?.command,
        outputLogPath: session.logPath,
        updatedAt: session.updatedAt,
      },
    ];

    return {
      session: sessionId,
      state: session.state,
      returnCode: session.currentCommand?.returnCode ?? null,
      output: "",
      outputTruncated: false,
      control: "status",
      sessions: summaries,
      message: `Session "${sessionId}" is ${session.state}.`,
    };
  }

  private handlePoll(sessionId: string): BashObservation {
    const session = this.getSessionOrThrow(sessionId);
    const pollResult = session.poll();

    return {
      session: sessionId,
      state: session.state,
      returnCode: session.currentCommand?.returnCode ?? null,
      output: pollResult.output,
      outputTruncated: pollResult.outputTruncated,
      outputLogPath: session.logPath,
      outputStartOffset: pollResult.startOffset,
      outputEndOffset: pollResult.endOffset,
      control: "poll",
    };
  }

  private handleSendInput(sessionId: string, input: string): BashObservation {
    const session = this.getSessionOrThrow(sessionId);

    try {
      session.writeInput(input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        session: sessionId,
        state: session.state,
        returnCode: null,
        output: "",
        outputTruncated: false,
        control: "sendInput",
        message: `Failed to send input: ${msg}`,
      };
    }

    return {
      session: sessionId,
      state: session.state,
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "sendInput",
      message: `Input sent to session "${sessionId}".`,
    };
  }

  private handleInterrupt(sessionId: string): BashObservation {
    const session = this.getSessionOrThrow(sessionId);
    session.interrupt();

    return {
      session: sessionId,
      state: session.state,
      returnCode: session.currentCommand?.returnCode ?? null,
      output: "",
      outputTruncated: false,
      control: "interrupt",
      message: `Interrupt (SIGINT) sent to session "${sessionId}".`,
    };
  }

  private handleTerminate(sessionId: string): BashObservation {
    const session = this.getSessionOrThrow(sessionId);
    session.kill();

    return {
      session: sessionId,
      state: "terminated",
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "terminate",
      message: `Session "${sessionId}" terminated.`,
    };
  }

  private handleRestart(sessionId: string): BashObservation {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      // Remember options for recreation
      const cwd = existing.cwd;
      const shell = existing.shell;
      const env = existing.env;
      const defaultTimeoutMs = existing.defaultTimeoutMs;
      const maxObservationBytes = existing.maxObservationBytes;

      // Kill the old session
      existing.kill();
      this.sessions.delete(sessionId);

      // Create a new one with the same options
      return this.createSession(sessionId, {
        cwd,
        shell,
        env,
        defaultTimeoutMs,
        maxObservationBytes,
      });
    }

    // Session doesn't exist, just create a fresh one
    return this.createSession(sessionId);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Terminate all sessions. Call this when the agent run finishes.
   */
  terminateAll(): void {
    for (const [, session] of this.sessions) {
      try {
        session.kill();
      } catch {
        // Best effort
      }
    }
    this.sessions.clear();
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getSessionOrThrow(sessionId: string): BashSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" does not exist. Use the "create" control or send a command to auto-create it.`);
    }
    return session;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSession(sessionId: string): BashSession | undefined {
    return this.sessions.get(sessionId);
  }
}
