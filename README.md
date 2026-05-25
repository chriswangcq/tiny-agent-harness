# tiny-agent-harness

一个开放式 coding agent harness 实验项目。

目标不是再做一层“大而全”的 agent SDK，而是把 coding agent 的 loop、工具执行、外部事件、日志和可恢复状态拆成清楚的边界，让每一步都能被审阅、回放和替换。

## 核心设计理念

- **统一动作面**：Agent 对外只有一个真实工具：`bash`。MCP、memory、skills、sub-agent、测试、git 等能力先暴露为 CLI，再由 bash 调用。这样所有外部动作共享同一套 session、review、observation 和日志协议。
- **显式状态优先**：`AgentRunState` 是互斥生命周期状态机，pending model output、tool call、review、`io_wait` 都进入 state，而不是散落在 orchestrator 局部变量里。目标是让 run 可以落盘、恢复、调试、评估。
- **决策和副作用分离**：State 只决定下一步 effect；`RunOrchestrator` 负责执行模型调用、工具审核、bash 执行、transcript 写入等副作用。
- **事件驱动的外部世界**：IM 消息、bash session 变化、skill run 状态等统一进入 `Environment`。每轮 loop 只消费新事件，同时把仍然成立的事实作为 persistent reminder 注入模型上下文。
- **日志即调试接口**：Observation 只返回本次新增输出窗口和关键元信息，完整输出写入 session log / transcript。Agent 和审阅者都通过 log path 精确回看，而不是把大段输出塞回上下文。
- **能力可组合但不内置业务语义**：Harness 管 bash、session、review、run state，不直接理解某个 MCP、skill 或业务工具。能力扩展通过 CLI 组合，减少内核耦合。
- **审阅先于执行**：所有 bash tool request 在执行前经过 `ToolReviewer`。Demo 阶段默认 approve，但边界已经保留给人工审核、策略审核或权限分级。

## 设计亮点

- **DeepSeek FIM two-pass 主模型路径**：一轮 ReAct step 拆成 thinking pass 和 decision pass，便于约束输出形状，并把思考、决策、归一化后的 `ModelTurn` 分开保存。
- **单工具 ReAct loop**：模型不需要理解一组不断膨胀的 provider-native tools，只需要学会一个稳定的 bash tool contract。
- **可恢复 run artifacts**：run state、transcript JSONL、bash session log 都是 durable artifacts，后续可以支撑 resume、debug、eval、自我复盘和 TUI 回放。
- **`io_wait` 是一等决策**：等待用户消息或外部事件不是 sleep / busy loop，而是 run state machine 中可记录、可恢复的状态。
- **Skill CLI 生命周期**：skills 通过 `skill` CLI 发现和执行，并有 active / closed / review pending 等 durable 状态；活跃 skill run 会持续进入 system reminder，直到 agent 显式关闭或完成复盘。
- **TUI 只是观察面**：TUI 读取 transcript、state、session log、environment、skill run state 来播放 agent loop，不成为第二个 orchestrator。
- **小内核、强边界**：模型适配器、prompt builder、environment、reviewer、bash manager、IM transport 都通过端口协作，方便替换和单独测试。

## 当前核心方向

- Agent ReAct loop 独立实现。
- Agent 的所有外部动作都收敛为 `bash` tool call。
- 主模型层使用 DeepSeek FIM two-pass：先生成 thinking，再生成 tool call 或 final decision。
- 用户消息收发通过 IM CLI 处理，不把 stdin/stdout 作为核心通信边界。
- MCP、memory、skills、sub-agent 等能力都通过 CLI 暴露，再由 bash 调用。Skills 通过 `skill` CLI 发现和执行。
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
- [Skill CLI](docs/skill-cli.md)
- [TUI](docs/tui.md)
