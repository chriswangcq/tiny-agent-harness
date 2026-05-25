// ─── Bash Tool Input ────────────────────────────────────────────────
//
// All command requests must explicitly specify `session`.
// Control requests manage session lifecycle via the same `bash` tool.

export type BashToolInput = BashCommandInput | BashControlInput;

export type BashCommandInput = {
  session: string;
  command: string;
  timeoutMs?: number; // default: 30000
};

export type BashControlInput =
  | {
      control: "list";
    }
  | {
      control: "create";
      session: string;
      cwd?: string;
      shell?: string;
      env?: Record<string, string>;
      defaultTimeoutMs?: number;
      maxObservationBytes?: number;
    }
  | {
      control: "status" | "poll" | "interrupt" | "terminate" | "restart";
      session: string;
    }
  | {
      control: "sendInput";
      session: string;
      input: string;
    };

// ─── Bash Session (harness internal) ────────────────────────────────

export type BashSessionState = "idle" | "running" | "blocked" | "terminated";

export type CurrentCommand = {
  id: string;
  command: string;
  startedAt: string;
  timeoutMs: number;
  status: "running" | "exited" | "timed_out" | "interrupted";
  returnCode: number | null;
};

export type SessionOutput = {
  logPath: string;
  totalBytes: number;
  lastObservationOffset: number;
  maxObservationBytes: number;
  truncatedCount: number;
};

export type BashSession = {
  id: string;
  state: BashSessionState;

  shell: string;
  cwd: string;
  env: Record<string, string>;
  pty: boolean;

  currentCommand?: CurrentCommand;
  output: SessionOutput;

  limits: {
    defaultTimeoutMs: number;
    maxObservationBytes: number;
    idleTimeoutMs?: number;
  };

  createdAt: string;
  updatedAt: string;
};

// ─── Observation ────────────────────────────────────────────────────

export type BashObservation = {
  session: string | null;
  state?: BashSessionState;
  returnCode: number | null;
  timedOut?: boolean;
  focusReleased?: boolean;

  output: string;
  outputTruncated: boolean;
  outputLogPath?: string;
  outputStartOffset?: number;
  outputEndOffset?: number;

  control?:
    | "list"
    | "create"
    | "status"
    | "poll"
    | "sendInput"
    | "interrupt"
    | "terminate"
    | "restart";
  sessions?: BashSessionSummary[];
  message?: string;
};

export type BashSessionSummary = {
  id: string;
  state: BashSessionState;
  cwd: string;
  currentCommand?: string;
  outputLogPath: string;
  updatedAt: string;
};
