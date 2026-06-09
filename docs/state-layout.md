# State Layout 设计

## 设计原则

- **Home-scoped project store**：默认状态根是 `~/.tiny-agent/projects/<projectId>/`，项目源码目录不再自动创建 `.tiny-agent/`。
- **Run 自包含**：一个 run 的所有状态（IM、session、environment、skill-runs、team/supervisor/worker state）都在 `runs/run-<ts>/` 下，可独立归档、恢复和清理。
- **Skills 项目公共**：技能定义是跨 run 共享的知识资产，放在项目级 `skills/` 下。

## 目录结构

```
~/.tiny-agent/projects/<projectId>/
├── project.json                    # 项目级元数据
│
├── locks/                          # 进程互斥锁
│
├── skills/                         # 公共：技能定义（跨 run 共享）
│   └── <skill-name>/
│       └── SKILL.md
│
├── runs/
│   ├── latest.json                 # 指向最新 run
│   └── run-<ts>/                   # 单个 run（完全自包含）
│       ├── state.json              # AgentRunState 状态机快照
│       ├── transcript.jsonl        # 完整执行转录（每行一个 RunEvent）
│       │
│       ├── im/                     # 本 run 的 IM 消息
│       │   ├── <channel>.inbox.jsonl
│       │   └── <channel>.outbox.jsonl
│       │
│       ├── sessions/               # 本 run 的终端 session raw PTY log
│       │   └── <safe-session-id>-<sha256-10>.log
│       │
│       ├── environment/            # 本 run 的环境事件持久化
│       │   └── events.jsonl
│       │
│       ├── skill-runs/             # 本 run 的技能执行记录
│       │   └── <skillRunId>/
│       │       ├── state.json
│       │       ├── execution.txt
│       │       └── review-task.txt
│       │
│       ├── debug/                  # 调试产物
│           ├── prompts/
│           │   └── step-XXXX-thinking.prompt.txt
│           └── thinking/
│               └── step-XXXX-thinking.trace.txt
│       │
│       └── mcp-servers.json        # 可选：本 run 的 MCP server registry
│       │
│       ├── supervisor/             # 本 run 的 supervisor 生命周期存储
│       │   ├── lifecycle-events.jsonl
│       │   └── snapshot.json
│       │
│       ├── workers/               # 本 run 的 worker 进程状态
│       │   └── <workerId>/
│       │       ├── state.json
│       │       └── output.log
││
├── launcher/                       # 启动器日志
│   └── ui-<ts>.log
│
└── tmp/                            # 临时文件
```

## 各目录说明

### `project.json`

项目级元数据：

```json
{
  "schemaVersion": 1,
  "projectId": "tiny-agent-harness-<sha256-12>",
  "projectRoot": "/path/to/project",
  "stateMode": "home-project",
  "createdAt": "2026-...",
  "updatedAt": "2026-..."
}
```

### `skills/` — 项目公共

技能定义目录。每个技能一个子目录，包含 `SKILL.md` 等文件。agent 可以通过 `skill list` / `skill show` 发现和使用这些技能。技能定义跨 run 共享，可以在多个 run 中反复使用和迭代。

### `runs/run-<ts>/` — Run 自包含

每个 run 完全自包含以下子目录：

| 子目录 | 内容 | 格式 |
|--------|------|------|
| `state.json` | AgentRunState 快照 | JSON |
| `transcript.jsonl` | 完整执行事件流 | JSONL |
| `im/` | 本 run 的 IM 收发记录 | JSONL |
| `sessions/` | 终端 PTY raw log；文件名为 sanitize 后的 session id 加短 hash，避免路径穿越和重名 | 纯文本 |
| `environment/` | 环境事件（one-shot events + persistent facts） | JSONL |
| `skill-runs/` | 技能执行实例的状态和日志 | JSON |
| `debug/` | 调试产物（prompt 快照、thinking trace 等） | 纯文本 |
| `mcp-servers.json` | 可选 MCP server registry；agent 在 PTY 中默认使用 run-scoped `TAH_STATE_DIR` | JSON |

### PTY 启动环境变量

Managed PTY 启动时会把当前 run 信息注入 shell 环境，供 agent 在 bash 内调用 `im`、`skill` 等 CLI 时自动落到当前 run：

| 环境变量 | 含义 |
|----------|------|
| `TAH_RUN_ID` | 当前 run id |
| `TAH_RUN_DIR` | 当前 `runs/run-<ts>/` 目录 |
| `TAH_STATE_DIR` | CLI 默认状态目录；在 PTY 中等于当前 run 目录 |
| `TAH_PROJECT_STATE_DIR` | 当前项目的 home-scoped state root；供 team lifecycle/reaper 等跨 run 控制面使用 |
| `TAH_RUN_CHANNEL` | 当前 IM channel |
| `TAH_IM_DIR` | 当前 run 的 IM inbox/outbox 目录 |
| `TAH_SKILL_RUNS_DIR` | 当前 run 的 skill-runs 目录 |
| `TAH_SESSIONS_DIR` | 当前 run 的 sessions 目录 |
| `TAH_SKILLS_DIR` | 项目级 skills 目录 |
| `TAH_TRANSCRIPT_PATH` | 当前 run transcript JSONL |
| `TAH_ENVIRONMENT_EVENTS_PATH` | 当前 run environment events JSONL |

因此 agent 在 PTY 中执行 `node dist/cli/main.js im send ...` 或 `node dist/cli/main.js skill ...` 时，不需要额外传 `--state-dir`；显式传入 `--state-dir` 仍然用于人工调试或跨 run 操作。

### PTY session 生命周期

每个 run 的 PTY raw output 追加写入 `runs/run-<ts>/sessions/<safe-session-id>-<sha256-10>.log`。`TerminalObservation.screen.text` 不是这个日志的 tail，而是固定 rows/cols 的 semantic terminal viewport：managed shell marker 和 continuation prompt chrome 会被剥离，主 prompt 保留以提供 cwd/user 定位。

`session_terminate` 会杀掉 PTY 进程并把 session 保持为可观察的 dead state：`session_observe` 和 `session_list` 仍可读取最后的 terminal facts/screen/log path；`terminal_write`、`terminal_key` 和 `session_interrupt` 会以 `TERMINAL_TERMINATED` 结构化拒绝，直到 `session_restart` 显式启动同一个 session id 的新 shell。

Resume 只恢复 run state、transcript 和 model context，不恢复旧 PTY 进程树。恢复后的 PTY 是 fresh shell；agent 必须先 `session_observe`/`session_list`，再用最新 `terminal.inputSeq` 输入。

### Debug artifacts

`debug/prompts/` 保存 DeepSeek V4 prompt encoder 产物。transcript/model output 只保留 `promptRef`，包括相对路径、字节数和 sha256。

`debug/thinking/` 保存 streamed thinking progress trace。当前 active run path 不再把每个 thinking chunk 写成 `model_thinking_delta` 主 transcript event，而是在最终 `model_output_received.output.thinking.raw.traceRef` 中保留 artifact 引用。`model_thinking_delta` 只保留为历史 transcript 兼容事件。

`transcript.jsonl` 同时写入 compact `model_decision_recorded` 事件，引用上述 `promptRef` / `traceRef`，并记录 `decisionId`、decision kind、tool args / `io_wait` / invalid-output diagnostic 与 raw decision hash/preview。后续 validation、review、tool、observation 和 `io_wait` 事件可用同一个 `decisionId` 串起这次决策的事实链。

### `launcher/` — 运维日志

TUI 启动器的 stdout/stderr 日志，用于排查 UI 启动问题。不属于 run 状态，可定期清理。

## 当前落地状态

当前 CLI 主路径已经按 run-scoped 目录写入：

| 能力 | 当前路径 |
|------|----------|
| IM inbox/outbox | `~/.tiny-agent/projects/<projectId>/runs/<runId>/im/` |
| PTY raw logs | `~/.tiny-agent/projects/<projectId>/runs/<runId>/sessions/` |
| Environment events | `~/.tiny-agent/projects/<projectId>/runs/<runId>/environment/events.jsonl` |
| Skill runs | `~/.tiny-agent/projects/<projectId>/runs/<runId>/skill-runs/` |
| Model context snapshot | `~/.tiny-agent/projects/<projectId>/runs/<runId>/session.json` |
| Debug prompt/trace artifacts | `~/.tiny-agent/projects/<projectId>/runs/<runId>/debug/` |
| Supervisor lifecycle events | `~/.tiny-agent/projects/<projectId>/runs/<runId>/supervisor/lifecycle-events.jsonl` (append-only heartbeat, lease, shutdown_requested/completed/failed, reaper facts) |
| Worker process state | `~/.tiny-agent/projects/<projectId>/runs/<runId>/workers/<workerId>/state.json` |

仍保持项目级：

- `skills/` — 跨 run 共享 skill definitions。
- `runs/` — run 容器和 latest pointer。
- `launcher/` — TUI launcher 日志。
- `tmp/` — 临时文件。

因此 `runs/run-<ts>/` 是一个可独立打包、归档或删除的完整运行单元。
