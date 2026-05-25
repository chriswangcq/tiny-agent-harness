import type {
  EnvironmentEvent,
  EnvironmentPort,
  EnvironmentState,
  IoWaitRequest,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Waiter — a pending waitFor() call
// ---------------------------------------------------------------------------

type Waiter = {
  runId: string;
  wait: IoWaitRequest;
  resolve: (event: EnvironmentEvent) => void;
};

// ---------------------------------------------------------------------------
// Environment (in-memory)
// ---------------------------------------------------------------------------

export class Environment implements EnvironmentPort {
  private _state: EnvironmentState = {
    latestEventId: undefined,
    events: [],
    consumedByRun: {},
  };

  private waiters: Waiter[] = [];

  // -----------------------------------------------------------------------
  // State getter (for debugging / testing)
  // -----------------------------------------------------------------------

  get state(): Readonly<EnvironmentState> {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // appendEvent
  // -----------------------------------------------------------------------

  appendEvent(event: EnvironmentEvent): void {
    this._state.events.push(event);
    this._state.latestEventId = event.id;

    // Check if any pending waiters match this event
    const matched: Waiter[] = [];
    const remaining: Waiter[] = [];

    for (const waiter of this.waiters) {
      if (matched.length === 0 && this.eventMatchesWait(event, waiter.wait)) {
        matched.push(waiter);
      } else {
        remaining.push(waiter);
      }
    }

    this.waiters = remaining;

    for (const waiter of matched) {
      waiter.resolve(event);
    }
  }

  // -----------------------------------------------------------------------
  // consumeSince
  // -----------------------------------------------------------------------

  consumeSince(options: {
    runId: string;
    afterEventId?: string;
  }): EnvironmentEvent[] {
    const { runId, afterEventId } = options;

    // Determine the cursor: explicit afterEventId overrides stored cursor
    const cursor = afterEventId ?? this._state.consumedByRun[runId];

    let startIndex: number;

    if (cursor === undefined) {
      // No cursor — return all events
      startIndex = 0;
    } else {
      // Find the cursor event and return everything after it
      const cursorIndex = this._state.events.findIndex(
        (e) => e.id === cursor,
      );
      if (cursorIndex === -1) {
        // Cursor not found — return all events (defensive)
        startIndex = 0;
      } else {
        startIndex = cursorIndex + 1;
      }
    }

    const result = this._state.events.slice(startIndex);

    // Update the consumed cursor to the last returned event
    if (result.length > 0) {
      this._state.consumedByRun[runId] = result[result.length - 1]!.id;
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // waitFor
  // -----------------------------------------------------------------------

  waitFor(options: {
    runId: string;
    wait: IoWaitRequest;
  }): Promise<EnvironmentEvent> {
    const { runId, wait } = options;

    // First, check existing unconsumed events for a match
    const cursor = this._state.consumedByRun[runId];
    let startIndex: number;

    if (cursor === undefined) {
      startIndex = 0;
    } else {
      const cursorIndex = this._state.events.findIndex(
        (e) => e.id === cursor,
      );
      startIndex = cursorIndex === -1 ? 0 : cursorIndex + 1;
    }

    for (let i = startIndex; i < this._state.events.length; i++) {
      const event = this._state.events[i]!;
      if (this.eventMatchesWait(event, wait)) {
        return Promise.resolve(event);
      }
    }

    // No match found — register a waiter for future events
    return new Promise<EnvironmentEvent>((resolve) => {
      this.waiters.push({ runId, wait, resolve });
    });
  }

  // -----------------------------------------------------------------------
  // renderReminder (static helper)
  // -----------------------------------------------------------------------

  static renderReminder(events: EnvironmentEvent[]): string {
    if (events.length === 0) {
      return "";
    }

    const lines = events.map((event) => {
      const prefix = `- [${event.id}] ${event.timestamp}`;

      switch (event.kind) {
        case "user_message_received":
          return `${prefix} im user_message_received channel=${event.message.channel} text="${truncate(event.message.text, 200)}"`;

        case "session_state_changed":
          return `${prefix} bash session_state_changed session=${event.session} ${event.previousState} -> ${event.nextState}`;

        case "command_finished":
          return `${prefix} bash command_finished session=${event.session} command=${event.commandId} rc=${event.returnCode} log=${event.outputLogPath}`;

        case "command_timed_out":
          return `${prefix} bash command_timed_out session=${event.session} command=${event.commandId} log=${event.outputLogPath}`;
      }
    });

    return `Environment reminder:\n${lines.join("\n")}`;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private eventMatchesWait(
    event: EnvironmentEvent,
    wait: IoWaitRequest,
  ): boolean {
    const { condition } = wait;

    if (condition.kind === "new_user_message") {
      return (
        event.kind === "user_message_received" && event.source === "im"
      );
    }

    if (condition.kind === "event") {
      if (event.kind !== condition.eventKind) {
        return false;
      }
      if (
        condition.source !== undefined &&
        event.source !== condition.source
      ) {
        return false;
      }
      return true;
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}
