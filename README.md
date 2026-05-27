# tiny-agent-harness

一个开放式 coding agent harness 实验项目。

它的目标不是再做一层“大而全”的 agent SDK，而是把 coding agent 的 loop、工具执行、外部事件、日志和可恢复状态拆成清楚的边界，让每一步都能被审阅、回放、恢复和替换。

## 快速启动

先安装依赖并构建：

```bash
npm install
npm run build
```

把 DeepSeek API key 放到项目根目录的 `ak.txt`：

```bash
cd ~/Documents/DeepSeek
printf '%s\n' 'your-deepseek-api-key' > ak.txt
```

`ak.txt` 已经在 `.gitignore` 里，不会被提交。也可以继续用环境变量 `DEEPSEEK_API_KEY`，但本地 demo 推荐直接放 `ak.txt`。

然后用一个命令启动前台 TUI。它会自动在后台启动 agent run，并把 run 日志写到 `.tiny-agent/launcher/`：

```bash
cd ~/Documents/DeepSeek
node dist/cli/main.js ui --channel default
```

进入 TUI 后按 `m` 输入第一条真实任务，agent 会从同一个 `default` channel 收到消息并开始执行。不需要先 `im post hello`。`im post` 只用于注入用户消息；agent 回复走 `im send` 写入 outbox。

如果已经执行过 `npm link`，也可以写成短命令：

```bash
tiny-agent ui --channel default
```

如果想跳过 IM 等待，启动时直接给任务：

```bash
node dist/cli/main.js ui --channel default --task "fix the failing tests"
```

也可以用两个终端分开调试。第一个终端启动 run：

```bash
node dist/cli/main.js run --channel default
```

第二个终端打开 TUI：

```bash
node dist/cli/main.js tui --run latest --channel default
```

如果想使用 `tiny-agent`、`im`、`skill`、`codeq` 这些短命令，需要先在本仓库执行一次：

```bash
npm link
```

之后可以写成：

```bash
tiny-agent ui --channel default
```

启动时会优先读取 `DEEPSEEK_API_KEY`，如果没有设置，再读取当前目录的 `ak.txt`。

## 核心设计理念

- **小内核、统一动作面**：模型可见的外部动作只有 `bash`。MCP、memory、skills、sub-agent、测试、git 和项目脚本都先作为 CLI 存在，再通过 bash 进入 harness。这样外部能力不会把内核变成一组不断膨胀的业务工具。
- **显式状态优先**：`AgentRunState` 是互斥生命周期状态机。模型输出、待校验 tool call、待审核 request、待执行 tool、`io_wait` 都进入 state，而不是散落在 orchestrator 局部变量里。
- **决策和副作用分离**：`AgentRunState.nextEffect()` 只决定下一步应该发生什么；`RunOrchestrator` 负责调用模型、校验工具、审核工具、执行 bash、等待 IO、写 transcript。
- **FIM 是受约束的 step generator**：DeepSeek V4 FIM 被拆成 thinking pass 和 decision pass。Decision pass 只允许生成一个 native tool-call frame，并被归一化为 `ModelTurn`。
- **外部世界事件化**：IM 消息、bash session 状态、命令完成/超时、skill run 状态统一进入 `Environment`。模型每轮看到的是被消费过的 factual reminder，而不是隐藏的可变状态。
- **日志是主要调试接口**：Observation 只返回新增输出窗口、return code、offset 和 log path；完整输出写入 session log，run 事件写入 transcript JSONL。大上下文靠路径回看，不靠一次性塞进 prompt。
- **失败也进入回路**：无效模型输出、tool validation 失败、review 拒绝都会转成 recoverable observation，让 agent 下一轮自我修正，而不是立刻把 run 打死。
- **复盘由 agent 判断触发**：skill 执行结束后不是固定进入复盘流程，而是由 agent 根据输出、失败模式、风险和任务结果决定是否 `close --review required`。Harness 只提供状态机和记录位置。
- **审阅先于执行**：所有 bash request 在执行前经过 `ToolReviewer`。当前 demo 可以默认 approve，但边界已经为人工审核、策略审核、权限分级和安全审计留好入口。
- **观察面不拥有事实**：TUI 是 transcript player / control surface，只读取 durable artifacts 并渲染 view model，不成为第二个 run orchestrator。
- **面向 AI 时代的可维护性**：减少隐藏状态、重复路径和“看起来合理但已经过时”的上下文，让未来的人和 agent 都不容易误读当前架构。

## 设计亮点

- **DeepSeek V4 native tool-call FIM**：decision pass 使用 DeepSeek V4 native tool-call special token 边界，但仍由 harness 手工解析和归一化，不依赖 provider-native tool calling。
- **PTY action tool catalog**：模型可见外部动作只有 `bash`；所有输入都走 `write_text` 或 `key`，大 payload 通过 PTY 内前台 receiver 程序读取 stdin。
- **Managed PTY runtime**：基于 `node-pty` 管理长期 session，支持 `status`、`poll`、`write_text`、`key`、`interrupt`、`terminate`、`restart`，并用 prompt/receiver markers 维护 TerminalOwner。
- **长任务不会被误杀**：timeout 只释放 agent focus，不 kill 进程。Agent 后续可以 poll 新输出、发送交互输入、中断或重启 session。
- **可恢复 run artifacts**：每个 run 产出 `state.json` 和 `transcript.jsonl`；每个 session 有独立 log。审阅、debug、TUI、resume、eval 都可以围绕这些 artifact 展开。
- **`io_wait` 是一等决策**：等待用户消息或外部事件不是 `sleep`，而是 run state machine 中可记录、可恢复、可回放的 `waiting_for_io` 状态。
- **Environment 的 one-shot event 和 persistent fact 分层**：新事件只消费一次；active skill run 这类仍然成立的事实会持续提醒，直到状态关闭。
- **Skill CLI 有生命周期闭环**：skill 可发现、可执行、可保持 active、可 close；agent 可以按需把 skill run 转入 review pending，复盘后把 lessons 追加到 skill 附件。
- **Code Intelligence CLI 作为语义查询层**：LSP 能力不进入 harness 内核，而是通过 `codeq` CLI 暴露给 agent，用来查询 diagnostics、symbols、definition、references 和 hover。
- **TUI 以 view model 播放 agent loop**：`TranscriptReader` 读 JSONL，`ViewModelBuilder` 纯逻辑归一化事件，renderer 只负责展示 conversation 和 loop frame。
- **端口化协作边界**：model、prompt、validator、reviewer、terminal、environment、skill 都通过明确接口连接，便于替换 adapter、接真实 IM、接策略 reviewer 或做单元测试。
- **测试覆盖架构骨架**：已有 run state、environment、validator、skill discovery/store、TUI transcript/view-model 等测试，优先保护状态转移和边界契约。

## 潜力与演进方向

- **可恢复 agent runtime**：现有 `state.json`、`transcript.jsonl`、session log 已经具备 resume/replay 的基础，后续可以实现 run 级恢复、断点继续和失败复盘。
- **可审计的自动化执行层**：所有外部动作都收敛到 bash request + review + observation，天然适合接人工审批、权限策略、危险命令拦截和企业审计。
- **CLI 生态的 agent OS 雏形**：只要能力能做成 CLI，就能被 agent 使用，同时仍共享同一套 session、日志、审核和 TUI 观察机制。
- **技能系统可自我进化**：skill run 的 active/review/lessons 流程为经验沉淀留了位置。agent 可以根据 skill 执行结果判断是否复盘，把成功/失败模式沉淀进 skill 附件，未来再汇总为 skill 级别的改进。
- **更自然的人机协作**：IM transport 和 `io_wait` 可以扩展出多轮协作、用户确认、取消指令、外部 webhook 唤醒等能力。
- **异步工作流和后台任务**：session manager 已经支持长运行进程、poll 和 interrupt，适合承载 dev server、test watcher、REPL、后台 job 等 coding agent 常见场景。
- **多模型/多 provider 适配**：orchestrator 只消费 `ModelTurn`，DeepSeek FIM 是当前主路径；未来可以接其它模型 adapter，只要保持 decision 归一化协议。
- **评估和可观测性平台**：transcript 记录 thinking、decision、validation、review、tool execution、observation，后续可以做 step 级 eval、trace 可视化和 regression replay。
- **更强的 TUI / 控制台**：当前 TUI 已能播放 run loop，后续可增加 session tail、active skill、review pending、命令批准和 replay/follow 模式。
- **安全边界可逐层加固**：从 always approve 过渡到 command classifier、workspace policy、network/file 权限、敏感信息扫描，都可以挂在现有 `ToolReviewer` 边界上。

## Code Intelligence CLI

`codeq` 是仓库内置的代码智能 CLI，用来把 LSP / language server 的语义能力暴露给 coding agent。它不是模型可见的新 tool，也不改变 “所有外部动作都走 `bash`” 的核心约束；agent 使用它时，本质上仍然是在 bash session 里运行普通命令。

当前实现提供只读的 TypeScript / JavaScript 查询能力：

```bash
codeq diagnostics --workspace --json
codeq symbols src/run/orchestrator.ts --json
codeq definition src/run/orchestrator.ts:37:18 --json
codeq references src/run/orchestrator.ts:37:18 --json
codeq hover src/run/orchestrator.ts:37:18 --json
```

它解决的是 `rg` 和直接读文件不擅长的问题：某个 symbol 的真实定义、引用点、文件结构化 symbol、hover 类型信息，以及 language server 已经知道的诊断。`codeq` 输出统一 JSON envelope、稳定错误码、受限结果数量和短 preview，避免把大段 language server 输出直接塞回 prompt。

当前实现保持 stateless：每次命令启动 language server、执行一次查询、关闭退出。这样会比 daemon 慢一些，但状态清楚、可复现、容易写测试，也不会在 harness 内部引入隐藏的长期索引状态。等启动成本真的成为问题，再引入显式的 `codeq server start/status/restart/stop` daemon 模式。

这个方向的详细契约见 [Code Intelligence CLI](docs/code-intelligence-cli.md)。

## 当前核心方向

- Agent ReAct loop 独立实现。
- Agent 的所有外部动作都收敛为 `bash` tool call，session control 也走同一个工具。
- 主模型层使用 DeepSeek V4 FIM two-pass：先生成 thinking，再生成 native tool-call decision。
- 用户消息收发通过 IM CLI 处理，不把 stdin/stdout 作为核心通信边界。
- MCP、memory、skills、sub-agent 等能力都通过 CLI 暴露，再由 bash 调用。Skills 通过 `skill` CLI 发现和执行。
- Harness 内部提供 bash session manager，用来管理长期会话、输出截断、日志持久化和中断恢复。
- Environment 统一建模外部事件，每轮 Agent loop 消费为 system reminder，`io_wait` 等待 environment 事件。
- Tool review 模块预留为执行前审核入口，demo 阶段默认 approve。
- TUI 读取 transcript/state/logs，把 agent loop 作为可观察、可回放的执行过程展示出来。

当前设计文档：

- [Tool Call And Observation](docs/tool-call-observation.md)
- [Run Orchestrator And Agent Run State](docs/run-orchestrator-state.md)
- [Static Bash Tool Definition](docs/static-bash-tool-definition.md)
- [Code Intelligence CLI](docs/code-intelligence-cli.md)
- [DeepSeek V4 Native Tool-Call FIM Adapter](docs/deepseek-fim-adapter.md)
- [IM CLI Transport](docs/im-cli-transport.md)
- [Environment Model](docs/environment-model.md)
- [Skill CLI](docs/skill-cli.md)
- [TUI](docs/tui.md)
