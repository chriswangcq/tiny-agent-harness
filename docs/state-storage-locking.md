# State Storage And File Locking Design

本文记录 tiny-agent-harness 第一版 CLI 状态目录、文件写锁和跨 CLI 并发规则。

## Decision

Agent 从某个项目目录启动。默认情况下，所有 harness CLI 都把状态写在该项目下的 `.tiny-agent/`。

```text
project/
  .tiny-agent/
    project.json
    locks/
    runs/
    sessions/
    environment/
    im/
    skills/
    skill-runs/
    tmp/
```

这样 demo 最简单：用户 `cd` 到项目目录，`tiny-agent`、`im`、`skill`、`tui` 看到的是同一套状态。

后续可以兼容 Claude Code 风格的 home cache：

```text
~/.tiny-agent/projects/<projectHash>/
```

但第一版不默认使用 home cache。原因是本项目的核心目标是一个完全操作 bash 的 agent harness，项目内状态更容易被 agent 用 bash 原生命令检查、分页、grep 和调试。

## State Root Resolution

所有 CLI 必须使用同一个 `StateRootResolver`。

解析顺序：

1. 如果传入 `--state-dir <path>`，使用该目录。
2. 如果存在环境变量 `TAH_STATE_DIR`，使用该目录。
3. 从当前工作目录向上查找 `.tiny-agent/project.json`，找到后使用对应 `.tiny-agent/`。
4. 如果找不到，在当前工作目录创建 `.tiny-agent/`。

`project.json` 是 state root 的 identity 文件：

```json
{
  "schemaVersion": 1,
  "projectId": "proj-2026-05-25-001",
  "projectRoot": "/absolute/path/to/project",
  "stateMode": "project-local",
  "createdAt": "2026-05-25T12:00:00.000Z",
  "updatedAt": "2026-05-25T12:00:00.000Z"
}
```

规则：

- CLI 输出给 agent 的路径优先使用相对项目根的路径，例如 `.tiny-agent/runs/...`。
- state root 内部文件可以记录绝对路径，方便 TUI 或外部工具直接打开。
- 不同项目不能共享同一个 `.tiny-agent/`，除非用户显式传 `--state-dir`。

## CLI Surface

第一版需要 build 的 CLI：

```text
tiny-agent       # run orchestrator, agent run state, terminal/session tool execution
tiny-agent tui   # transcript / state player
im               # local mock user-message transport
skill            # local skill discovery, run, close, review-complete
```

不需要 build 成独立 CLI 的部分：

```text
PTY session controls   # 模型通过 session_* tool call 内部调用，不是用户命令
mcp                    # 外部 mcp CLI，agent 通过 bash 执行
memory/sub-agent        # 第一版不是核心路径
```

所有 CLI 都支持：

```text
--state-dir <path>
--json
```

错误输出规则：

- 正常结果写 stdout。
- 结构化错误写 stderr。
- 失败时 exit code 非 0。
- 如果 `--json` 开启，stdout/stderr 都输出单行 JSON 或 JSONL，不输出人类解释性前缀。

## Canonical Directory Layout

```text
.tiny-agent/
  project.json

  locks/
    project.lock/
    runs.latest.lock/
    run-<runId>.lock/
    run-<runId>.transcript.lock/
    session-<sessionId>.lock/
    environment.events.lock/
    environment.cursor-<runId>.lock/
    im-channel-<channel>.lock/
    skill-run-<skillRunId>.lock/
    skills.registry.lock/

  runs/
    latest.json
    run-2026-05-25T12-00-00-abc123/
      state.json
      transcript.jsonl
      session.json
      debug/
        prompts/
          step-0000-thinking.prompt.txt

  sessions/
    default/
      state.json
      output.log
    server/
      state.json
      output.log

  environment/
    events.jsonl
    cursors/
      run-2026-05-25T12-00-00-abc123.json

  im/
    channels/
      default/
        inbox.jsonl
        outbox.jsonl
        cursors.json

  skills/
    coding-review/
      SKILL.md
      skill.json
      attachments/
        lessons.md

  skill-runs/
    skillrun-2026-05-25-001/
      state.json
      execution.txt
      review-task.txt

  tmp/
```

说明：

- `runs/<runId>/state.json` 是 run snapshot。
- `runs/<runId>/transcript.jsonl` 是 run event ledger。
- `runs/<runId>/session.json` 是 agent-loop history snapshot，用于 resume。
- `runs/<runId>/debug/prompts/` 保存由 transcript/history 通过 `promptRef` 引用的大 prompt artifact。
- `environment/events.jsonl` 是跨 run 的外部环境事件 ledger。
- `sessions/<sessionId>/output.log` 是完整 PTY 输出，observation 只返回一屏 terminal viewport。
- `skill-runs/<id>/execution.txt` 和 `review-task.txt` 只给 agent 通过 bash 原生命令读取，不直接塞进 prompt。

## File Types

状态文件只分三类。

### Snapshot JSON

例如：

```text
project.json
runs/<runId>/state.json
sessions/<sessionId>/state.json
skill-runs/<skillRunId>/state.json
environment/cursors/<runId>.json
im/channels/<channel>/cursors.json
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
environment/events.jsonl
im/channels/<channel>/inbox.jsonl
im/channels/<channel>/outbox.jsonl
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
sessions/<sessionId>/output.log
debug/prompts/<artifact>.txt
skill-runs/<skillRunId>/execution.txt
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
mkdir .tiny-agent/locks/<name>.lock
write .tiny-agent/locks/<name>.lock/owner.json
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
rmdir .tiny-agent/locks/<name>.lock
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

`tiny-agent` 内部的 ManagedTerminalRuntime 是 session owner。

它负责写：

```text
sessions/<sessionId>/state.json
sessions/<sessionId>/output.log
```

锁：

```text
session-<sessionId>.lock
```

执行长命令时：

1. 获取 session lock，写 state=`running`。
2. 释放 session lock。
3. 持续写 `output.log`。
4. 命令完成、超时、interrupt 时，再获取 session lock 更新 state。

这样不会因为一个长命令卡住其它只读 CLI。

### Environment

Environment 是跨系统事件 ledger。

写入者：

- `im` CLI append `user_message_received`
- ManagedTerminalRuntime writes PTY observations through transcript tool-result events
- `skill` CLI append `skill_run_started`、`skill_run_closed`、`skill_review_pending`、`skill_review_completed`

文件：

```text
environment/events.jsonl
environment/cursors/<runId>.json
```

锁：

```text
environment.events.lock
environment.cursor-<runId>.lock
```

消费规则：

1. run loop 读取 cursor。
2. 读取 cursor 之后的新 events。
3. 渲染 system reminder。
4. 写 transcript `environment_events_consumed`。
5. 更新 cursor。

cursor 不能在 reminder 入 transcript 之前提前移动。

### IM

`im` CLI 负责本地 mock channel。

文件：

```text
im/channels/<channel>/inbox.jsonl
im/channels/<channel>/outbox.jsonl
im/channels/<channel>/cursors.json
```

锁：

```text
im-channel-<channel>.lock
```

`im listen` 不能长期持锁。它只能循环短暂读文件，然后 sleep / wait。

### Skill

`skill` CLI 负责 skill discovery 和 skill run lifecycle。

文件：

```text
skill-runs/<skillRunId>/state.json
skill-runs/<skillRunId>/execution.txt
skill-runs/<skillRunId>/review-task.txt
skills/<skill>/attachments/lessons.md
```

锁：

```text
skill-run-<skillRunId>.lock
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
skill-run-<id>.lock -> skills.registry.lock -> environment.events.lock
```

其它地方也遵循同一原则：先具体资源锁，再 ledger 锁。

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
    "lock": ".tiny-agent/locks/session-default.lock"
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
