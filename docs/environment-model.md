# Environment Model Design

本文记录 tiny-agent-harness 第一版 environment 建模。

## Decision

Environment 是 Agent 之外的最新环境事件模型。

它统一接收和存储外部事件，例如：

- IM 新用户消息
- bash session 状态切换
- bash command 完成、超时、被中断

Agent loop 不直接轮询每个外部系统。每轮 loop 开始时，orchestrator 从 Environment 消费新事件，把它们渲染成 system reminder，可以包在 user message / model context 里。

`io_wait` 也不直接等待 IM。它等待 Environment 中出现满足条件的事件。

## Responsibilities

```text
Environment
  owns: latest external environment events
  owns: event cursors / consumed offsets
  exposes: appendEvent(), consumeSince(), waitFor()

ImCliTransport
  owns: IM CLI IO
  emits: environment event user_message_received

BashSessionManager
  owns: bash session runtime
  emits: environment events session_state_changed, command_finished, command_timed_out

RunOrchestrator
  owns: consume environment events at loop boundary
  owns: render events into system reminder
  owns: wait_io by waiting on Environment.waitFor(...)
```

Important split:

```text
External systems emit EnvironmentEvent.
AgentRunState waits for EnvironmentEvent.
Model sees consumed events as reminders, not as hidden mutable state.
```

## Environment Event

```ts
type EnvironmentEvent =
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
```

Environment keeps recent events. First version can use an append-only in-memory list plus transcript persistence.

## Environment State

```ts
type EnvironmentState = {
  latestEventId?: string;
  events: EnvironmentEvent[];
  consumedByRun: Record<string, string | undefined>;
};
```

`consumedByRun[runId]` stores the last environment event consumed into that run's model context.

This prevents the same IM message or session state transition from being repeated forever as a reminder.

## Consuming Events As Reminder

At the start of each model step:

```text
events = environment.consumeSince(runId)
reminder = renderEnvironmentReminder(events)
context.messages.push({ role: "system", content: reminder })
```

The reminder can also be wrapped as a user-context message if the provider path prefers that shape.

Example:

```text
Environment reminder:
- New user message on channel default: "continue with option B"
- Session server changed from running to idle.
- Command cmd-123 finished in session test with return code 1. Log: .tiny-agent/sessions/test.log
```

This is not a new tool. It is context.

## IO Wait

`io_wait` waits for EnvironmentEvent.

```ts
type IoWaitRequest = {
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
```

First version may only support:

```ts
{
  kind: "new_user_message";
  channel: "default"
}
```

But implementation should route it through Environment:

```text
io_wait(new_user_message)
  -> ImCliTransport waits for IM
  -> Environment.appendEvent(user_message_received)
  -> Environment.waitFor(...) resolves
  -> RunState records io_wait_satisfied
  -> next model step consumes that event as reminder
```

## Wait Semantics

```ts
type EnvironmentPort = {
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
```

`waitFor` resolves with the first matching event. It does not call the model and does not execute bash while waiting.

## Transcript Events

Environment events are also recorded in transcript:

```ts
type EnvironmentRunEvent =
  | {
      type: "environment_event_recorded";
      event: EnvironmentEvent;
      timestamp: string;
    }
  | {
      type: "environment_events_consumed";
      runId: string;
      eventIds: string[];
      timestamp: string;
    };
```

## Minimal First Implementation

1. Add `EnvironmentEvent` types.
2. Add in-memory `Environment` with append / consume / waitFor.
3. IM new message produces `user_message_received`.
4. Bash session manager produces session state events when practical.
5. Prompt/FIM context includes a compact environment reminder.
6. `io_wait` waits on environment, not directly on IM.

Defer:

- durable environment database
- cross-run subscriptions
- complex event predicates
- multiple wait conditions
- long-term memory promotion
