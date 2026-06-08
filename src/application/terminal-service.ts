import {
  createUnsyncedTerminalState,
  markTerminalTerminated,
  parseTerminalChunk,
  transitionTerminalStateMany,
} from "../terminal/index.js";
import type {
  SessionListObservation,
  TerminalEvent,
  TerminalKey,
  TerminalObservation,
  TerminalScreen,
  TerminalState,
  TerminalToolRequest,
} from "../terminal/index.js";
import type {
  PtyReadResult,
  TerminalRuntimeSnapshot,
  TerminalServiceConfig,
  TerminalServicePorts,
} from "./terminal-ports.js";

export type TerminalServiceObservation =
  | TerminalObservation
  | SessionListObservation;

export class TerminalService {
  constructor(
    private readonly ports: TerminalServicePorts,
    private readonly config: TerminalServiceConfig,
  ) {}

  async handleAction(
    request: TerminalToolRequest,
  ): Promise<TerminalServiceObservation> {
    switch (request.kind) {
      case "terminal_write":
      case "terminal_key":
      case "session_interrupt":
        return this.handleCurrentSessionInput(request);
      case "session_observe":
        return this.handleObserve(request.session);
      case "session_list":
        return this.handleList();
      case "session_focus":
        return this.handleFocus(request);
      case "session_restart":
        return this.handleRestart(request);
      case "session_terminate":
        return this.handleTerminate(request);
    }
  }

  private async handleCurrentSessionInput(
    request: Extract<
      TerminalToolRequest,
      { kind: "terminal_write" | "terminal_key" | "session_interrupt" }
    >,
  ): Promise<TerminalObservation> {
    const session = await this.ports.sessions.getCurrent();
    const snapshot = await this.loadSnapshotOrReject(session, request);
    if ("observation" in snapshot) return snapshot.observation;

    if (!snapshot.terminal.alive) {
      const refreshed = await this.refreshScreenBestEffort(session, snapshot);
      return this.rejectedObservation(
        session,
        refreshed.snapshot.terminal,
        request,
        "TERMINAL_TERMINATED",
        `Terminal session "${session}" is terminated. Use session_restart or focus a live session before sending input.`,
        refreshed.screen,
      );
    }

    const seqValidation = await this.validateInputSeq(
      session,
      snapshot,
      request,
      request.expectedInputSeq,
    );
    if (seqValidation) return seqValidation;

    if (request.kind === "session_interrupt") {
      await this.ports.pty.interrupt(session);
    } else {
      await this.ports.pty.write(session, renderTerminalInput(request));
    }

    return this.readParseSaveObserve(session, snapshot, request, {
      inputAccepted: true,
      waitForPromptMs: waitForPromptMsForRequest(request),
    });
  }

  private async handleObserve(sessionOverride?: string): Promise<TerminalObservation> {
    const currentSession = await this.ports.sessions.getCurrent();
    const session = sessionOverride ?? currentSession;
    const snapshot = await this.loadSnapshotOrReject(session, {
      kind: "session_observe",
      ...(sessionOverride ? { session: sessionOverride } : {}),
    });
    if ("observation" in snapshot) return snapshot.observation;

    return this.readParseSaveObserve(
      session,
      snapshot,
      { kind: "session_observe", ...(sessionOverride ? { session: sessionOverride } : {}) },
      { inputAccepted: false },
      currentSession,
    );
  }

  private async handleList(): Promise<SessionListObservation> {
    return {
      currentSession: await this.ports.sessions.getCurrent(),
      sessions: (await this.ports.sessions.list()).map((snapshot) => ({
        session: snapshot.session,
        terminal: snapshot.terminal,
        parserCursor: snapshot.parserState.totalBytes.toString(),
        outputLog: snapshot.outputLog,
      })),
    };
  }

  private async handleFocus(
    request: Extract<TerminalToolRequest, { kind: "session_focus" }>,
  ): Promise<TerminalObservation> {
    let snapshot = await this.ports.sessions.load(request.session);
    if (snapshot === null) {
      if (!request.create) {
        return this.rejectedObservation(
          request.session,
          createUnsyncedTerminalState("state_gap"),
          request,
          "TERMINAL_UNSYNCED",
          `No terminal snapshot found for session "${request.session}".`,
        );
      }
      snapshot = await this.ports.pty.restart(request.session, {
        cwd: request.cwd,
      });
      await this.ports.sessions.save(snapshot);
    }

    await this.ports.sessions.setCurrent(request.session);
    return this.readParseSaveObserve(request.session, snapshot, request, {
      inputAccepted: false,
    });
  }

  private async handleRestart(
    request: Extract<TerminalToolRequest, { kind: "session_restart" }>,
  ): Promise<TerminalObservation> {
    const session = request.session ?? (await this.ports.sessions.getCurrent());
    const restarted = await this.ports.pty.restart(session, { cwd: request.cwd });
    await this.ports.sessions.save(restarted);
    return this.readParseSaveObserve(session, restarted, request, {
      inputAccepted: false,
    });
  }

  private async handleTerminate(
    request: Extract<TerminalToolRequest, { kind: "session_terminate" }>,
  ): Promise<TerminalObservation> {
    const session = request.session ?? (await this.ports.sessions.getCurrent());
    const snapshot = await this.loadSnapshotOrReject(session, request);
    if ("observation" in snapshot) return snapshot.observation;

    await this.ports.pty.terminate(session);
    const terminal = markTerminalTerminated(snapshot.terminal, {
      exitCode: null,
      reason: request.reason ?? "terminated_by_action",
    });
    const nextSnapshot: TerminalRuntimeSnapshot = {
      ...snapshot,
      terminal,
    };
    await this.ports.sessions.save(nextSnapshot);
    return this.okObservation(
      session,
      session,
      terminal,
      request,
      "ok",
      emptyScreen(session, nextSnapshot.outputLog?.ref),
    );
  }

  private async loadSnapshotOrReject(
    session: string,
    request: TerminalToolRequest,
  ): Promise<
    | TerminalRuntimeSnapshot
    | {
        observation: TerminalObservation;
      }
  > {
    const snapshot = await this.ports.sessions.load(session);
    if (snapshot !== null) return snapshot;
    return {
      observation: this.rejectedObservation(
        session,
        createUnsyncedTerminalState("state_gap"),
        request,
        "TERMINAL_UNSYNCED",
        `No terminal snapshot found for session "${session}".`,
      ),
    };
  }

  private async validateInputSeq(
    session: string,
    snapshot: TerminalRuntimeSnapshot,
    request: TerminalToolRequest,
    expectedInputSeq: number,
  ): Promise<TerminalObservation | undefined> {
    if (snapshot.terminal.inputSeq === expectedInputSeq) {
      return undefined;
    }

    let refreshedSnapshot = snapshot;
    let screen = emptyScreen(session, snapshot.outputLog?.ref);
    if (snapshot.terminal.alive) {
      try {
        const read = await this.ports.pty.read(
          session,
          snapshot.parserState.totalBytes.toString(),
        );
        const applied = this.applyRead(snapshot, read);
        refreshedSnapshot = applied.snapshot;
        screen = read.screen;
        await this.ports.sessions.save(refreshedSnapshot);
      } catch {
        // Keep the stale snapshot if the refresh itself failed.
      }
    }

    return this.rejectedObservation(
      session,
      refreshedSnapshot.terminal,
      request,
      "INPUT_SEQ_MISMATCH",
      `expectedInputSeq ${expectedInputSeq} does not match terminal.inputSeq ${refreshedSnapshot.terminal.inputSeq}.`,
      screen,
    );
  }

  private async refreshScreenBestEffort(
    session: string,
    snapshot: TerminalRuntimeSnapshot,
  ): Promise<{ snapshot: TerminalRuntimeSnapshot; screen: TerminalScreen }> {
    try {
      const read = await this.ports.pty.read(
        session,
        snapshot.parserState.totalBytes.toString(),
      );
      const applied = this.applyRead(snapshot, read, { inputAccepted: false });
      await this.ports.sessions.save(applied.snapshot);
      return { snapshot: applied.snapshot, screen: read.screen };
    } catch {
      return { snapshot, screen: emptyScreen(session, snapshot.outputLog?.ref) };
    }
  }

  private async readParseSaveObserve(
    session: string,
    snapshot: TerminalRuntimeSnapshot,
    request: TerminalToolRequest,
    options: { inputAccepted: boolean; waitForPromptMs?: number },
    currentSession = session,
  ): Promise<TerminalObservation> {
    const read = await this.ports.pty.read(
      session,
      snapshot.parserState.totalBytes.toString(),
      {
        waitForPromptMs: options.waitForPromptMs,
        afterPromptSeq: snapshot.terminal.lastShellPrompt?.promptSeq,
      },
    );
    const applied = this.applyRead(snapshot, read, options);
    const nextSnapshot = applied.snapshot;
    await this.ports.sessions.save(nextSnapshot);
    return this.okObservation(
      session,
      currentSession,
      nextSnapshot.terminal,
      request,
      read.timedOut ? "timeout" : "ok",
      read.screen,
      applied.events,
      read.timedOut
        ? `Timed out waiting ${options.waitForPromptMs ?? 0}ms for shell prompt. The process may still be running; use session_observe to continue watching.`
        : undefined,
    );
  }

  private applyRead(
    snapshot: TerminalRuntimeSnapshot,
    read: PtyReadResult,
    options: { inputAccepted: boolean } = { inputAccepted: read.chunk.length > 0 },
  ): { snapshot: TerminalRuntimeSnapshot; events: TerminalEvent[] } {
    const parsed = parseTerminalChunk({
      chunk: read.chunk,
      state: snapshot.parserState,
      promptNonce: this.config.promptNonce,
    });
    const transition = transitionTerminalStateMany(
      snapshot.terminal,
      parsed.events,
      {
        inputAccepted: options.inputAccepted || read.chunk.length > 0,
      },
    );
    return {
      snapshot: {
        ...snapshot,
        terminal: preserveTerminatedLifecycle(
          snapshot.terminal,
          transition.terminal,
        ),
        parserState: parsed.state,
        outputLog: read.logRef ?? snapshot.outputLog,
      },
      events: [...parsed.events],
    };
  }

  private okObservation(
    session: string,
    currentSession: string,
    terminal: TerminalState,
    request: TerminalToolRequest,
    result: TerminalObservation["result"],
    screen: TerminalScreen,
    events: readonly TerminalEvent[] = [],
    message?: string,
  ): TerminalObservation {
    const observation = buildTerminalObservation({
      currentSession,
      observedSession: session,
      terminal,
      request,
      result,
      screen,
      events,
      message,
    });
    this.ports.logger.event({
      kind: "terminal.action",
      session,
      action: request.kind,
      observation,
    });
    return observation;
  }

  private rejectedObservation(
    session: string,
    terminal: TerminalState,
    request: TerminalToolRequest,
    errorCode: TerminalObservation["errorCode"],
    message: string,
    screen: TerminalScreen = emptyScreen(session),
  ): TerminalObservation {
    const observation = buildTerminalObservation({
      currentSession: session,
      observedSession: session,
      terminal,
      request,
      result: "rejected",
      screen,
      events: [],
      errorCode,
      message,
    });
    this.ports.logger.event({
      kind: "terminal.action.rejected",
      session,
      action: request.kind,
      observation,
      message,
    });
    return observation;
  }
}

function preserveTerminatedLifecycle(
  previous: TerminalState,
  next: TerminalState,
): TerminalState {
  if (previous.alive) {
    return next;
  }

  return {
    ...next,
    alive: false,
    termination: previous.termination,
    foregroundProcess: null,
  };
}

function renderTerminalInput(
  request: Extract<
    TerminalToolRequest,
    { kind: "terminal_write" | "terminal_key" }
  >,
): string {
  if (request.kind === "terminal_write") {
    return request.text;
  }
  return renderKey(request.key);
}

function waitForPromptMsForRequest(
  request: Extract<
    TerminalToolRequest,
    { kind: "terminal_write" | "terminal_key" | "session_interrupt" }
  >,
): number | undefined {
  if (request.waitForReturnMs !== undefined) {
    return request.waitForReturnMs;
  }
  return 0;
}

function renderKey(key: TerminalKey): string {
  switch (key) {
    case "enter":
      return "\n";
    case "ctrl-d":
      return "\u0004";
    case "escape":
      return "\u001b";
    case "tab":
      return "\t";
    case "space":
      return " ";
    case "q":
      return "q";
    case "up":
      return "\u001b[A";
    case "down":
      return "\u001b[B";
    case "left":
      return "\u001b[D";
    case "right":
      return "\u001b[C";
  }
}

function buildTerminalObservation(input: {
  currentSession: string;
  observedSession: string;
  terminal: TerminalState;
  request: TerminalToolRequest;
  result: TerminalObservation["result"];
  screen: TerminalScreen;
  events: readonly TerminalEvent[];
  errorCode?: TerminalObservation["errorCode"];
  message?: string;
}): TerminalObservation {
  return {
    currentSession: input.currentSession,
    observedSession: input.observedSession,
    terminal: input.terminal,
    request: input.request.kind,
    result: input.result,
    returnedToPrompt: input.events.some((event) => event.kind === "prompt"),
    screen: input.screen,
    ...(input.events.length === 0 ? {} : { terminalEvents: [...input.events] }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.message === undefined ? {} : { message: input.message }),
  };
}

function emptyScreen(session: string, logPath?: string): TerminalScreen {
  return {
    text: "",
    rows: 0,
    cols: 0,
    truncated: false,
    logRef: { path: logPath ?? `managed-pty://${session}` },
  };
}
