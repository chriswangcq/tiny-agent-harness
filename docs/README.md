# Documentation Guide

本目录收纳 tiny-agent-harness 的设计文档、工程报告和各子系统契约。根目录 [README](../README.md) 面向快速启动和项目叙事；这里更适合作为实现、调试和后续重构时的索引。

## Reading Path

推荐按问题类型选择阅读路径：

- 想快速理解项目：先读 [Project Report](project-report.md)，再读根目录 [README](../README.md) 的核心理念和设计亮点。
- 想理解 agent loop：读 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)，重点看 `NextEffect`、run events、context window、persistence 和 resume semantics。
- 想理解模型输出协议：读 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)，再对照 [Static Bash Tool Definition](static-bash-tool-definition.md)。
- 想理解工具执行边界：读 [Tool Call And Observation](tool-call-observation.md)，它定义 PTY action、observation shape、`inputSeq` 和 terminal facts。
- 想理解用户消息和外部事件：读 [IM CLI Transport](im-cli-transport.md) 和 [Environment Model](environment-model.md)。
- 想理解 CLI 能力生态：读 [Skill CLI](skill-cli.md) 和 [Code Intelligence CLI](code-intelligence-cli.md)。
- 想理解持久化与调试文件：读 [State Storage And File Locking](state-storage-locking.md)。
- 想理解观察界面：读 [TUI](tui.md)。

## Current Runtime Contracts

当前主路径有几条重要约束：

- 模型可见外部动作面是 `bash` 和 `stash_file`；等待用户或外部事件通过内部 `io_wait` decision 表达。
- `bash` payload 是 PTY action，不是命令级 `{ command }`。`write_text` 写入精确字节，`key` 发送终端按键，`poll/status/interrupt/terminate/restart` 管理 session。
- 每个写入类 PTY action 都带 `expectedInputSeq`。如果序号过期，runtime 会尽量先刷新终端状态，让 rejection 带回最新 `inputSeq`。
- Observation 是 bounded glance：模型看到 `outputTail`、terminal facts、`returnedToPrompt`、`newOutputBytes` 和 `logRef`；完整输出留在 session log。
- Terminal facts 包含 best-effort `foregroundProcess`。它是调试和决策线索，不是可靠的路由判定。
- FIM thinking prompt 这类大调试 payload 会写到 run 目录下的 `debug/prompts/`，transcript 和 agent-loop history 只保留 `promptRef`。

## Durable Artifacts

一次 run 的核心文件通常长这样：

```text
.tiny-agent/
  runs/
    <runId>/
      state.json
      transcript.jsonl
      session.json
      debug/
        prompts/
          step-0000-thinking.prompt.txt
  sessions/
    <sessionId>/
      state.json
      output.log
```

`state.json` 是最新 run snapshot；`transcript.jsonl` 是 append-only audit ledger；`session.json` 保存 agent-loop history 以支持 resume；`debug/prompts/` 保存不适合直接进入 transcript/history 的大 prompt；session `output.log` 保存完整 PTY 输出。

## Keeping Docs Current

改实现时优先同步这些文档位置：

- 改 `src/run` 或 run event 类型：同步 [Run Orchestrator And Agent Run State](run-orchestrator-state.md)。
- 改 PTY action、terminal facts、observation：同步 [Tool Call And Observation](tool-call-observation.md) 和 [Static Bash Tool Definition](static-bash-tool-definition.md)。
- 改 model adapter 或 FIM prompt/debug payload：同步 [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)。
- 改 `.tiny-agent/` 文件布局或锁策略：同步 [State Storage And File Locking](state-storage-locking.md)。
- 改 TUI projection 或数据源：同步 [TUI](tui.md)。
