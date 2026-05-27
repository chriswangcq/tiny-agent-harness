export type TerminalOwnerKind =
  | "shell"
  | "shell_continuation"
  | "process"
  | "receiver"
  | "unknown"
  | "terminated";

export type ContinuationReason =
  | "quote"
  | "heredoc"
  | "line_continuation"
  | "unknown";

export type ProcessStdinMode = "none" | "interactive" | "unknown";

export type ReceiverMode = "text" | "base64";

export type TerminalOwner =
  | ShellOwner
  | ShellContinuationOwner
  | ProcessOwner
  | ReceiverOwner
  | UnknownOwner
  | TerminatedOwner;

export type ShellOwner = {
  kind: "shell";
  revision: number;
  cwd: string;
  promptSeq: number;
  lastReturnCode: number | null;
  promptNonce: string;
};

export type ShellContinuationOwner = {
  kind: "shell_continuation";
  revision: number;
  reason: ContinuationReason;
  promptSeq: number;
  promptNonce: string;
};

export type ProcessOwner = {
  kind: "process";
  revision: number;
  commandLine: string | null;
  stdinMode: ProcessStdinMode;
  startedAt: string;
  lastOutputAt: string | null;
};

export type ReceiverOwner = {
  kind: "receiver";
  revision: number;
  receiverId: string;
  commandLine: string;
  mode: ReceiverMode;
  nextSeq: number;
  bytesReceived: number;
  maxFrameBytes: number;
  expectedSha256?: string;
};

export type UnknownOwner = {
  kind: "unknown";
  revision: number;
  reason:
    | "unparsed_output"
    | "prompt_spoof_suspected"
    | "adapter_restart"
    | "state_gap";
};

export type TerminatedOwner = {
  kind: "terminated";
  revision: number;
  exitCode: number | null;
  reason: string;
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
      expectedOwnerRevision: number;
      text: string;
    }
  | {
      kind: "key";
      session?: string;
      expectedOwnerRevision: number;
      key: TerminalKey;
    }
  | { kind: "poll"; session?: string; sinceSeq?: number }
  | { kind: "status"; session?: string }
  | {
      kind: "interrupt";
      session?: string;
      expectedOwnerRevision?: number;
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
      kind: "receiver_ready";
      receiverId: string;
      commandLine: string;
      mode: ReceiverMode;
      maxFrameBytes: number;
      nextSeq: number;
      bytesReceived?: number;
      expectedSha256?: string;
    }
  | {
      kind: "receiver_ack";
      receiverId: string;
      seq: number;
      bytes: number;
    }
  | {
      kind: "receiver_done";
      receiverId: string;
      bytes: number;
      sha256: string;
    }
  | {
      kind: "output";
      bytes: number;
      preview: string;
      logRef?: string;
    }
  | {
      kind: "silence_timeout";
      elapsedMs: number;
      commandLine: string | null;
      startedAt: string;
      stdinMode?: ProcessStdinMode;
    }
  | {
      kind: "unsynced";
      reason: UnknownOwner["reason"];
    }
  | {
      kind: "terminated";
      exitCode: number | null;
      reason: string;
    };

export type TerminalErrorCode =
  | "OWNER_MISMATCH"
  | "OWNER_REJECTED"
  | "RECEIVER_SEQ_MISMATCH"
  | "RECEIVER_HASH_MISMATCH"
  | "RECEIVER_BYTES_MISMATCH"
  | "RECEIVER_FRAME_TOO_LARGE"
  | "RECEIVER_INVALID_BASE64"
  | "PAYLOAD_TOO_LARGE_FOR_ACTION"
  | "TERMINAL_UNSYNCED"
  | "TERMINAL_TERMINATED";

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: TerminalErrorCode;
      message: string;
      owner: TerminalOwner;
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
  receiverId?: string;
  seq?: number;
  bytes?: number;
  sha256?: string;
  preview?: string;
  redacted?: boolean;
};

export type TerminalEventSummary = {
  kind: TerminalEvent["kind"];
  receiverId?: string;
  seq?: number;
  bytes?: number;
  sha256?: string;
  preview?: string;
  logRef?: string;
};

export type PtyObservation = {
  session: string;
  owner: TerminalOwner;
  action: PtyActionSummary;
  result: "ok" | "rejected" | "timeout" | "interrupted";
  events: TerminalEventSummary[];
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
};

export type TerminalSessionSnapshot = {
  session: string;
  owner: TerminalOwner;
  parserCursor?: string;
  outputLog?: LogRef;
};
