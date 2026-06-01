export type ContinuationReason =
  | "quote"
  | "heredoc"
  | "line_continuation"
  | "unknown";

export type TerminalUnsyncedReason =
  | "unparsed_output"
  | "prompt_spoof_suspected"
  | "adapter_restart"
  | "state_gap";

export type ShellPromptSnapshot = {
  cwd: string;
  promptSeq: number;
  lastReturnCode: number | null;
};

export type ContinuationPromptSnapshot = {
  reason: ContinuationReason;
  promptSeq: number;
};

export type TerminalSyncStatus =
  | { kind: "trusted" }
  | { kind: "unsynced"; reason: TerminalUnsyncedReason };

export type TerminalTermination = {
  exitCode: number | null;
  reason: string;
};

export type TerminalState = {
  inputSeq: number;
  alive: boolean;
  syncStatus: TerminalSyncStatus;
  lastShellPrompt: ShellPromptSnapshot | null;
  lastContinuationPrompt: ContinuationPromptSnapshot | null;
  termination: TerminalTermination | null;
  foregroundProcess: string | null;
};

export const TERMINAL_KEYS = [
  "enter",
  "ctrl-d",
  "escape",
  "tab",
  "space",
  "q",
  "up",
  "down",
  "left",
  "right",
] as const;

export type TerminalKey = (typeof TERMINAL_KEYS)[number];

export type TerminalEvent =
  | {
      kind: "prompt";
      returnCode: number;
      cwd: string;
      promptSeq: number;
      promptNonce: string;
    }
  | {
      kind: "continuation_prompt";
      reason: ContinuationReason;
      promptSeq: number;
      promptNonce: string;
    }
  | {
      kind: "output";
      bytes: number;
      preview: string;
      logRef?: string;
    }
  | {
      kind: "unsynced";
      reason: TerminalUnsyncedReason;
    }
  | {
      kind: "terminated";
      exitCode: number | null;
      reason: string;
    };

export type TerminalErrorCode =
  | "INPUT_SEQ_MISMATCH"
  | "TERMINAL_UNSYNCED"
  | "TERMINAL_TERMINATED";

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: TerminalErrorCode;
      message: string;
      terminal: TerminalState;
    };

export type LogRef = {
  kind: "log";
  ref: string;
  startOffset?: number;
  endOffset?: number;
};

export type TerminalSessionSnapshot = {
  session: string;
  terminal: TerminalState;
  parserCursor?: string;
  outputLog?: LogRef;
};

export type TerminalWriteRequest = {
  kind: "terminal_write";
  expectedInputSeq: number;
  text: string;
  waitForReturnMs?: number;
};

export type TerminalKeyRequest = {
  kind: "terminal_key";
  expectedInputSeq: number;
  key: TerminalKey;
  waitForReturnMs?: number;
};

export type SessionObserveRequest = {
  kind: "session_observe";
  session?: string;
};

export type SessionListRequest = {
  kind: "session_list";
};

export type SessionFocusRequest = {
  kind: "session_focus";
  session: string;
  create?: boolean;
  cwd?: string;
};

export type SessionInterruptRequest = {
  kind: "session_interrupt";
  expectedInputSeq: number;
  waitForReturnMs?: number;
};

export type SessionRestartRequest = {
  kind: "session_restart";
  session?: string;
  cwd?: string;
  reason?: string;
};

export type SessionTerminateRequest = {
  kind: "session_terminate";
  session?: string;
  reason?: string;
};

export type TerminalToolRequest =
  | TerminalWriteRequest
  | TerminalKeyRequest
  | SessionObserveRequest
  | SessionListRequest
  | SessionFocusRequest
  | SessionInterruptRequest
  | SessionRestartRequest
  | SessionTerminateRequest;

export type TerminalScreen = {
  text: string;
  rows: number;
  cols: number;
  truncated: boolean;
  logRef: {
    path: string;
  };
};

export type TerminalObservation = {
  currentSession: string;
  observedSession: string;
  terminal: TerminalState;
  request: TerminalToolRequest["kind"];
  result: "ok" | "rejected" | "timeout" | "interrupted";
  returnedToPrompt: boolean;
  screen: TerminalScreen;
  terminalEvents?: TerminalEvent[];
  errorCode?: TerminalErrorCode;
  message?: string;
};

export type SessionListObservation = {
  currentSession: string;
  sessions: TerminalSessionSnapshot[];
};
