// ─── Environment Event Model ────────────────────────────────────────
//
// Unified external event model. Environment collects events from IM,
// bash sessions, and other external sources. The orchestrator consumes
// them as system reminders at loop boundaries.

import type { BashSessionState } from "./bash.js";

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
  channel: string;
  role: "agent";
  kind: "status" | "final" | "error";
  text: string;
  runId?: string;
  createdAt: string;
  metadata?: Record<string, string>;
};

// ─── Environment Events ────────────────────────────────────────────

export type EnvironmentEvent =
  | {
      id: string;
      kind: "user_message_received";
      source: "im";
      timestamp: string;
      message: UserMessage;
    }
  | {
      id: string;
      kind: "session_state_changed";
      source: "bash";
      timestamp: string;
      session: string;
      previousState: BashSessionState;
      nextState: BashSessionState;
    }
  | {
      id: string;
      kind: "command_finished";
      source: "bash";
      timestamp: string;
      session: string;
      commandId: string;
      returnCode: number;
      outputLogPath: string;
    }
  | {
      id: string;
      kind: "command_timed_out";
      source: "bash";
      timestamp: string;
      session: string;
      commandId: string;
      outputLogPath: string;
    };

// ─── Environment State ─────────────────────────────────────────────

export type EnvironmentState = {
  latestEventId?: string;
  events: EnvironmentEvent[];
  consumedByRun: Record<string, string | undefined>;
};

// ─── IO Wait Request ───────────────────────────────────────────────

export type IoWaitRequest = {
  reason?: string;
  condition:
    | {
        kind: "event";
        eventKind: EnvironmentEvent["kind"];
        source?: EnvironmentEvent["source"];
      }
    | {
        kind: "new_user_message";
        channel: string;
        cursor?: string;
      };
};

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
  }): Promise<EnvironmentEvent>;
};

// ─── IM Transport Port ─────────────────────────────────────────────

export type ReceivedUserMessages = {
  messages: UserMessage[];
  nextCursor?: string;
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
