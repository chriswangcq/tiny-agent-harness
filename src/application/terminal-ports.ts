import type { ParserState } from "../terminal/parser.js";
import type {
  LogRef,
  PtyAction,
  PtyObservation,
  TerminalState,
} from "../terminal/types.js";
import type { PtyActionLimits } from "../terminal/validator.js";
import type { TerminalObservationLimits } from "../terminal/observation.js";

export type TerminalServiceConfig = {
  defaultSessionId: string;
  promptNonce: string;
  actionLimits: PtyActionLimits;
  observationLimits: TerminalObservationLimits;
};

export type TerminalRuntimeSnapshot = {
  session: string;
  terminal: TerminalState;
  parserState: ParserState;
  outputLog?: LogRef;
};

export type PtyReadResult = {
  chunk: string;
  cursor?: string;
  logRef?: LogRef;
};

export type StructuredLogEvent = {
  kind: string;
  session?: string;
  action?: PtyAction["kind"];
  observation?: PtyObservation;
  message?: string;
};

export interface TerminalClock {
  nowIso(): string;
  monotonicMs(): number;
}

export interface TerminalIdGenerator {
  newId(prefix: string): string;
  newNonce(): string;
}

export interface PtyPort {
  write(session: string, data: string): Promise<void>;
  read(session: string, cursor?: string): Promise<PtyReadResult>;
  interrupt(session: string): Promise<void>;
  terminate(session: string): Promise<void>;
  restart(
    session: string,
    options?: { cwd?: string },
  ): Promise<TerminalRuntimeSnapshot>;
}

export interface TerminalSessionStore {
  load(session: string): Promise<TerminalRuntimeSnapshot | null>;
  save(snapshot: TerminalRuntimeSnapshot): Promise<void>;
}

export interface TerminalLogger {
  event(event: StructuredLogEvent): void;
}

export type TerminalServicePorts = {
  clock: TerminalClock;
  ids: TerminalIdGenerator;
  pty: PtyPort;
  sessions: TerminalSessionStore;
  logger: TerminalLogger;
};
