# Public IM Design

本文记录当前 public IM 契约。IM 不再使用 run 内部的双文件收发目录，而是 project-scoped 服务：endpoint pair 决定通信双方，directional channel log 保存消息，run binding 决定某个 run 要监听哪些 pair。

## Decision

```text
endpoint pair
  -> directional channels
  -> channel messages.jsonl
  -> per-consumer cursor
  -> optional run binding
```

Run 是 IM 的使用者，不是 IM 的 owner。TUI、team member endpoint、外部用户和 agent endpoint 都可以注册 endpoint pair；一个 run 可以绑定多个 pair，例如 `a2user` 和 `a2a`。

## Endpoint Shape

Endpoint 是稳定字符串：

```text
user:main
run:<runId>
member:<teamId>/<memberId>
agent:<name>
```

`tiny-agent run` 默认创建并绑定：

```text
self = run:<runId>
peer = user:main
kind = a2user
```

PTY 中会注入：

| 环境变量 | 含义 |
| --- | --- |
| `TAH_RUNTIME_HOST_SOCKET` | 当前 run 的 runtime replica socket；普通 `tiny-agent im ...` 必须通过它调用 |
| `TAH_IM_RUN_ID` | 当前 run id |
| `TAH_IM_SELF_ENDPOINT` | 当前 run 回复时使用的 endpoint |
| `TAH_IM_USER_ENDPOINT` | 默认用户 endpoint，当前为 `user:main` |

Agent 回复用户时使用 stdin payload：

```bash
tiny-agent im send --kind status --text-stdin <<'IM'
Done.
IM
```

## CLI

普通 `tiny-agent im ...` 是 runtime-replica socket client。它从 `TAH_RUNTIME_HOST_SOCKET` 连接当前 run own 的 runtime replica；CLI 在 run PTY 边界用 `TAH_IM_RUN_ID`、`TAH_IM_SELF_ENDPOINT` 和 `TAH_IM_USER_ENDPOINT` 显式补齐 `runId/from/to/as/with/peer` 字段。runtime replica 不保存某个 run 的默认 endpoint 上下文。缺少 runtime socket 时普通命令必须失败，不能回退到文件读写。

Agent 在 PTY 内发送回复：

```bash
tiny-agent im send --kind status --text-stdin < reply.md
tiny-agent im recv --cursor <messageId>
tiny-agent im ack --message-id <messageId>
tiny-agent im run-recv
tiny-agent im run-ack --message-id <messageId> --peer user:main
```

外部/TUI/bootstrap/debug 边界需要先启动 edge runtime replica，再把它的 socket 显式传给 `tiny-agent im ...`。创建或读取 endpoint pair：

```bash
tiny-agent runtime replica --mode edge --edge-id operator --socket /tmp/ta-rh/operator-runtime.sock --state-dir <project-state>
tiny-agent im pair --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --a user:main --b run:run-123 --kind a2user
```

把 run 绑定到 pair：

```bash
tiny-agent im bind --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --run-id run-123 --self run:run-123 --peer user:main --kind a2user
```

外部用户或 TUI 注入消息：

```bash
tiny-agent im post --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --from user:main --to run:run-123 --text "fix the failing tests"
```

按 pair 读取：

```bash
tiny-agent im recv --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --as run:run-123 --with user:main --cursor <messageId>
tiny-agent im ack --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --as run:run-123 --with user:main --message-id <messageId>
```

按 run binding 读取：

```bash
tiny-agent im run-recv --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --run-id run-123
tiny-agent im run-ack --runtime-host-socket /tmp/ta-rh/operator-runtime.sock --run-id run-123 --peer user:main --message-id <messageId>
```

`receive` 不是一个隐藏的进程内队列。它读取 append-only channel log，并返回 cursor 之后的消息；`ack` 把 consumer cursor 推进到指定 message id。TUI 可以用 projection-safe read 查看 channel log，而不消费 run 的 cursor。

## Storage

```text
~/.tiny-agent/projects/<projectId>/
  im/
    endpoints/
      <endpointId>.json
    pairs/
      <pairId>.json
    channels/
      <channelId>/
        meta.json
        messages.jsonl
        cursors/
          <consumerId>.cursor
    run-bindings/
      <runId>.json
```

Channel id 由 endpoint direction 的稳定 key 派生。两个 endpoint pair 会有两个 directional channel：`a => b` 和 `b => a`。消息只 append 到发送方向的 `messages.jsonl`；每个 consumer 独立维护 cursor。

Writes are serialized with directory locks under `locks/`: pair metadata uses `im-pair-<pairId>`, channel metadata and message append use `im-channel-<channelId>`, run bindings use `im-run-binding-<runId>`, and cursor acks use `im-cursor-<channelId>-<consumerId>`. Snapshot-style IM files and cursors are written with temp-file rename; readers can stay lock-free because they only observe either the old file or the new file. Message-log readers also stay lock-free: they parse complete JSONL lines and ignore a trailing incomplete line from an in-flight append.

## Runtime Flow

1. Run startup 启动 run-owned `tiny-agent runtime replica --mode run --run-id <runId> --socket <run-socket>`，然后通过该 replica 创建默认 endpoint pair 和 run binding。
2. TUI 或用户端启动 edge runtime replica，并调用 `tiny-agent im post --runtime-host-socket <edge-socket> --from user:main --to run:<runId>`。
3. Run poller 通过 runtime replica 调用 `run-recv` 读取所有绑定 pair 的新用户消息。
4. Poller 把 user message 转成 `EnvironmentEvent(user_message_received)`。
5. Agent 通过 terminal session 执行 host-backed `tiny-agent im send --kind status --text-stdin` 回复。
6. TUI 通过 projection-safe channel read 显示 user/agent 消息，不推进 run cursor。

## Design Rules

- IM 是 project-scoped public service，不能重新放回 run-scoped directory。
- Run binding 是索引，不是消息存储。
- 外部 `im post/send` 必须显式携带 `--runtime-host-socket`、`from` 和 `to` endpoint；PTY 内普通 `im send` 在 CLI client 边界从 run PTY env 显式补齐 endpoint。
- `receive` 返回 cursor 之后的消息；`ack` 显式推进 cursor。
- TUI/read-only projections 不消费 run cursor。
- Agent 回复必须用 `--text-stdin`，不要把长正文塞进 shell argument。
