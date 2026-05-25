# tiny-agent-harness

一个开放式 coding agent harness 实验项目。

核心方向：

- Agent ReAct loop 独立实现。
- Agent 的所有外部动作都收敛为 `bash` tool call。
- MCP、memory、skills、sub-agent 等能力都通过 CLI 暴露，再由 bash 调用。
- Harness 内部提供 bash session manager，用来管理长期会话、输出截断、日志持久化和中断恢复。
- Tool review 模块预留为执行前审核入口，demo 阶段默认全部 approve。

当前设计文档：

- [Tool Call And Observation](docs/tool-call-observation.md)
