import type { ParserState } from "../terminal/parser.js";
import type {
  LogRef,
  SessionListObservation,
  TerminalObservation,
  TerminalScreen,
  TerminalState,
  TerminalToolRequest,
} from "../terminal/types.js";

export type TerminalServiceConfig = {
  defaultSessionId: string;
  promptNonce: string;
  screenRows: number;
  screenCols: number;
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
  screen: TerminalScreen;
};

export type StructuredLogEvent = {
  kind: string;
  session?: string;
  action?: TerminalToolRequest["kind"];
  observation?: TerminalObservation | SessionListObservation;
  message?: string;
};

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
  getCurrent(): Promise<string>;
  setCurrent(session: string): Promise<void>;
  list(): Promise<TerminalRuntimeSnapshot[]>;
  load(session: string): Promise<TerminalRuntimeSnapshot | null>;
  save(snapshot: TerminalRuntimeSnapshot): Promise<void>;
}

export interface TerminalLogger {
  event(event: StructuredLogEvent): void;
}

export type TerminalServicePorts = {
  pty: PtyPort;
  sessions: TerminalSessionStore;
  logger: TerminalLogger;
};
