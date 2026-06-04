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
- `waitFor(...)` resolves without consuming the matched event, so the next model turn can still see the reminder.
- `waitFor()` with no `minLevel` waits for the next meaningful event (`level >= 10`). Explicit `minLevel: 0` waits for any new environment event, including low-value session output.
- `io_wait` uses the run's consumed-event cursor from the latest model turn start, not the later wait-registration moment. Events that arrive while the model is thinking can therefore satisfy the following `io_wait` immediately. If `waitFor` is used without a prior `consumeSince` for that run, it falls back to the latest event cursor at registration time so historical events do not self-wake standalone waits.
- `io_wait` is priority-only. Its effective threshold is `wait.minLevel ?? wait.condition?.minLevel ?? 10`; legacy `source`, `eventKind`, `session`, and `channel` fields are accepted only for historical compatibility and do not filter wake events. Missing user-message events default to level `100` and are treated as highest-priority operator input; skill lifecycle events default to level `10`; other missing non-user event levels default to `1`.
- `Environment.renderReminder` serializes user messages as `[user@channel] ...` and skill/session facts as factual reminder lines.
- When `events.jsonl` is configured, `Environment` also watches the JSONL file while waiting so sibling CLI commands such as `skill close` can wake the run.
- While `io_wait` is pending, the orchestrator starts a best-effort session observe pump so terminal prompt/output facts can become session environment events.

## Event Levels

The current taxonomy is intentionally small:

| Level | Constant | Meaning |
| ---: | --- | --- |
| 0 | `ANY` / `NOISE` | Explicit any-event waits and low-value session output facts such as `session_output_available`. |
| 1 | `DEFAULT` | Ordinary facts that should be consumed into the next reminder but should not wake a default wait. |
| 10 | `MEANINGFUL` | Lifecycle facts that should wake default waits, such as `session_input_ready`, `session_continuation_prompt`, `session_returned_to_prompt`, and skill lifecycle events. |
| 50 | `IMPORTANT` | Runtime safety or liveness facts such as `session_unsynced` and `session_terminated`. |
| 100 | `USER_MESSAGE` | Operator input. User messages are normalized to at least this level, even if the persisted event has a lower level. |

This keeps the session observe pump useful without turning level-0 terminal output into a wake storm. A model can still request a true any-event wait by emitting explicit `minLevel: 0`.

## Event Identity

Environment events represent external facts, not the observation attempt that noticed them. Session fact IDs must therefore be stable across `terminal_write`, explicit `session_observe`, and the background session pump. For example, the same prompt return should keep the same event id when it is observed multiple times:

```text
env-session-{runId}-{session}-returned-nonce-{promptNonce}
env-session-{runId}-{session}-input-ready-prompt-nonce-{promptNonce}
env-session-{runId}-{session}-output-{inputSeq}
```

`Environment.appendEvent(...)` returns `false` when an event id already exists. The orchestrator records `environment_event_recorded` only when the append actually added a new event. This prevents repeated pump observations from inflating both `events.jsonl` and the transcript.

`model_thinking_delta` is not an environment event. It is retained only for historical transcript/debugger compatibility. Current model thinking progress is stored as debug trace artifacts referenced by the final model output, and should not be used as durable external state or model-visible reminder material.

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
