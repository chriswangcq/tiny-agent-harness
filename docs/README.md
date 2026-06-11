# Documentation Guide

本目录收纳 tiny-agent-harness 的设计文档、工程报告和各子系统契约。根目录 [README](../README.md) 面向快速启动和项目叙事；这里更适合作为实现、调试和后续重构时的索引。

## Reading Path

推荐按问题类型选择阅读路径：

- 想快速理解项目：先读 [Project Report](project-report.md)，再读根目录 [README](../README.md) 的核心理念和设计亮点。
- 想理解 agent loop：读 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)，重点看 `NextEffect`、run events、context window、persistence 和 resume semantics。
- 想理解模型输出协议：读 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)，再对照 [Model Visible Tool Catalog](model-visible-tool-catalog.md)。
- 想理解工具执行边界：读 [Tool Call And Observation](tool-call-observation.md)，它定义 terminal/session tool、screen observation、`inputSeq` 和 terminal facts。
- 想理解用户消息和外部事件：读 [Public IM](public-im.md) 和 [Environment Model](environment-model.md)。
- 想理解 CLI 能力生态：读 [Skill CLI](skill-cli.md)、[Code Intelligence CLI](code-intelligence-cli.md) 和 [MCP CLI](mcp-cli.md)。
- 想理解 sub-agent 管理域：读 [Sub-agent Team Domain](subagent-team.md) 和 [Subagent Team Operating Guide](subagent-team-operating-guide.md)。当前 team 是轻量 roster/lifecycle 控制面，workspace/git/ledger 由 IM 指令或 evidence 决定。
- 想试运行多 agent ticket/workspace/branch 协作：读 [Agent Team Trial Plan](agent-team-trial.md)，但不要把 workspace/branch/ledger 当成 roster 必填字段。
- 想理解 resume/replay/eval：读 [Recovery And Replay](recovery-replay.md)。
- 想理解多进程 runtime、process registry 和恢复边界：读 [Runtime Process Architecture](runtime-process-architecture.md)。
- 想理解持久化与调试文件：读 [State Layout](state-layout.md) 和 [State Storage And File Locking](state-storage-locking.md)。
- 想理解观察界面：读 [TUI](tui.md)。

## Current Runtime Contracts

当前主路径有几条重要约束：

- 当前模型可见外部动作面拆成 `terminal_write`、`terminal_key` 和 `session_*` 管理工具；等待用户或外部事件通过内部 `io_wait` decision 表达。
- `terminal_write` / `terminal_key` 只作用于 current session，schema 中没有 `session` 参数。切换目标必须先 `session_focus`。
- 每个写入类 terminal/session request 都带 `expectedInputSeq`。如果序号过期，runtime 会尽量先刷新终端状态，让 rejection 带回最新 `inputSeq`。
- Observation 是 bounded human glance：模型看到一个 visual-line window 的 `screen.text`、`screen.window`、terminal facts、`returnedToPrompt` 和 log path；附近历史可用 `session_observe` 翻页，完整 raw 输出留在 session log。
- Terminal facts 包含 best-effort `foregroundProcess`。它是调试和决策线索，不是可靠的路由判定。
- FIM prompt 这类大调试 payload 会写到 run 目录下的 `debug/prompts/`，transcript/model output 只保留 `promptRef`。streamed thinking progress 写到 `debug/thinking/`，最终 `model_output_received` 只保留 `traceRef`。
- `tiny-agent mcp` 是 CLI 能力，不是新的模型可见 tool；agent 通过 terminal/session 工具执行 `tiny-agent mcp add/list/tools/call`。
- `subagent` 当前是轻量 team 控制面：roster/lifecycle domain 保持纯函数，CLI adapter 负责 project-scoped roster 落盘；work instructions 通过显式 `tiny-agent im post --from <endpoint> --to <endpoint>` 进入 public IM endpoint pair；local worker launcher 仍是显式请求的可选 adapter。

## Durable Artifacts

一次 run 的核心文件通常长这样：

```text
~/.tiny-agent/projects/<projectId>/
  runs/
    <runId>/
      state.json
      transcript.jsonl
      session.json
      sessions/
        default-37a8eec1ce.log
      environment/
        events.jsonl
      skill-runs/
        <skillRunId>/
          state.json
          execution.txt
      debug/
        prompts/
          step-0000-thinking.prompt.txt
        thinking/
          step-0000-thinking.trace.txt
  teams/
    <teamId>/
      state.json
      events.jsonl
      members/
        <memberId>/
          state.json
          output.log
      runs/
        <runId>.json
      supervisor/
        lifecycle-events.jsonl
        snapshot.json
  im/
    endpoints/
    pairs/
    channels/
    run-bindings/
```

`state.json` 是最新 run snapshot；`transcript.jsonl` 是 append-only audit ledger；`session.json` 保存 `ModelContextSession` snapshot 以支持 resume；`environment/`、`skill-runs/`、`debug/` 是 run-scoped。public IM 位于 project-scoped `im/` 下：endpoint pair 和 directional channel log 可被多个 run、TUI、team worker 或外部客户端复用，run 只通过 `im/run-bindings/<runId>.json` 记录自己绑定了哪些 pair。active team 控制面在 project-scoped `teams/<teamId>/` 下：`events.jsonl` 是 append-only team fact stream 和 canonical read source，`state.json` 是从事件流写出的 roster snapshot，`members/<memberId>/` 保存本地 member worker state，`runs/<runId>.json` 保存 team-owned run reference，`supervisor/` 保存 team supervisor lifecycle state。work instructions 通过 public IM endpoint pair 派发；team roster 只记录成员、run 绑定、assignment 标签和生命周期事实。`debug/prompts/` 和 `debug/thinking/` 保存不适合直接进入 transcript/model-context 的调试 payload；`runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log` 保存完整 raw PTY 输出。模型看到的 `screen.text` 是一屏 semantic viewport，raw log 通过 `screen.logRef.path` 追溯。

## Keeping Docs Current

改实现时优先同步这些文档位置：

- 改 `src/run` 或 run event 类型：同步 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)。
- 改可见工具、terminal/session request、terminal facts、observation：同步 [Tool Call And Observation](tool-call-observation.md) 和 [Model Visible Tool Catalog](model-visible-tool-catalog.md)。
- 改 model adapter 或 FIM prompt/debug payload：同步 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)。
- 改 `~/.tiny-agent/projects/<projectId>/` 文件布局或锁策略：同步 [State Layout](state-layout.md) 和 [State Storage And File Locking](state-storage-locking.md)。
- 改 process registry、terminal-host、MCP/Codeq/model gateway 进程边界：同步 [Runtime Process Architecture](runtime-process-architecture.md)。
- 改 TUI projection 或数据源：同步 [TUI](tui.md)。
- 改 MCP/sub-agent/replay：同步 [MCP CLI](mcp-cli.md)、[Sub-agent Team Domain](subagent-team.md)、[Recovery And Replay](recovery-replay.md)。

- [Subagent Team Operating Guide](subagent-team-operating-guide.md) — How to use, dispatch, merge, and QA the sub-agent team runtime.
