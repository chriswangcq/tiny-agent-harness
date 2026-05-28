import {
  buildPtyObservation,
  parseTerminalChunk,
  transitionTerminalStateMany,
  validatePtyAction,
  createUnsyncedTerminalState,
  markTerminalTerminated,
} from "../terminal/index.js";
import type {
  PtyAction,
  PtyObservation,
  TerminalEvent,
  TerminalState,
} from "../terminal/index.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServiceConfig,
  TerminalServicePorts,
} from "./terminal-ports.js";

export class TerminalService {
  constructor(
    private readonly ports: TerminalServicePorts,
    private readonly config: TerminalServiceConfig,
  ) {}

  async handleAction(action: PtyAction): Promise<PtyObservation> {
    const session = action.session ?? this.config.defaultSessionId;
    const snapshot = await this.ports.sessions.load(session);
    if (snapshot === null) {
      if (action.kind === "restart") {
        const restarted = await this.ports.pty.restart(session, { cwd: action.cwd });
        await this.ports.sessions.save(restarted);
        return this.okObservation(session, restarted.terminal, action, []);
      }

      return this.rejectedObservation(
        session,
        createUnsyncedTerminalState("state_gap"),
        action,
        "TERMINAL_UNSYNCED",
        `No terminal snapshot found for session \"${session}\".`,
      );
    }

    if (action.kind === "restart") {
      const restarted = await this.ports.pty.restart(session, { cwd: action.cwd });
      await this.ports.sessions.save(restarted);
      return this.okObservation(session, restarted.terminal, action, []);
    }

    const validation = validatePtyAction({
      action,
      terminal: snapshot.terminal,
      limits: this.config.actionLimits,
    });
    if (!validation.ok) {
      return this.rejectedObservation(
        session,
        snapshot.terminal,
        action,
        validation.code,
        validation.message,
      );
    }

    if (action.kind === "terminate") {
      await this.ports.pty.terminate(session);
      const event: TerminalEvent = {
        kind: "terminated",
        exitCode: null,
        reason: "terminated_by_action",
      };
      const nextSnapshot: TerminalRuntimeSnapshot = {
        ...snapshot,
        terminal: markTerminalTerminated(snapshot.terminal, {
          exitCode: null,
          reason: "terminated_by_action",
        }),
      };
      await this.ports.sessions.save(nextSnapshot);
      return this.okObservation(session, nextSnapshot.terminal, action, [event]);
    }

    if (action.kind === "interrupt") {
      await this.ports.pty.interrupt(session);
    }

    const write = renderPtyInput(action);
    if (write !== null) {
      await this.ports.pty.write(session, write);
    }

    const read = await this.ports.pty.read(session, snapshot.parserState.totalBytes.toString());
    const parsed = parseTerminalChunk({
      chunk: read.chunk,
      state: snapshot.parserState,
      promptNonce: this.config.promptNonce,
    });
    const transition = transitionTerminalStateMany(
      snapshot.terminal,
      parsed.events,
      {
        inputAccepted:
          write !== null || action.kind === "interrupt" || read.chunk.length > 0,
      },
    );
    const nextSnapshot: TerminalRuntimeSnapshot = {
      ...snapshot,
      terminal: transition.terminal,
      parserState: parsed.state,
      outputLog: read.logRef ?? snapshot.outputLog,
    };

    await this.ports.sessions.save(nextSnapshot);

    const observation = buildPtyObservation({
      session,
      terminal: transition.terminal,
      action,
      result: "ok",
      events: parsed.events,
      outputTail: read.outputTail ?? (read.chunk.length > 0 ? read.chunk : undefined),
      newOutputBytes: utf8Bytes(read.chunk),
      logRef: read.logRef?.ref,
      limits: this.config.observationLimits,
    });
    this.ports.logger.event({
      kind: "terminal.action",
      session,
      action: action.kind,
      observation,
    });
    return observation;
  }

  private okObservation(
    session: string,
    terminal: TerminalState,
    action: PtyAction,
    events: readonly TerminalEvent[],
  ): PtyObservation {
    const observation = buildPtyObservation({
      session,
      terminal,
      action,
      result: "ok",
      events,
      limits: this.config.observationLimits,
    });
    this.ports.logger.event({
      kind: "terminal.action",
      session,
      action: action.kind,
      observation,
    });
    return observation;
  }

  private rejectedObservation(
    session: string,
    terminal: TerminalState,
    action: PtyAction,
    errorCode: PtyObservation["errorCode"],
    message: string,
  ): PtyObservation {
    const observation = buildPtyObservation({
      session,
      terminal,
      action,
      result: "rejected",
      events: [],
      errorCode,
      message,
      limits: this.config.observationLimits,
    });
    this.ports.logger.event({
      kind: "terminal.action.rejected",
      session,
      action: action.kind,
      observation,
      message,
    });
    return observation;
  }
}

function renderPtyInput(action: PtyAction): string | null {
  switch (action.kind) {
    case "write_text":
      return action.text;
    case "key":
      return renderKey(action.key);
    case "poll":
    case "interrupt":
    case "restart":
    case "status":
    case "terminate":
      return null;
  }
}

function renderKey(key: Extract<PtyAction, { kind: "key" }>["key"]): string {
  switch (key) {
    case "enter":
      return "\n";
    case "ctrl-c":
      return "\u0003";
    case "ctrl-d":
      return "\u0004";
    case "escape":
      return "\u001b";
    case "tab":
      return "\t";
    case "up":
      return "\u001b[A";
    case "down":
      return "\u001b[B";
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
