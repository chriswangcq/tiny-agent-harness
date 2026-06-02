import type { TerminalToolRequest } from "../terminal/types.js";

// ─── Environment Event Model ────────────────────────────────────────
//
// Unified external event model. Environment collects user and skill events.
// Terminal facts are returned as terminal/session observations through the tool
// result path.

export const ENVIRONMENT_EVENT_KINDS = [
  "user_message_received",
  "skill_run_started",
  "skill_run_closed",
  "skill_review_pending",
  "skill_review_completed",
  "session_output_available",
  "session_input_ready",
  "session_focused",
  "session_restarted",
  "session_continuation_prompt",
  "session_returned_to_prompt",
  "session_terminated",
  "session_unsynced",
] as const;

export const ENVIRONMENT_EVENT_SOURCES = ["im", "skill", "session"] as const;

export type EnvironmentEventKind = (typeof ENVIRONMENT_EVENT_KINDS)[number];
export type EnvironmentEventSource = (typeof ENVIRONMENT_EVENT_SOURCES)[number];

// ─── User / Agent Messages (IM) ────────────────────────────────────

export type UserMessage = {
  id: string;
  channel: string;
  role: "user";
  text: string;
  createdAt: string;
  metadata?: Record<string, string>;
};

export type AgentMessage = {
  id?: string;
  channel: string;
  role: "agent";
  kind: "status" | "error";
  text: string;
  runId?: string;
  createdAt: string;
  metadata?: Record<string, string>;
};

// ─── Environment Events ────────────────────────────────────────────

export type EnvironmentEvent =
  | {
      id: string;
      level?: number;
      kind: "user_message_received";
      source: "im";
      timestamp: string;
      message: UserMessage;
    }
  | {
      id: string;
      level?: number;
      kind: "skill_run_started" | "skill_run_closed" | "skill_review_pending" | "skill_review_completed";
      source: "skill";
      timestamp: string;
      skillRunId: string;
      skill: string;
      statePath: string;
      executionLogPath?: string;
      reviewTaskPath?: string;
      lessonsPath?: string;
    }
  | {
      id: string;
      level?: number;
      kind:
        | "session_focused"
        | "session_restarted"
        | "session_output_available"
        | "session_input_ready"
        | "session_continuation_prompt"
        | "session_returned_to_prompt"
        | "session_terminated"
        | "session_unsynced";
      source: "session";
      timestamp: string;
      session: string;
      currentSession: string;
      request: TerminalToolRequest["kind"];
      inputSeq: number;
      cwd?: string;
      lastReturnCode?: number | null;
      foregroundProcess?: string | null;
      promptSeq?: number;
      continuationReason?: string;
      reason?: string;
      exitCode?: number | null;
    };

// ─── Environment State ─────────────────────────────────────────────

export type EnvironmentState = {
  latestEventId?: string;
  events: EnvironmentEvent[];
  consumedByRun: Record<string, string | undefined>;
};

export const ENVIRONMENT_EVENT_LEVELS = {
  ANY: 0,
  DEFAULT: 1,
  USER_MESSAGE: 100,
} as const;

// ─── IO Wait Request ───────────────────────────────────────────────

export type IoWaitRequest = {
  reason?: string;
  minLevel?: number;
  /**
   * Deprecated compatibility shape accepted for old transcripts/model outputs.
   * Runtime wait matching is priority-only: only minLevel participates.
   */
  condition?:
    | {
        kind?: "event";
        eventKind?: EnvironmentEvent["kind"];
        source?: EnvironmentEvent["source"];
        session?: string;
        channel?: string;
        minLevel?: number;
      }
    | {
        kind?: "new_user_message";
        channel?: string;
        cursor?: string;
        minLevel?: number;
      };
};

export function isEnvironmentEventKind(
  value: unknown,
): value is EnvironmentEventKind {
  return (
    typeof value === "string" &&
    (ENVIRONMENT_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export function isEnvironmentEventSource(
  value: unknown,
): value is EnvironmentEventSource {
  return (
    typeof value === "string" &&
    (ENVIRONMENT_EVENT_SOURCES as readonly string[]).includes(value)
  );
}

export function environmentEventLevel(event: EnvironmentEvent): number {
  const explicitLevel =
    typeof event.level === "number" && Number.isFinite(event.level)
      ? event.level
      : undefined;

  if (event.kind === "user_message_received") {
    return Math.max(
      explicitLevel ?? ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
      ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
    );
  }

  return explicitLevel ?? ENVIRONMENT_EVENT_LEVELS.DEFAULT;
}

export function ioWaitMinLevel(wait: IoWaitRequest): number {
  return wait.minLevel ?? wait.condition?.minLevel ?? ENVIRONMENT_EVENT_LEVELS.ANY;
}

export function validateIoWaitRequest(wait: IoWaitRequest): string | undefined {
  if (
    wait.minLevel !== undefined &&
    (typeof wait.minLevel !== "number" || !Number.isFinite(wait.minLevel))
  ) {
    return "Invalid io_wait: minLevel must be a finite number when provided.";
  }

  const condition = wait.condition;
  if (condition === undefined) {
    return undefined;
  }

  if (typeof condition !== "object" || condition === null) {
    return "Invalid io_wait: condition must be an object when provided.";
  }

  const minLevel = "minLevel" in condition ? condition.minLevel : undefined;
  if (
    minLevel !== undefined &&
    (typeof minLevel !== "number" || !Number.isFinite(minLevel))
  ) {
    return "Invalid io_wait: minLevel must be a finite number when provided.";
  }

  if (condition.kind === undefined) {
    return undefined;
  }

  if (condition.kind === "new_user_message") {
    if (condition.channel !== undefined && typeof condition.channel !== "string") {
      return "Invalid io_wait: new_user_message.channel must be a string when provided.";
    }
    return undefined;
  }

  if (condition.kind === "event") {
    if (
      condition.eventKind !== undefined &&
      !isEnvironmentEventKind(condition.eventKind)
    ) {
      return "Invalid io_wait: event condition eventKind must be a valid environment event kind when provided.";
    }
    if (
      condition.source !== undefined &&
      !isEnvironmentEventSource(condition.source)
    ) {
      return "Invalid io_wait: event condition source must be im, skill, or session.";
    }
    if (condition.session !== undefined && typeof condition.session !== "string") {
      return "Invalid io_wait: event condition session must be a string when provided.";
    }
    if (condition.channel !== undefined && typeof condition.channel !== "string") {
      return "Invalid io_wait: event condition channel must be a string when provided.";
    }
    return undefined;
  }

  return "Invalid io_wait: condition.kind must be new_user_message or event.";
}

// ─── Environment Port ──────────────────────────────────────────────

export type EnvironmentPort = {
  appendEvent(event: EnvironmentEvent): void;

  consumeSince(options: {
    runId: string;
    afterEventId?: string;
  }): EnvironmentEvent[];

  waitFor(options: {
    runId: string;
    wait: IoWaitRequest;
    afterEventId?: string;
  }): Promise<EnvironmentEvent>;
};

// ─── IM Transport Port ─────────────────────────────────────────────

export type ReceivedUserMessages = {
  messages: UserMessage[];
  nextCursor?: string;
  cursorFound?: false;
};

export type UserMessageTransport = {
  receive(options: {
    channel: string;
    cursor?: string;
    waitMs?: number;
  }): Promise<ReceivedUserMessages>;

  send(message: AgentMessage): Promise<void>;

  ack(options: {
    channel: string;
    messageId: string;
  }): Promise<void>;

  pollNewMessages(options: {
    channel: string;
    cursor?: string;
    waitMs?: number;
  }): Promise<UserMessage[]>;
};
