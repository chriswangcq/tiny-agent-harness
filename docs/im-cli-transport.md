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

这里的 IM 是 harness 的用户通信边界，不是 Agent 可调用的业务工具。Agent 通过 `bash` 中的 IM CLI 发送消息；需要暂存大段准备内容时，可先用 `stash_file`，但最终发送仍要经过 PTY 可见的 CLI。

## Responsibilities

```text
ImCliTransport
  owns: receive user messages through im CLI
  owns: send agent messages through im CLI
  owns: message cursor / ack

RunOrchestrator
  owns: when to receive initial task
  owns: when to send status/error messages

AgentRunState
  owns: recorded user messages as run events
```

The split:

```text
User communication is an orchestrator port.
Bash remains the PTY-visible delivery path; `stash_file` may stage prepared file/message payloads before a bash CLI materializes or sends them.
```

## CLI Shape

第一版可以实现一个本地 mock IM CLI，后续再接真实 IM。

Recommended command shape:

```bash
im recv --channel default --cursor <cursor> --json
im send --channel default --kind status --text-stdin
im ack --channel default --message-id <id>
```

In the PTY agent flow, `--text-stdin` is the required stdin path for all agent-authored replies. A quoted heredoc is only for simple short phrases, e.g. `im send --kind status --text-stdin <<'IM' ... IM`. For longer Markdown, Chinese/emoji-heavy content, tables, generated reports, or multiline summaries, write or materialize a reply file and send it with input redirection: `im send --kind status --text-stdin < reply.md`. `--text` remains a CLI convenience for humans and scripts, but the agent should not use it.

For interactive local demos:

```bash
im post --channel default --from user --text "fix the failing test"
im listen --channel default
```

`post` and `listen` are demo helpers. `post` only injects user-authored inbox messages; agent-visible replies must use `send` so they go to outbox and cannot be consumed again as user input. Reserved sender labels such as `assistant`, `agent`, `system`, and `tool` are rejected for `post`.

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
  kind: "status" | "error";
  text: string;
  runId?: string;
  createdAt: string;
  metadata?: Record<string, string>;
};
```

`kind=status` covers both optional progress output and user-facing task replies. `kind=error` is used when the harness cannot deliver normal progress or completion information.

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

  pollNewMessages(options: {
    channel: string;
    cursor?: string;
    waitMs?: number;
  }): Promise<UserMessage[]>;
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
- allow the Agent to submit `io_wait` for a new user message
- while in `waiting_for_io`, do not call the model or execute bash
- resume the Agent loop when the wait condition is satisfied
- run until completed / failed / cancelled
- send status or error

Defer multi-message live chat during a run.

Future support can poll IM at step boundaries:

```text
after each observation
  -> im recv --cursor ...
  -> if cancel message: cancel run
  -> if follow-up message: append to run context
```

## IO Wait

`io_wait` is an internal AgentRunState decision, not a bash tool. IM is one event source for Environment.

First version supports only this condition:

```ts
type IoWaitRequest = {
  reason?: string;
  condition: {
    kind: "new_user_message";
    channel: string;
    cursor?: string;
  };
};
```

Suggested CLI behavior:

```bash
im recv --channel default --cursor <cursor> --json --wait
```

When a new message arrives:

1. `ImCliTransport` returns `UserMessage`.
2. Orchestrator appends `EnvironmentEvent { kind: "user_message_received", source: "im" }`.
3. `Environment.waitFor(...)` resolves the pending IO wait.
4. Run state records `io_wait_satisfied`.
5. The next FIM step consumes the environment event as a system reminder.

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

If the completion `im send --kind status` delivery fails after a run completes:

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
