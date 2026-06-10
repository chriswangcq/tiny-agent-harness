# State Storage And File Locking Design

本文记录 tiny-agent-harness 第一版 CLI 状态目录、文件写锁和跨 CLI 并发规则。

## Decision

Agent 从某个项目目录启动。默认情况下，所有 harness CLI 都把状态写在 home-scoped project store 下：

```text
~/.tiny-agent/projects/<projectId>/
  project.json
  locks/
  runs/
  skills/
  launcher/
tmp/
```

Provider credentials 和默认模型配置不属于 project state，放在用户级 runtime config：

```text
~/.tiny-agent/config.json
```

该文件建议权限为 `0600`。`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 和 `MODEL_NAME` 只作为一次性环境变量 override。

`<projectId>` 由项目根目录 basename 和项目根绝对路径 sha256 短 hash 确定，例如 `tiny-agent-harness-4f2a1b7c9e01`。这样 runtime 状态不污染源码目录，同时同一项目的 `tiny-agent`、`im`、`skill`、`tui`、`mcp` 和 `team` 仍看到同一套状态。

当前实现进一步把 run 产生的可变状态全部收敛到 `runs/<runId>/`：IM inbox/outbox、environment events、PTY session log、skill-runs、model context 和 debug artifacts 都随 run 自包含。项目级目录只保留共享 skill definitions、run 容器、启动器日志、锁和临时文件。

## State Root Resolution

所有 CLI 必须使用同一个 `StateRootResolver`。

解析顺序：

1. 如果传入 `--state-dir <path>`，使用该目录。
2. 如果存在环境变量 `TAH_STATE_DIR`，使用该目录。
3. 否则从当前工作目录向上寻找项目根标记（`.git` 或 `package.json`），计算稳定 `projectId`，使用 `~/.tiny-agent/projects/<projectId>/`。

Resolver 不自动发现、读取或迁移项目内 `.tiny-agent/project.json`。旧 repo-local state 应删除或人工归档；`--state-dir` 只用于测试、调试或明确指定的新 state root。

`project.json` 是 state root 的 identity 文件：

```json
{
  "schemaVersion": 1,
  "projectId": "tiny-agent-harness-4f2a1b7c9e01",
  "projectRoot": "/absolute/path/to/project",
  "stateMode": "home-project",
  "createdAt": "2026-05-25T12:00:00.000Z",
  "updatedAt": "2026-05-25T12:00:00.000Z"
}
```

规则：

- CLI 输出给 agent 的路径可以使用绝对 state-root 路径，方便 TUI 或外部工具直接打开。
- PTY 内 `TAH_STATE_DIR` 等于当前 run dir，用于 MCP 等 run-scoped CLI；`TAH_PROJECT_STATE_DIR` 等于 home project state root，用于 team lifecycle/reaper 等跨 run 控制面。
- 不同项目不能共享同一个 state root，除非用户显式传 `--state-dir`。

## CLI Surface

第一版需要 build 的 CLI：

```text
tiny-agent       # run orchestrator, agent run state, terminal/session tool execution
tiny-agent ui    # one-command launcher: start/resume run and attach TUI
tiny-agent tui   # transcript / state player
im               # local mock user-message transport
skill            # local skill discovery, run, close, review-complete
mcp              # local MCP registry/call CLI, invoked through terminal/session tools
codeq            # local code intelligence query CLI, invoked through terminal/session tools
```

不需要 build 成独立 CLI 的部分：

```text
PTY session controls   # 模型通过 session_* tool call 内部调用，不是用户命令
memory                 # 第一版不是核心路径
sub-agent runtime       # 当前只有纯 domain/FSM，不独立调度子进程
```

需要访问 harness 状态的 CLI 支持：

```text
--json
--state-dir <path>
```

错误输出规则：

- 正常结果写 stdout。
- 结构化错误写 stderr。
- 失败时 exit code 非 0。
- 如果 `--json` 开启，stdout/stderr 都输出单行 JSON 或 JSONL，不输出人类解释性前缀。

## Canonical Directory Layout

```text
~/.tiny-agent/projects/<projectId>/
  project.json

  locks/
    project.lock/
    runs.latest.lock/
    run-<runId>.lock/
    run-<runId>.transcript.lock/
    run-<runId>.environment.events.lock/
    run-<runId>.im-channel-<channel>.lock/
    run-<runId>.skill-run-<skillRunId>.lock/
    run-<runId>.mcp-registry.lock/
    session-<sessionId>.lock/
    skills.registry.lock/

  runs/
    latest.json
    run-2026-05-25T12-00-00-abc123/
      state.json
      transcript.jsonl
      session.json

      im/
        default.inbox.jsonl
        default.outbox.jsonl
        cursors/
          default.cursor

      environment/
        events.jsonl

      sessions/
        default-37a8eec1ce.log
        server-4c1f3b8d2a.log

      skill-runs/
        skillrun-2026-05-25-001/
          state.json
          execution.txt
          review-task.txt

      debug/
        prompts/
          step-0000-thinking.prompt.txt
        thinking/
          step-0000-thinking.trace.txt

      mcp-servers.json

  skills/
    coding-review/
      SKILL.md
      skill.json
      attachments/
        lessons.md

  launcher/
    ui-2026-05-25T12-00-00.log

  tmp/
```

说明：

- `runs/<runId>/state.json` 是 run snapshot。
- `runs/<runId>/transcript.jsonl` 是 run event ledger。
- `runs/<runId>/session.json` 是 `ModelContextSession` snapshot，用于 resume。
- `runs/<runId>/debug/prompts/` 保存由 transcript/model-context 通过 `promptRef` 引用的大 prompt artifact。
- `runs/<runId>/debug/thinking/` 保存 streamed thinking trace artifact；transcript 只保存 `traceRef`。
- `runs/<runId>/environment/events.jsonl` 是本 run 的外部环境事件 ledger。
- `runs/<runId>/im/` 是本 run 的 local mock IM inbox/outbox。
- `runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log` 是完整 raw PTY 输出，observation 只返回一屏 semantic terminal viewport，并通过 `screen.logRef.path` 指向该日志。
- `runs/<runId>/skill-runs/<id>/execution.txt` 和 `review-task.txt` 只给 agent 通过 bash 原生命令读取，不直接塞进 prompt。
- `runs/<runId>/mcp-servers.json` 是可选 run-scoped MCP server registry。

## File Types

状态文件只分三类。

### Snapshot JSON

例如：

```text
project.json
runs/<runId>/state.json
runs/<runId>/session.json
runs/<runId>/skill-runs/<skillRunId>/state.json
runs/<runId>/im/cursors/<channel>.cursor
runs/<runId>/mcp-servers.json
```

写入规则：

1. 获取对应资源写锁。
2. 读取旧 snapshot。
3. 校验 schemaVersion 和当前 version。
4. 写入同目录临时文件。
5. rename 覆盖目标文件。
6. 释放锁。

Snapshot 必须包含：

```ts
type SnapshotMeta = {
  schemaVersion: number;
  version: number;
  updatedAt: string;
};
```

`version` 每次成功写入递增。CLI 如果基于旧 version 更新，必须重新读取后再计算，不能盲写覆盖。

### Append-Only JSONL

例如：

```text
runs/<runId>/transcript.jsonl
runs/<runId>/environment/events.jsonl
runs/<runId>/im/<channel>.inbox.jsonl
runs/<runId>/im/<channel>.outbox.jsonl
```

写入规则：

1. 获取对应 ledger 锁。
2. append 一整行 JSON。
3. flush。
4. 释放锁。

每行必须有稳定 id：

```ts
type LedgerRecord = {
  id: string;
  schemaVersion: number;
  timestamp: string;
};
```

读取方按 `id` 去重。第一版可以允许重复 append，但消费逻辑必须是 idempotent。

### Plain Log

例如：

```text
runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log
runs/<runId>/debug/prompts/<artifact>.txt
runs/<runId>/debug/thinking/<artifact>.txt
runs/<runId>/skill-runs/<skillRunId>/execution.txt
```

写入规则：

- 只有资源 owner 进程可以持续写。
- 不在长时间执行期间持有全局锁。
- 修改 `state.json` 时才短暂获取资源锁。
- reader 可以无锁读取，使用 byte offset 翻页。

Run debug artifacts are write-once files under the run owner. Transcript events should store a small reference with `relativePath`, byte size, and hash instead of embedding the full debug payload.

## Lock Primitive

第一版使用目录锁，不依赖平台专有 flock。

获取锁：

```text
mkdir ~/.tiny-agent/projects/<projectId>/locks/<name>.lock
write ~/.tiny-agent/projects/<projectId>/locks/<name>.lock/owner.json
```

`mkdir` 在本地文件系统上是原子的。创建成功表示拿到锁。

`owner.json`：

```json
{
  "schemaVersion": 1,
  "ownerId": "pid-12345-rand-abcd",
  "pid": 12345,
  "hostname": "local",
  "purpose": "append environment event",
  "createdAt": "2026-05-25T12:00:00.000Z",
  "expiresAt": "2026-05-25T12:00:05.000Z"
}
```

释放锁：

```text
remove owner.json
rmdir ~/.tiny-agent/projects/<projectId>/locks/<name>.lock
```

规则：

- 普通 snapshot / JSONL 写锁 TTL 默认 5 秒。
- 长操作不能长期持有写锁。
- run orchestrator 可以持有 run lease，但要用 heartbeat 刷新 `expiresAt`。
- 如果锁已过期，新的 writer 可以 steal lock：先 rename 到 `<name>.stale.<timestamp>.lock`，再重新 mkdir。
- steal 事件必须写入 transcript 或 environment，方便排查。

## Atomic Write

Snapshot JSON 必须使用同目录临时文件。

```text
state.json.tmp.<ownerId>
```

流程：

```text
serialize next state
write tmp
flush tmp
rename tmp -> state.json
best-effort fsync parent dir
```

不能直接覆盖写 `state.json`，避免进程崩溃留下半个 JSON。

## Resource Ownership

### Run

`tiny-agent` 是单个 run 的唯一 owner。

它负责写：

```text
runs/<runId>/state.json
runs/<runId>/transcript.jsonl
runs/<runId>/session.json
runs/<runId>/debug/
runs/latest.json
```

锁：

```text
run-<runId>.lock
run-<runId>.transcript.lock
runs.latest.lock
```

`run-<runId>.lock` 是 lease。TUI 只读，不抢 run lock。

如果 TUI 看到 run 状态是 `running`，但 run lock lease 已过期，可以展示为 `stale`，但不直接改 run state。

### Bash Session

`tiny-agent` 内部的 ManagedTerminalRuntime 是 session raw log owner。

它负责写：

```text
runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log
```

锁：

```text
session-<sessionId>.lock
```

执行长命令时：

1. 获取 session lock，写 state=`running`。
2. 释放 session lock。
3. 持续写 run-scoped session raw log。
4. 命令完成、超时、interrupt 时，再获取 session lock 更新 state。

这样不会因为一个长命令卡住其它只读 CLI。

### Environment

Environment 是 run-scoped 外部事件 ledger。它统一建模 IM、新用户消息、session 状态变化、skill lifecycle、MCP 状态变化等外部事实；run loop 在每轮 model step 前消费新事件并渲染成 environment reminder。

写入者：

- `im` CLI append `user_message_received`
- ManagedTerminalRuntime append `session_output_changed`、`session_returned_to_prompt`、`session_exited` 等 session 事件
- `skill` CLI append `skill_run_started`、`skill_run_closed`、`skill_review_pending`、`skill_review_completed`
- `mcp` CLI 可 append MCP registry/tool-call 相关事件

文件：

```text
runs/<runId>/environment/events.jsonl
```

锁：

```text
run-<runId>.environment.events.lock
```

消费规则：

1. run loop 以当前 run state/model context 的事件 cursor 为准。
2. 读取 cursor 之后的新 events。
3. 根据 `io_wait.minLevel` / 默认 meaningful 优先级判断是否唤醒；省略 `minLevel` 等价于 `level >= 10`，显式 `minLevel: 0` 才会被低价值 session output 唤醒；用户消息有效 level 为 `100`。
4. 渲染 environment reminder。
5. 写 transcript `environment_events_consumed`。
6. 更新 run state/model context 中的 cursor。

cursor 不能在 reminder 入 transcript 之前提前移动。`io_wait` 统一采用优先级等待口径：窄 wait 也能被更高 level 的用户消息打断，避免用户发来的新指令卡在下一轮之外。

### IM

`im` CLI 负责本地 mock channel。

文件：

```text
runs/<runId>/im/<channel>.inbox.jsonl
runs/<runId>/im/<channel>.outbox.jsonl
runs/<runId>/im/cursors/<channel>.cursor
```

锁：

```text
run-<runId>.im-channel-<channel>.lock
```

`im post --run latest` 会写入最新 run 的 IM inbox；如果 PTY 已注入 `TAH_IM_DIR`，agent 在 shell 里执行 `im send/recv` 会自动落到当前 run。`im listen` 不能长期持锁。它只能循环短暂读文件，然后 sleep / wait。

### Skill

`skill` CLI 负责 skill discovery 和 skill run lifecycle。

文件：

```text
runs/<runId>/skill-runs/<skillRunId>/state.json
runs/<runId>/skill-runs/<skillRunId>/execution.txt
runs/<runId>/skill-runs/<skillRunId>/review-task.txt
skills/<skill>/attachments/lessons.md
```

锁：

```text
run-<runId>.skill-run-<skillRunId>.lock
skills.registry.lock
```

`skill run` 不长期持 `skill-run` 写锁：

1. 获取锁创建 state=`running`。
2. 释放锁。
3. 执行 skill entry 并写 execution log。
4. 获取锁写 returnCode / status。
5. append environment event。

`review-complete` 需要同时写 skill run state 和 lessons。

加锁顺序必须固定，避免死锁：

```text
run-<runId>.skill-run-<id>.lock -> skills.registry.lock -> run-<runId>.environment.events.lock
```

其它地方也遵循同一原则：先具体资源锁，再 ledger 锁。

### MCP Registry

`mcp` CLI 负责 run-scoped MCP server registry 和 MCP tool invocation。它不是 model-visible provider tool；agent 只能通过 PTY 中的 `mcp ...` 命令使用它。

文件：

```text
runs/<runId>/mcp-servers.json
```

锁：

```text
run-<runId>.mcp-registry.lock
run-<runId>.environment.events.lock
```

`mcp add/remove/list/tools/call` 读取 `TAH_STATE_DIR`。在 agent PTY 内，`TAH_STATE_DIR` 等于当前 run dir，因此 registry 默认随 run 打包；人工调试可以显式传 `--state-dir`。

## Deadlock Avoidance

统一规则：

1. 不在持锁期间调用模型。
2. 不在持锁期间执行 bash 长命令。
3. 不在持锁期间等待 IM 新消息。
4. 不在持锁期间调用 skill entry。
5. 多锁场景必须按固定顺序。

全局锁顺序：

```text
project.lock
run/session/skill/im resource lock
registry/cursor lock
ledger lock
latest pointer lock
```

如果无法在 `lockTimeoutMs` 内拿到锁，CLI 返回结构化错误：

```json
{
  "ok": false,
  "error": {
    "code": "LOCK_TIMEOUT",
    "message": "Could not acquire lock session-default.lock",
    "lock": "~/.tiny-agent/projects/<projectId>/locks/session-default.lock"
  }
}
```

默认：

```json
{
  "lockTimeoutMs": 5000,
  "lockRetryIntervalMs": 50,
  "staleLockTtlMs": 5000
}
```

## Crash Recovery

启动 `tiny-agent` 时做轻量恢复：

1. 扫描 `locks/`，标记过期锁。
2. 如果某个 run state 是 `running` 但 run lease 过期，TUI 展示 `stale`。
3. 如果某个 session state 是 `running` 但 owner run 已 stale，标记 session `terminated`，原因 `owner_lost`。
4. 如果某个 skill run 长期 `running` 且没有 owner，可以由 `skill status --active --json` 报告 `staleCandidate: true`，但不自动 close。

第一版不要自动删除 state。只 append recovery event 或更新明确 owner_lost 的 snapshot。

## Implementation Order

建议先实现公共基础模块：

```text
src/state/root.ts       # StateRootResolver
src/state/lock.ts       # directory lock + stale lock handling
src/state/atomic.ts     # atomic JSON write
src/state/jsonl.ts      # locked append/read by offset
```

然后按这个顺序接 CLI：

1. `im`：最小 JSONL inbox/outbox，验证锁和 append。
2. `skill`：接 state root、skill-run lock、environment event。
3. `tiny-agent`：接真实 file-backed Environment、run lease、latest pointer。
4. `tiny-agent tui`：只读 state，不拿写锁。

这个顺序能最快验证文件锁，因为 `im post`、`skill run`、`tiny-agent` 会同时写 environment ledger。

## Non Goals

第一版不做：

- sqlite
- daemon
- distributed lock
- network filesystem correctness
- 多机器共享同一个 state root
- 自动压缩或删除历史 transcript

这些都可以后续加，但第一版先把文件边界、写锁和状态 owner 定清楚。
