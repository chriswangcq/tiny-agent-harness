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

这里的 IM 是 harness 的用户通信边界，不是 Agent 可调用的业务工具。Agent 通过 PTY 中的 IM CLI 发送消息；大段准备内容也应先通过普通 shell 文件、heredoc 或 stdin redirection 处理，最终发送仍要经过 PTY 可见的 CLI。

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
Terminal/session tools remain the PTY-visible delivery path; prepared file/message payloads are handled through shell-native files, heredocs, stdin redirection, and IM CLI commands.
```

## CLI Shape

第一版可以实现一个本地 mock IM CLI，后续再接真实 IM。

Recommended command shape:

```bash
im recv --channel default --cursor <cursor> --json
im send --channel default --kind status --text-stdin
im ack --channel default --message-id <id>
im post --channel default --run latest --from user --text "fix the failing test"
```

In the terminal/session agent flow, `--text-stdin` is the required stdin path for all agent-authored replies. A quoted heredoc is valid for normal text replies, including Markdown, Chinese/emoji-heavy content, tables, generated reports, and multiline summaries, e.g. `im send --kind status --text-stdin <<'IM' ... IM`. Input redirection (`im send --kind status --text-stdin < reply.md`) remains valid when it makes the command simpler. `--text` remains a CLI convenience for humans and scripts, but the agent should not use it.

For interactive local demos:

```bash
im post --channel default --from user --text "fix the failing test"
im listen --channel default
```

`post` and `listen` are demo helpers. `post` only injects user-authored inbox messages; agent-visible replies must use `send` so they go to outbox and cannot be consumed again as user input. Reserved sender labels such as `assistant`, `agent`, `system`, and `tool` are rejected for `post`.

Path resolution:

- `im ... --run latest` writes to `~/.tiny-agent/projects/<projectId>/runs/<latestRunId>/im/` for the current project.
- Inside an agent PTY, `TAH_IM_DIR` is injected, so `im send/recv` defaults to the current run.
- If neither run nor `TAH_IM_DIR` exists, the CLI falls back to project-level `~/.tiny-agent/projects/<projectId>/im/` for pre-run demos.

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

Current version:

- 用户消息不是特殊的 “main message”，而是 environment 的高优先级事件。
- run 启动时的初始 task 也记录为 `user_message_received` / environment event。
- agent 每轮只消费 environment event reminder；用户、PTY、skill、MCP 都是环境的一部分。
- agent 可主动提交 `io_wait` 等待后续环境事件。
- while in `waiting_for_io`, do not call the model or execute terminal actions。
- 任意满足 `minLevel` 的新 environment event 都可以唤醒 wait；用户消息默认 level `100`。
- keep the run alive across user-visible replies by sending status through `im send` and then returning to `io_wait`。
- stop only on failed or cancelled run state。
- send error details when the run fails。

## IO Wait

`io_wait` is an internal AgentRunState decision, not a terminal/session tool. IM is one event source for Environment.

The run-state wait is priority-based:

```ts
type IoWaitRequest = {
  reason?: string;
  minLevel?: number;
};
```

User messages are `EnvironmentEvent { kind: "user_message_received", source: "im" }` with effective level `100`, so they wake every normal `io_wait`.

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
~/.tiny-agent/projects/<projectId>/
  runs/
    <runId>/
      im/
        default.inbox.jsonl
        default.outbox.jsonl
        cursors/
          default.cursor
```

Pre-run fallback:

```text
~/.tiny-agent/projects/<projectId>/
  im/
    default.inbox.jsonl
    default.outbox.jsonl
    cursors/
      default.cursor
```

The run-scoped path is the normal agent path. The fallback exists only for explicit demos before any run is available.

## Error Handling

If `im recv` fails before a run starts:

```text
run does not start
CLI exits with error
```

If a user-visible `im send --kind status` delivery fails:

```text
run records a recoverable observation or fails according to the calling boundary
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
