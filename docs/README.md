# Documentation Guide

本目录收纳 tiny-agent-harness 的设计文档、工程报告和各子系统契约。根目录 [README](../README.md) 面向快速启动和项目叙事；这里更适合作为实现、调试和后续重构时的索引。

## Reading Path

推荐按问题类型选择阅读路径：

- 想快速理解项目：先读 [Project Report](project-report.md)，再读根目录 [README](../README.md) 的核心理念和设计亮点。
- 想理解 agent loop：读 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)，重点看 `NextEffect`、run events、context window、persistence 和 resume semantics。
- 想理解模型输出协议：读 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)，再对照 [Model Visible Tool Catalog](model-visible-tool-catalog.md)。
- 想理解工具执行边界：读 [Tool Call And Observation](tool-call-observation.md)，它定义 terminal/session tool、screen observation、`inputSeq` 和 terminal facts。
- 想理解用户消息和外部事件：读 [IM CLI Transport](im-cli-transport.md) 和 [Environment Model](environment-model.md)。
- 想理解 CLI 能力生态：读 [Skill CLI](skill-cli.md)、[Code Intelligence CLI](code-intelligence-cli.md) 和 [MCP CLI](mcp-cli.md)。
- 想理解 sub-agent 管理域：读 [Sub-agent Team Domain](subagent-team.md)。
- 想试运行多 agent ticket/workspace/branch 协作：读 [Agent Team Trial Plan](agent-team-trial.md)。
- 想理解 resume/replay/eval：读 [Recovery And Replay](recovery-replay.md)。
- 想理解持久化与调试文件：读 [State Layout](state-layout.md) 和 [State Storage And File Locking](state-storage-locking.md)。
- 想理解观察界面：读 [TUI](tui.md)。

## Current Runtime Contracts

当前主路径有几条重要约束：

- 当前模型可见外部动作面拆成 `terminal_write`、`terminal_key` 和 `session_*` 管理工具；等待用户或外部事件通过内部 `io_wait` decision 表达。
- `terminal_write` / `terminal_key` 只作用于 current session，schema 中没有 `session` 参数。切换目标必须先 `session_focus`。
- 每个写入类 terminal/session request 都带 `expectedInputSeq`。如果序号过期，runtime 会尽量先刷新终端状态，让 rejection 带回最新 `inputSeq`。
- Observation 是 bounded human glance：模型看到最多一屏 `screen.text`、terminal facts、`returnedToPrompt` 和 log path；完整输出留在 session log。
- Terminal facts 包含 best-effort `foregroundProcess`。它是调试和决策线索，不是可靠的路由判定。
- FIM prompt 这类大调试 payload 会写到 run 目录下的 `debug/prompts/`，transcript/model output 只保留 `promptRef`。streamed thinking progress 写到 `debug/thinking/`，最终 `model_output_received` 只保留 `traceRef`。
- `mcp` 是 CLI 能力，不是新的模型可见 tool；agent 通过 terminal/session 工具执行 `mcp add/list/tools/call`。
- `subagent` 当前是可测试 FSM/domain，不是已经能启动 worker process 的 runtime。

## Durable Artifacts

一次 run 的核心文件通常长这样：

```text
.tiny-agent/
  runs/
    <runId>/
      state.json
      transcript.jsonl
      session.json
      sessions/
        default-37a8eec1ce.log
      im/
        default.inbox.jsonl
        default.outbox.jsonl
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
```

`state.json` 是最新 run snapshot；`transcript.jsonl` 是 append-only audit ledger；`session.json` 保存 `ModelContextSession` snapshot 以支持 resume；`im/`、`environment/`、`skill-runs/` 都是 run-scoped；`debug/prompts/` 和 `debug/thinking/` 保存不适合直接进入 transcript/model-context 的调试 payload；`runs/<runId>/sessions/<safe-session-id>-<sha256-10>.log` 保存完整 raw PTY 输出。模型看到的 `screen.text` 是一屏 semantic viewport，raw log 通过 `screen.logRef.path` 追溯。

## Keeping Docs Current

改实现时优先同步这些文档位置：

- 改 `src/run` 或 run event 类型：同步 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)。
- 改可见工具、terminal/session request、terminal facts、observation：同步 [Tool Call And Observation](tool-call-observation.md) 和 [Model Visible Tool Catalog](model-visible-tool-catalog.md)。
- 改 model adapter 或 FIM prompt/debug payload：同步 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)。
- 改 `.tiny-agent/` 文件布局或锁策略：同步 [State Layout](state-layout.md) 和 [State Storage And File Locking](state-storage-locking.md)。
- 改 TUI projection 或数据源：同步 [TUI](tui.md)。
- 改 MCP/sub-agent/replay：同步 [MCP CLI](mcp-cli.md)、[Sub-agent Team Domain](subagent-team.md)、[Recovery And Replay](recovery-replay.md)。
