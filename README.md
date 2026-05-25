# tiny-agent-harness

一个开放式 coding agent harness 实验项目。

核心方向：

- Agent ReAct loop 独立实现。
- Agent 的所有外部动作都收敛为 `bash` tool call。
- 主模型层使用 DeepSeek FIM two-pass：先生成 thinking，再生成 tool call 或 final decision。
- 用户消息收发通过 IM CLI 处理，不把 stdin/stdout 作为核心通信边界。
- MCP、memory、skills、sub-agent 等能力都通过 CLI 暴露，再由 bash 调用。
- Harness 内部提供 bash session manager，用来管理长期会话、输出截断、日志持久化和中断恢复。
- Environment 统一建模外部事件，每轮 Agent loop 消费为 system reminder，`io_wait` 等待 environment 事件。
- Tool review 模块预留为执行前审核入口，demo 阶段默认全部 approve。

当前设计文档：

- [Tool Call And Observation](docs/tool-call-observation.md)
- [Run Orchestrator And Agent Run State](docs/run-orchestrator-state.md)
- [Static Bash Tool Definition](docs/static-bash-tool-definition.md)
- [DeepSeek FIM Two-Pass Adapter](docs/deepseek-fim-adapter.md)
- [IM CLI Transport](docs/im-cli-transport.md)
- [Environment Model](docs/environment-model.md)
