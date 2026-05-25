# IM CLI Transport Design

本文记录 tiny-agent-harness 第一版用户消息收发方案。

## Decision

用户消息收发通过一个 IM CLI 处理，不把 stdin/stdout 作为主交互通道。

```text
User
  -> im CLI
  -> UserMessageTransport
  -> RunOrchestrator
  -> Agent
  -> UserMessageTransport
  -> im CLI
  -> User
```

这里的 IM 是 harness 的用户通信边界，不是 Agent 可调用的业务工具。Agent 的外部动作仍然只有 `bash`。

## Responsibilities

```text
ImCliTransport
  owns: receive user messages through im CLI
  owns: send agent messages through im CLI
  owns: message cursor / ack

RunOrchestrator
  owns: when to receive initial task
  owns: when to send final/status messages

AgentRunState
  owns: recorded user messages as run events
```

The split:

```text
User communication is an orchestrator port.
Bash remains the only model-visible tool.
```

## CLI Shape

第一版可以实现一个本地 mock IM CLI，后续再接真实 IM。

Recommended command shape:

```bash
im recv --channel default --cursor <cursor> --json
im send --channel default --kind status --text "Working..."
im send --channel default --kind final --text "Done."
im ack --channel default --message-id <id>
```

For interactive local demos:

```bash
im post --channel default --from user --text "fix the failing test"
im listen --channel default
```

`post` and `listen` are demo helpers. The harness itself only needs `recv`, `send`, and `ack`.

## Message Schema

Incoming user message:

```ts
type UserMessage = {
  id: string;
  channel: string;
  role: "user";
  text: string;
  createdAt: string;
  metadata?: Record<string, string>;
};
```

Outgoing agent message:

```ts
type AgentMessage = {
  channel: string;
  role: "agent";
  kind: "status" | "final" | "error";
  text: string;
  runId?: string;
  createdAt: string;
  metadata?: Record<string, string>;
};
```

`kind=status` is optional progress output. `kind=final` is the answer when the run completes.

## Transport Port

```ts
type UserMessageTransport = {
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
};

type ReceivedUserMessages = {
  messages: UserMessage[];
  nextCursor?: string;
};
```

The first implementation can use child-process calls to the `im` CLI.

## Run Startup

There are two supported startup modes:

```bash
tiny-agent run --channel default
```

This waits for the next user message from IM and starts a run from it.

```bash
tiny-agent run --channel default --task "fix the failing test"
```

This is a convenience path for tests and demos. It should still record the task as a user message event.

## Run Events

```ts
type UserMessageEvent =
  | {
      type: "user_message_received";
      runId: string;
      message: UserMessage;
      timestamp: string;
    }
  | {
      type: "agent_message_sent";
      runId: string;
      message: AgentMessage;
      timestamp: string;
    };
```

These events go into `transcript.jsonl` with the rest of the run events.

## In-Run Messages

First version:

- read one initial user task
- run until final / failed / cancelled
- send final or error

Defer multi-message live chat during a run.

Future support can poll IM at step boundaries:

```text
after each observation
  -> im recv --cursor ...
  -> if cancel message: cancel run
  -> if follow-up message: append to run context
```

## Local Mock Storage

For demo, `im` can be backed by local JSONL files:

```text
.tiny-agent/
  im/
    default.inbox.jsonl
    default.outbox.jsonl
    cursors/
      tiny-agent-default.cursor
```

This keeps the project self-contained while preserving the future shape of a real IM connector.

## Error Handling

If `im recv` fails before a run starts:

```text
run does not start
CLI exits with error
```

If `im send final` fails after a run completes:

```text
run remains completed
delivery failure is recorded as agent_message_send_failed
CLI returns non-zero
```

Sending user-visible messages is outside Agent reasoning. It should not be retried by asking the model what to do.

## Non Goals

First version does not need:

- rich media
- multiple users in one channel
- human approval UI
- async push notifications
- real Slack/Discord/WeChat integration

The goal is only to avoid baking stdin/stdout into the core harness.
