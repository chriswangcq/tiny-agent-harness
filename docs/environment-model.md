# Environment Model

Environment stores external facts that should wake or remind the agent outside normal tool observations. Terminal output is not duplicated here; terminal/session facts return through the tool-result path as `TerminalObservation` or `SessionListObservation`.

## Event Kinds

```ts
type EnvironmentEvent =
  | {
      kind: "user_message_received";
      source: "im";
      message: UserMessage;
    }
  | {
      kind: "skill_run_started" | "skill_run_closed" | "skill_review_pending" | "skill_review_completed";
      source: "skill";
      skillRunId: string;
      skill: string;
      statePath: string;
      executionLogPath?: string;
      reviewTaskPath?: string;
      lessonsPath?: string;
    };
```

## Reminder Semantics

- `consumeSince(runId)` returns unconsumed environment events and advances the run cursor.
- `waitFor(new_user_message)` resolves without consuming the matched event, so the next model turn can still see the reminder.
- `Environment.renderReminder` serializes user messages as `[user@channel] ...` and skill facts as factual reminder lines.

## Boundary

```text
IM transport / skill lifecycle
  -> EnvironmentEvent
  -> Environment reminder
  -> ModelContextSession
  -> PromptBuilder

terminal/session tool execution
  -> ManagedTerminalRuntime
  -> TerminalObservation | SessionListObservation
  -> model-context observation item
```

This keeps terminal state in one place: the terminal/session observation stream.
