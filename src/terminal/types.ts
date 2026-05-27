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
};

export type TerminalKey =
  | "enter"
  | "ctrl-c"
  | "ctrl-d"
  | "escape"
  | "tab"
  | "up"
  | "down";

export type PtyAction =
  | {
      kind: "write_text";
      session?: string;
      expectedInputSeq: number;
      text: string;
    }
  | {
      kind: "key";
      session?: string;
      expectedInputSeq: number;
      key: TerminalKey;
    }
  | { kind: "poll"; session?: string; sinceSeq?: number }
  | { kind: "status"; session?: string }
  | {
      kind: "interrupt";
      session?: string;
      expectedInputSeq?: number;
    }
  | { kind: "terminate"; session?: string }
  | { kind: "restart"; session?: string; cwd?: string };

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

export type PtyActionSummary = {
  kind: PtyAction["kind"];
  session?: string;
  bytes?: number;
  preview?: string;
  redacted?: boolean;
};

export type TerminalEventSummary = {
  kind: TerminalEvent["kind"];
  bytes?: number;
  preview?: string;
  logRef?: string;
};

export type PtyObservation = {
  session: string;
  terminal: TerminalState;
  action: PtyActionSummary;
  result: "ok" | "rejected" | "timeout" | "interrupted";
  eventCount: number;
  eventsOmitted?: number;
  events: TerminalEventSummary[];
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
};

export type TerminalSessionSnapshot = {
  session: string;
  terminal: TerminalState;
  parserCursor?: string;
  outputLog?: LogRef;
};
