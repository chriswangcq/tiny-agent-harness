# Environment Model Design

本文记录 tiny-agent-harness 第一版 environment 建模。

## Decision

Environment 是 Agent 之外的最新环境事件模型。

它统一接收和存储外部事件，例如：

- IM 新用户消息
- bash session 状态切换
- bash command 完成、超时、被中断
- skill run started / closed / review pending / review completed

Agent loop 不直接轮询每个外部系统。每轮 loop 开始时，orchestrator 从 Environment 消费新事件，把它们渲染成 environment reminder / model context。

本 harness 不设长期存在的 `User` 主消息。用户本人也是 Environment 的一部分：IM 输入会先成为 `user_message_received` 事件，再被投影进模型上下文。新鲜的用户消息事件代表当前用户意图，但它仍然通过 Environment 通道进入，而不是另开一个特殊的主消息入口。

`io_wait` 也不直接等待 IM。它等待 Environment 中出现满足条件的事件。

除了事件，Environment 还可以提供 persistent reminder facts。事件是一次性的，消费后不重复；persistent facts 会每轮重复渲染，直到状态关闭。Active skill run 就属于 persistent fact。

## Responsibilities

```text
Environment
  owns: latest external environment events
  owns: event cursors / consumed offsets
  owns: persistent reminder facts such as active skill runs
  exposes: appendEvent(), consumeSince(), waitFor()

ImCliTransport
  owns: IM CLI IO
  emits: environment event user_message_received

BashSessionManager
  owns: bash session runtime
  emits: environment events session_state_changed, command_finished, command_timed_out

Skill CLI / SkillRunStore
  owns: active skill run state
  emits: environment events skill_run_started, skill_run_closed, skill_review_pending, skill_review_completed
  exposes: listActiveSkillRuns()

RunOrchestrator
  owns: consume environment events at loop boundary
  owns: render one-shot events and persistent facts into environment context
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
    }
  | {
      id: string;
      kind: "skill_run_started" | "skill_run_closed" | "skill_review_pending" | "skill_review_completed";
      source: "skill";
      timestamp: string;
      skillRunId: string;
      skill: string;
      statePath: string;
      executionLogPath?: string;
      reviewTaskPath?: string;
      lessonsPath?: string;
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
context.messages.push({ role: "latest_reminder", content: reminder })
```

The reminder is rendered as environment context, not as a persistent User main message.

Consumption rules:

1. Consume only events after the run's last consumed environment cursor.
2. Do not repeat already consumed events in later model steps.
3. If no new events exist, do not add an empty reminder.
4. Update `consumedByRun[runId]` only after the reminder is appended to the model context and the corresponding transcript event is written.
5. `io_wait_satisfied` events are not special-cased; the matching EnvironmentEvent is consumed by the next model step like every other environment event.

This keeps Environment as the source of facts and prevents duplicated reminders.

## Persistent Reminder Facts

Not every reminder is an event.

Environment events answer: "What changed since the last model step?"

Persistent reminder facts answer: "What is still true and should remain in the model's attention?"

Active skill runs are persistent facts:

```ts
type PersistentReminderFact =
  | {
      kind: "active_skill_run";
      skillRunId: string;
      skill: string;
      status: "running" | "review_pending";
      executionReturnCode?: number;
      executionLogPath: string;
      reviewTaskPath?: string;
    };
```

Rendering rules:

1. Render persistent facts after one-shot environment events.
2. Render active skill runs every model step while status is `running` or `review_pending`.
3. Stop rendering when status becomes `closed`.
4. Do not advance the environment event cursor for persistent facts; they are state snapshots, not consumed events.
5. Do not include full execution logs or review task bodies. Include paths so the agent can inspect them through bash.

Example:

```text
Active skill reminder:
- [skillrun-2026-05-25-001] skill=coding-review status=running rc=0 log=.tiny-agent/skill-runs/skillrun-2026-05-25-001/execution.txt
- [skillrun-2026-05-25-002] skill=debugging status=review_pending task=.tiny-agent/skill-runs/skillrun-2026-05-25-002/review-task.txt
```

## Event Cropping Rules

Environment events can grow without bound, but FIM context cannot.

First version uses a compact event budget:

```ts
type EnvironmentReminderPolicy = {
  maxEventsPerStep: number;       // default: 20
  maxCharsPerEvent: number;       // default: 500
  maxReminderChars: number;       // default: 4000
  overflowStrategy: "oldest_summary_newest_detail";
};
```

Recommended defaults:

```json
{
  "maxEventsPerStep": 20,
  "maxCharsPerEvent": 500,
  "maxReminderChars": 4000,
  "overflowStrategy": "oldest_summary_newest_detail"
}
```

Cropping order:

1. Sort events by environment order, oldest to newest.
2. Keep the newest `maxEventsPerStep` events.
3. Render each event with `maxCharsPerEvent`.
4. If the full reminder still exceeds `maxReminderChars`, keep detailed newest events and summarize older events by count and kind.
5. Always preserve identifiers, session ids, return codes, log paths, channel names, and timestamps when present.
6. Never include large bash output bodies in the reminder. Include log paths and offsets instead.

Example overflow line:

```text
- 12 older environment events omitted: 8 session_state_changed, 3 command_finished, 1 user_message_received.
```

Full event details remain in transcript / environment storage. The reminder is only a compact view.

## Reminder Render Rules

The reminder is concise, factual, and explicitly labeled as environment state.

Format:

```text
Environment reminder:
- [env-001] 2026-05-25T12:00:00Z im user_message_received channel=default text="continue with option B"
- [env-002] 2026-05-25T12:00:03Z bash session_state_changed session=server running -> idle
- [env-003] 2026-05-25T12:00:04Z bash command_finished session=test command=cmd-123 rc=1 log=.tiny-agent/sessions/test.log
```

Rendering by event kind:

```text
user_message_received:
  im user_message_received channel=<channel> text="<truncated text>"

session_state_changed:
  bash session_state_changed session=<session> <previousState> -> <nextState>

command_finished:
  bash command_finished session=<session> command=<commandId> rc=<returnCode> log=<outputLogPath>

command_timed_out:
  bash command_timed_out session=<session> command=<commandId> log=<outputLogPath>
```

The reminder should not contain instructions, guesses, or policy. It is environment facts only.

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
