# Environment Model

Environment stores external facts that should wake or remind the agent outside normal tool observations. PTY screen text is not duplicated here; full terminal screen state still returns through the tool-result path as `TerminalObservation` or `SessionListObservation`. Durable terminal facts, such as output arriving, a session entering continuation prompt, or a session returning to prompt, are modeled as environment events.

## Event Kinds

```ts
type EnvironmentEvent =
  | {
      level?: number;
      kind: "user_message_received";
      source: "im";
      message: UserMessage;
    }
  | {
      level?: number;
      kind: "skill_run_started" | "skill_run_closed" | "skill_review_pending" | "skill_review_completed";
      source: "skill";
      skillRunId: string;
      skill: string;
      statePath: string;
      executionLogPath?: string;
      reviewTaskPath?: string;
      lessonsPath?: string;
    }
  | {
      level?: number;
      kind:
        | "session_output_available"
        | "session_input_ready"
        | "session_focused"
        | "session_restarted"
        | "session_continuation_prompt"
        | "session_returned_to_prompt"
        | "session_terminated"
        | "session_unsynced";
      source: "session";
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
```

## Reminder Semantics

- `consumeSince(runId)` returns unconsumed environment events and advances the run cursor.
- `waitFor(new_user_message)` resolves without consuming the matched event, so the next model turn can still see the reminder.
- `waitFor()` with no condition, or `waitFor({ kind: "event" })`, waits for any new environment event.
- Wait registration captures the latest event cursor. Historical events do not wake a newly registered wait.
- Event waits can filter by `source`, `eventKind`, `session`, `channel`, and `minLevel`; `minLevel` means `event.level >= minLevel`, and missing event level defaults to `1`.
- `Environment.renderReminder` serializes user messages as `[user@channel] ...` and skill/session facts as factual reminder lines.
- When `events.jsonl` is configured, `Environment` also watches the JSONL file while waiting so sibling CLI commands such as `skill close` can wake the run.
- While `io_wait` is pending, the orchestrator starts a best-effort session observe pump so terminal prompt/output facts can become session environment events.

## Boundary

```text
IM transport / skill lifecycle / terminal session facts
  -> EnvironmentEvent
  -> Environment reminder
  -> ModelContextSession
  -> PromptBuilder

terminal/session tool execution
  -> ManagedTerminalRuntime
  -> TerminalObservation | SessionListObservation
  -> model-context observation item
  -> selected session EnvironmentEvent facts
```

This keeps PTY screen text in one place: the terminal/session observation stream. Environment only stores small wake/reminder facts.
