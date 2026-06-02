import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EnvironmentEvent,
  EnvironmentPort,
  EnvironmentState,
  IoWaitRequest,
} from "../types/index.js";
import {
  environmentEventLevel,
  ioWaitMinLevel,
  isEnvironmentEventKind,
  isEnvironmentEventSource,
  validateIoWaitRequest,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Waiter — a pending waitFor() call
// ---------------------------------------------------------------------------

type Waiter = {
  runId: string;
  wait: IoWaitRequest;
  afterEventId?: string;
  resolve: (event: EnvironmentEvent) => void;
  reject: (error: Error) => void;
  interval?: NodeJS.Timeout;
};

// ---------------------------------------------------------------------------
// Environment (persistent JSONL)
// ---------------------------------------------------------------------------

export class Environment implements EnvironmentPort {
  private eventsPath: string | undefined;
  private _state: EnvironmentState = {
    latestEventId: undefined,
    events: [],
    consumedByRun: {},
  };

  private waiters: Waiter[] = [];

  // Bound IM channel for this run; io_wait channel is auto-corrected to this value.
  boundChannel: string | undefined = undefined;

  setBoundChannel(ch: string): void {
    this.boundChannel = ch;
  }

  // Set the file path for persisting environment events.
  // When set, every appendEvent also writes a JSONL line, and waiters poll the
  // file for events emitted by sibling CLI processes.
  setEventsPath(p: string): void {
    this.eventsPath = p;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.syncFromEventsPath();
  }

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
    if (!this.addEventToState(event)) {
      return;
    }

    // Persist to JSONL file if path is set
    if (this.eventsPath) {
      try {
        fs.appendFileSync(this.eventsPath, JSON.stringify(event) + "\n", "utf-8");
      } catch {
        // best-effort persistence
      }
    }

    this.resolveMatchingWaiters(event);
  }

  // -----------------------------------------------------------------------
  // consumeSince
  // -----------------------------------------------------------------------

  consumeSince(options: {
    runId: string;
    afterEventId?: string;
  }): EnvironmentEvent[] {
    this.syncFromEventsPath();

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

    // Mark the turn-start cursor even when there are no events. An io_wait
    // emitted after a model turn must see events that arrived during that turn.
    this._state.consumedByRun[runId] =
      result.length > 0
        ? result[result.length - 1]!.id
        : cursor ?? this._state.latestEventId;

    return result;
  }

  // -----------------------------------------------------------------------
  // waitFor
  // -----------------------------------------------------------------------

  waitFor(options: {
    runId: string;
    wait: IoWaitRequest;
    afterEventId?: string;
  }): Promise<EnvironmentEvent> {
    const { runId, wait } = options;
    const invalidWait = validateIoWaitRequest(wait);
    if (invalidWait !== undefined) {
      return Promise.reject(new Error(invalidWait));
    }

    this.syncFromEventsPath();
    const hasExplicitCursor = Object.prototype.hasOwnProperty.call(
      options,
      "afterEventId",
    );
    const hasRunCursor = Object.prototype.hasOwnProperty.call(
      this._state.consumedByRun,
      runId,
    );
    const afterEventId = hasExplicitCursor
      ? options.afterEventId
      : hasRunCursor
        ? this._state.consumedByRun[runId]
        : this._state.latestEventId;

    // First, check events newer than the captured cursor for a match.
    const existing = this.findMatchingEventAfter(afterEventId, wait);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    // No match found — register a waiter for future events
    return new Promise<EnvironmentEvent>((resolve, reject) => {
      const waiter: Waiter = { runId, wait, afterEventId, resolve, reject };
      if (this.eventsPath !== undefined) {
        waiter.interval = setInterval(() => {
          try {
            this.syncFromEventsPath();
            const matched = this.findMatchingEventAfter(afterEventId, wait);
            if (matched !== undefined) {
              this.resolveWaiter(waiter, matched);
            }
          } catch (error) {
            this.rejectWaiter(waiter, toError(error));
          }
        }, 50);
        waiter.interval.unref?.();
      }
      this.waiters.push(waiter);
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
      switch (event.kind) {
        case "user_message_received":
          return `[user@${event.message.channel}] ${event.message.text}`;

        case "skill_run_started":
          return `- [${event.id}] skill skill_run_started skillRun=${event.skillRunId} skill=${event.skill} state=${event.statePath} log=${event.executionLogPath ?? ""}`;

        case "skill_run_closed":
          return `- [${event.id}] skill skill_run_closed skillRun=${event.skillRunId} skill=${event.skill} state=${event.statePath}`;

        case "skill_review_pending":
          return `- [${event.id}] skill skill_review_pending skillRun=${event.skillRunId} skill=${event.skill} state=${event.statePath} task=${event.reviewTaskPath ?? ""}`;

        case "skill_review_completed":
          return `- [${event.id}] skill skill_review_completed skillRun=${event.skillRunId} skill=${event.skill} state=${event.statePath} lessons=${event.lessonsPath ?? ""}`;

        case "session_focused":
          return `- [${event.id}] session focused session=${event.session} inputSeq=${event.inputSeq}`;

        case "session_restarted":
          return `- [${event.id}] session restarted session=${event.session} inputSeq=${event.inputSeq}`;

        case "session_output_available":
          return `- [${event.id}] session output_available session=${event.session} inputSeq=${event.inputSeq}`;

        case "session_input_ready":
          return `- [${event.id}] session input_ready session=${event.session} inputSeq=${event.inputSeq}`;

        case "session_continuation_prompt":
          return `- [${event.id}] session continuation_prompt session=${event.session} reason=${event.continuationReason ?? ""} inputSeq=${event.inputSeq}`;

        case "session_returned_to_prompt":
          return `- [${event.id}] session returned_to_prompt session=${event.session} cwd=${event.cwd ?? ""} rc=${event.lastReturnCode ?? ""} inputSeq=${event.inputSeq}`;

        case "session_terminated":
          return `- [${event.id}] session terminated session=${event.session} reason=${event.reason ?? ""} inputSeq=${event.inputSeq}`;

        case "session_unsynced":
          return `- [${event.id}] session unsynced session=${event.session} reason=${event.reason ?? ""} inputSeq=${event.inputSeq}`;
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
    return environmentEventLevel(event) >= ioWaitMinLevel(wait);
  }

  private syncFromEventsPath(): void {
    if (this.eventsPath === undefined || !fs.existsSync(this.eventsPath)) {
      return;
    }

    const content = fs.readFileSync(this.eventsPath, "utf-8");
    for (const line of content.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isPersistedEnvironmentEvent(parsed)) {
          if (this.addEventToState(parsed)) {
            this.resolveMatchingWaiters(parsed);
          }
        }
      } catch {
        // Ignore malformed historical lines. The transcript remains the audit log.
      }
    }
  }

  private addEventToState(event: EnvironmentEvent): boolean {
    if (this._state.events.some((existing) => existing.id === event.id)) {
      return false;
    }
    this._state.events.push(event);
    this._state.latestEventId = event.id;
    return true;
  }

  private findMatchingEventAfter(
    afterEventId: string | undefined,
    wait: IoWaitRequest,
  ): EnvironmentEvent | undefined {
    let startIndex: number;

    if (afterEventId === undefined) {
      startIndex = 0;
    } else {
      const cursorIndex = this._state.events.findIndex(
        (e) => e.id === afterEventId,
      );
      startIndex = cursorIndex === -1 ? 0 : cursorIndex + 1;
    }

    return this._state.events
      .slice(startIndex)
      .find((event) => this.eventMatchesWait(event, wait));
  }

  private resolveMatchingWaiters(event: EnvironmentEvent): void {
    const matched: Waiter[] = [];
    const remaining: Waiter[] = [];

    for (const waiter of this.waiters) {
      if (
        matched.length === 0 &&
        this.isAfterEvent(event, waiter.afterEventId) &&
        this.eventMatchesWait(event, waiter.wait)
      ) {
        matched.push(waiter);
      } else {
        remaining.push(waiter);
      }
    }

    this.waiters = remaining;

    for (const waiter of matched) {
      this.resolveWaiter(waiter, event);
    }
  }

  private resolveWaiter(waiter: Waiter, event: EnvironmentEvent): void {
    this.removeWaiter(waiter);
    waiter.interval && clearInterval(waiter.interval);
    waiter.resolve(event);
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    this.removeWaiter(waiter);
    waiter.interval && clearInterval(waiter.interval);
    waiter.reject(error);
  }

  private removeWaiter(waiter: Waiter): void {
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
  }

  private isAfterEvent(
    event: EnvironmentEvent,
    afterEventId: string | undefined,
  ): boolean {
    if (afterEventId === undefined) {
      return true;
    }
    const eventIndex = this._state.events.findIndex((e) => e.id === event.id);
    const afterIndex = this._state.events.findIndex((e) => e.id === afterEventId);
    if (eventIndex === -1) {
      return false;
    }
    if (afterIndex === -1) {
      return true;
    }
    return eventIndex > afterIndex;
  }
}

function isPersistedEnvironmentEvent(value: unknown): value is EnvironmentEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    isEnvironmentEventKind(event.kind) &&
    isEnvironmentEventSource(event.source) &&
    typeof event.timestamp === "string"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
