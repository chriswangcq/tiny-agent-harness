# tiny-agent-harness 项目报告

> 生成日期：2026-05-25
>
> 统计口径：基于当前工作区快照；排除 `node_modules/`、`dist/`、`.git/`、`.complex-problems/`、锁文件、日志文件、`package-lock.json` 和明显生成文件。行数统计覆盖 `.ts`、`.js`、`.mjs`、`.md`、`.json` 等源码、脚本、测试与文档文件；本报告自身未纳入统计。统计结果用于工程规模估算，不等同于最终发行包体积。
>
> 当前口径：本报告已按 terminal/session tool surface 更新。模型可见动作是
> `terminal_write`、`terminal_key`、`session_*` 和内部 `io_wait`；普通文件、
> 回复和脚本通过 shell-native heredoc/stdin 流程完成；observation 返回一屏
> `screen.text`、terminal facts 和 `screen.logRef.path`。

## 1. 项目定位

`tiny-agent-harness` 是一个开放式 coding agent harness 实验项目。它不是一个大而全的 agent SDK，也不是简单把若干工具注册给模型的 provider-native tool demo。它的核心目标是把 coding agent 的推理循环、外部动作、长期 terminal session、用户消息、环境事件、skill 生命周期、日志和可恢复状态拆成清楚边界，让每一步都可审阅、可回放、可恢复、可替换。

项目当前可以概括为：

> tiny-agent-harness 是一个以 terminal/session tools 为外部动作面、以显式状态机、PTY 输入和 durable artifacts 为核心的 coding agent runtime 骨架。

从产品和工程形态看，它覆盖三类能力：

| 能力 | 说明 |
| --- | --- |
| Agent ReAct loop | `AgentRunState` 决定下一步 effect，`RunOrchestrator` 执行模型调用、工具校验、审核、bash 执行和 transcript 写入。 |
| 统一外部动作面 | 交互动作通过 terminal/session tools；文件和生成内容通过 shell-native heredoc、stdin redirection 或 CLI 落盘。MCP、memory、skills、sub-agent、code intelligence、测试、git 等能力都通过 CLI 进入 terminal session。 |
| 可观察与可恢复执行 | run state、transcript JSONL、session history、debug prompt artifacts、session log、environment events、skill run state、TUI view model 共同构成可审计执行轨迹。 |

## 2. 系统整体架构

项目采用小内核、强边界、事件驱动的结构。核心模块不是按业务工具拆分，而是按“状态归属”和“副作用边界”拆分。

```text
User / IM
  |
  v
ImCliTransport  ->  Environment  ->  system reminder
  |                    ^
  v                    |
RunOrchestrator <-> AgentRunState
  |                    |
  |                    v
  |              TranscriptStore
  |
  +-> DeepSeekFimAdapter
  |
  +-> ToolCallValidator -> ToolReviewer -> ManagedTerminalRuntime
                                      |
                                      v
                         CLI capabilities: skill / codeq / git / tests / MCP

TUI
  reads: transcript.jsonl, state.json, session logs, skill run state
```

按层级可以拆成六层：

| 层级 | 主要模块 | 职责 |
| --- | --- | --- |
| 模型适配层 | `src/model` | DeepSeek V4 FIM two-pass、native tool-call frame 解析、`ModelTurn` 归一化、prompt 构造。 |
| 运行编排层 | `src/run` | agent run 状态机、effect 选择、事件驱动状态转移、run lifecycle。 |
| 工具执行层 | `src/tools`、`src/bash` | 静态 terminal/session tool catalog、tool validation、review boundary、PTY-backed terminal session 和 observation。 |
| 外部事件层 | `src/environment`、`src/im` | IM 消息、terminal/skill/environment events、`io_wait`、事件消费游标和 factual reminder。 |
| 能力 CLI 层 | `src/skill`、`src/code-intel`、`src/cli` | skill discovery/run/review，`codeq` LSP 查询，`im` mock transport，用户命令入口。 |
| 可观察层 | `src/transcript`、`src/tui`、`src/state` | transcript/state 持久化、文件锁、JSONL ledger、TUI transcript player 和 view model。 |

这套架构的关键特点是：harness 内核不理解每个外部能力的业务语义。它只关心 bash 请求是否合规、是否被审核、是否执行完成、输出在哪里、事件如何进入下一轮模型上下文。

## 3. 核心执行链路

一次 agent step 的主路径大致如下：

```text
task / environment reminder
  -> PromptBuilder
  -> DeepSeekFimAdapter thinking pass
  -> DeepSeekFimAdapter decision pass
  -> ModelTurn
  -> AgentRunState.nextEffect()
  -> ToolCallValidator
  -> ToolReviewer
  -> ManagedTerminalRuntime
  -> TerminalObservation | SessionListObservation
  -> TranscriptStore
  -> next model step
```

这条链路体现了几个设计选择：

1. **模型输出不直接驱动副作用**

   DeepSeek FIM 输出必须先被 adapter 解析为 `ModelTurn`，再由 run state 决定下一步 effect。无效输出、schema 错误和 review 拒绝都会转成 recoverable observation。

2. **所有交互能力共享 terminal/session 边界**

   `skill run ...`、`codeq diagnostics ...`、`npm test`、`git`、MCP CLI 调用，本质上都是 terminal session 中的一条命令。生成文件、IM 回复和报告通过 heredoc、stdin redirection 或项目内 CLI 完成。它们共享 tool review、session log、one-screen observation 和 transcript。

3. **`io_wait` 是状态机决策**

   等待用户消息或外部事件不是 `sleep`，也不是 bash 工具。模型可以返回 `io_wait`，run 进入 `waiting_for_io`，直到 `Environment.waitFor(...)` 被匹配事件唤醒。

4. **大输出外化到日志**

   Active target design 中，Observation 只返回当前 terminal viewport 的一屏 `screen.text`、terminal facts、`returnedToPrompt` 和 log path。完整输出由 session log 保存，agent 需要更多细节时再通过 bash 使用 `tail`、`sed`、`rg` 查看。FIM prompt 这类大调试 payload 通过 `debug/prompts/` artifact 外置，transcript/history 只保留 `promptRef`。

5. **执行轨迹可播放**

   Transcript JSONL 记录 model requested、model output、validation、review、tool execution、observation、io wait、run finished 等事件；TUI 将这些事件归一化为 conversation 和 loop frame。

## 4. 关键模块说明

### 4.1 Run Orchestrator 与 Agent Run State

`src/run` 是项目的执行骨架。`AgentRunState` 维护互斥 lifecycle status，例如 `running`、`waiting_for_model`、`waiting_for_review`、`waiting_for_tool`、`waiting_for_io`、`failed`、`cancelled`。`nextEffect()` 是 state 对 orchestrator 的唯一指令出口。

`RunOrchestrator` 负责真正的副作用：调用模型、消费 environment events、校验 tool call、请求 review、执行 bash、等待 IO、写 transcript 和保存 state snapshot。

这一层最重要的价值是避免把 pending model output、pending tool call、pending review、pending IO wait 这些关键状态藏在局部变量里。状态显式化后，debug、resume、eval 和 TUI replay 才有稳定基础。

### 4.2 DeepSeek V4 FIM Adapter

`src/model/adapter.ts` 使用 DeepSeek V4 FIM Completion 做 two-pass generation：

```text
1. thinking pass: 只生成 reasoning artifact
2. decision pass: 只生成 DeepSeek native tool-call frame 的中间段
```

Decision pass 允许的 function name 是：

| function | 含义 |
| --- | --- |
| `terminal_write` | 向 current session 写入精确文本，用于 CLI 命令、heredoc、REPL 输入和交互回答。 |
| `terminal_key` | 向 current session 发送 enter、tab、方向键、escape、ctrl-d 等按键。 |
| `session_observe` / `session_list` / `session_focus` | 观察、列出或切换 PTY session。 |
| `session_interrupt` / `session_restart` / `session_terminate` | 中断、重启或终止 PTY session。 |
| `io_wait` | 内部等待请求，不是外部工具。 |

这种做法既利用 DeepSeek V4 tool-call post-training 的输出形式，又不把 provider-native tool calling 变成 harness 的核心协议。orchestrator 只消费归一化后的 `ModelTurn`。当任务完成时，Agent 通过 terminal session 调用 IM CLI 发送用户可见答复，然后返回 `io_wait` 等待下一条环境事件。

### 4.3 Terminal/Session Tools 与 Session Manager

`src/tools` 定义静态 tool catalog：`terminal_write` / `terminal_key` 负责 current session 输入，`session_observe` / `session_list` / `session_focus` / `session_interrupt` / `session_restart` / `session_terminate` 负责 session 管理。`ToolCallValidator` 将模型产生的 `InternalToolCall` 转成可审核的 `ToolRequest`。

`src/bash` 基于 `node-pty` 管理长期 session，支持：

- 输入工具：`terminal_write`、`terminal_key`
- 管理工具：`session_observe`、`session_list`、`session_focus`、`session_interrupt`、`session_terminate`、`session_restart`

timeout 只释放 agent focus，不 kill 进程；长任务可以继续运行，后续通过 `session_observe`、`terminal_write` / `terminal_key`、`session_interrupt` 或 `session_restart` 管理。runtime 还会在 session load 时附带 best-effort `foregroundProcess`，并在 stale `inputSeq` rejection 前尽量刷新一次 PTY 输出，让 agent 拿到新的 prompt facts。

### 4.4 Environment 与 IM Transport

`src/environment` 是外部世界事件模型。IM 新消息、terminal session 状态、命令完成/超时、skill run started/closed/review pending/review completed 都应进入 `EnvironmentEvent`。

事件分两类：

| 类型 | 行为 |
| --- | --- |
| one-shot event | 按 run cursor 消费一次，渲染成 factual environment reminder。 |
| persistent fact | 例如 active skill run，每轮持续提醒，直到状态关闭。 |

`src/im` 则提供用户消息 transport 的边界。设计上用户通信不是模型工具，而是 orchestrator port。agent 如果需要等待用户输入，应使用 `io_wait`，而不是 shell sleep 或直接阻塞模型循环。

### 4.5 Skill CLI

`src/skill` 将 skills 设计为普通 CLI 能力，而不是 harness 内置工具。agent 使用 skill 的方式仍然是：

```bash
skill list --json
skill show coding-review --json
skill run coding-review --json '{"path":"src"}'
skill close <skillRunId> --review none --json '<summary>'
skill close <skillRunId> --review required --json '<summary>'
skill review-complete <skillRunId> --json '<review>'
```

一个关键设计点是：skill 执行完成后是否复盘由 agent 判断。harness 提供 `running`、`review_pending`、`closed` 状态和 lessons 写入位置，但不把复盘作为固定后置流程强加给所有 skill run。

这为未来 skill 自我进化预留了路径：agent 可以根据执行结果、失败模式、任务风险判断是否沉淀经验，复盘后把 lessons 写入 skill 附件，未来再汇总为 skill 级别改进。

### 4.6 Code Intelligence CLI

`src/code-intel` 提供 `codeq` CLI，把 TypeScript / JavaScript 的 LSP 能力暴露给 agent。它不是新 tool，agent 调用它仍然是 bash 命令：

```bash
codeq diagnostics --workspace --json
codeq symbols src/run/orchestrator.ts --json
codeq definition src/run/orchestrator.ts:37:18 --json
codeq references src/run/orchestrator.ts:37:18 --json
codeq hover src/run/orchestrator.ts:37:18 --json
```

`codeq` 补齐 `rg` 和直接读文件不擅长的语义查询能力，例如真实定义、引用点、document symbols、hover 类型信息和 language server diagnostics。当前实现保持 stateless，每次命令启动 language server 或 compiler fallback，执行查询后关闭。

### 4.7 State Storage 与 File Locking

`src/state` 和 `docs/state-storage-locking.md` 描述了 `.tiny-agent/` 项目内状态目录、snapshot JSON、append-only JSONL、plain log 和目录锁规则。

核心思路是：

- run state、session history、session state、skill run state 属于 snapshot JSON
- transcript、environment events、IM inbox/outbox 属于 append-only JSONL
- bash output、skill execution output 和 run debug prompt artifact 属于可按路径 inspect 的文件
- 写 snapshot 和 ledger 时使用文件锁，reader 通过 offset / idempotency 处理并发

这让多个 CLI 能在同一个项目目录下共享状态，同时保持可 inspect、可 grep、可恢复。

### 4.8 TUI

`src/tui` 是 transcript player / control surface。它读取 `transcript.jsonl` 和 `state.json`，通过纯逻辑 `ViewModelBuilder` 转成：

- run header
- conversation items
- loop frames
- session views
- active skill views

TUI 不拥有 agent 状态，不参与模型决策，也不直接改写 run state。这避免了“第二个 orchestrator”问题。

## 5. 代码工作量统计

当前源码口径统计约为：

| 指标 | 数量 |
| --- | ---: |
| 统计文件数 | 约 102 个 |
| 统计总行数 | 约 19,549 行 |
| 测试文件数 | 24 个 |
| 测试相关行数 | 约 6,025 行 |

按目录拆分：

| 目录 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src` | 63 | 8,107 |
| `tests` | 24 | 6,025 |
| `docs` | 10 | 5,062 |
| `prompts` | 1 | 204 |

按主要模块拆分：

| 模块 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src/code-intel` | 13 | 1,823 |
| `src/tui` | 7 | 1,058 |
| `src/bash` | 3 | 817 |
| `src/types` | 7 | 778 |
| `src/cli` | 6 | 769 |
| `src/run` | 3 | 679 |
| `src/model` | 3 | 461 |
| `src/skill` | 4 | 459 |
| `src/state` | 6 | 423 |
| `src/tools` | 4 | 339 |
| `src/environment` | 2 | 230 |
| `src/im` | 2 | 216 |
| `src/transcript` | 2 | 45 |

按文件类型拆分：

| 类型 | 文件数 | 行数 |
| --- | ---: | ---: |
| TypeScript (`.ts`) | 87 | 13,985 |
| Markdown (`.md`) | 12 | 5,357 |
| JSON (`.json`) | 2 | 51 |
| JavaScript module (`.mjs`) | 1 | 183 |

从分布看，项目虽小，但已经不是一个单文件 prototype：测试行数接近源码行数的 74%，文档行数也较高，说明当前重点在协议、边界、状态机和可维护性设计。

## 6. 工程成熟度观察

当前验证状态：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 通过，23 个测试文件、221 个测试。 |
| `npm run typecheck` | 未通过，当前 TUI 相关存在 2 个类型错误：`BlessedRenderer.onMessage` 缺失，以及 `inputBox` 未初始化。 |

工程成熟度可以从几个方面观察：

1. **状态机优先**

   run lifecycle、tool validation、IO wait、skill run、state storage 都在向显式状态和事件记录收敛，而不是依赖隐式内存。

2. **边界清楚**

   Model adapter、run orchestrator、validator、reviewer、terminal manager、environment、skill、codeq、TUI 都有相对明确的职责边界。

3. **测试覆盖关键骨架**

   当前测试覆盖 run state、environment、validator、terminal session、skill discovery/store/CLI、state lock/jsonl/root、code-intel、IM transport、TUI view model 等关键边界。

4. **文档驱动明显**

   `docs/` 中存在 run orchestrator、tool call、DeepSeek FIM、environment、IM、skill、state storage、code intelligence、TUI 等设计文档，很多实现可以回溯到设计意图。

5. **仍处于快速演进期**

   当前工作区包含较多未提交或新增模块，说明项目在从设计文档向可运行 CLI 体系快速推进。这个阶段要特别注意 README、docs 和代码 active path 的一致性。

## 7. 与普通 Agent Harness 的差异

普通 agent harness 通常解决的是：

- 管一个模型循环
- 暴露若干工具
- 执行命令或文件操作
- 保存基本日志
- 给开发者一个扩展工具的入口

`tiny-agent-harness` 的差异化在于：

| 差异点 | 说明 |
| --- | --- |
| terminal/session boundary | 不把能力注册成一组 provider tools，而是把交互能力统一收敛到 terminal session；文件/生成内容通过 heredoc、stdin redirection 或 CLI 落盘。 |
| FIM two-pass decision | 用 FIM 控制 thinking 与 decision 的生成边界，并贴近 DeepSeek V4 native tool-call 格式。 |
| explicit run state | pending model/tool/review/io 都是 state，不靠 orchestrator 临时变量。 |
| durable artifacts | state、transcript、session history、debug prompt artifacts、session log、skill run state、environment events 都是可读文件。 |
| CLI ecosystem first | skill、codeq、im、未来 MCP/memory/sub-agent 都以 CLI 方式进入同一审计边界。 |
| TUI as player | TUI 播放 transcript，而不是重新拥有 agent 状态。 |

因此项目不适合被描述为“又一个工具调用 demo”。更准确的叙事是：

> 它在探索一个 coding agent runtime 的最小内核：模型只负责决策，外部世界通过 terminal session 和事件进入，执行轨迹以 durable artifacts 留下。

## 8. 当前优势

| 优势 | 说明 |
| --- | --- |
| 核心约束简单 | terminal/session tools 是唯一交互动作面；模型只需要掌握 current-session 输入、session 管理和 shell-native payload 流程。 |
| 调试友好 | state、JSONL、log path、offset、TUI view model 让执行过程可检查。 |
| 长任务友好 | PTY session 支持 timeout 后继续运行、poll、interactive PTY input、interrupt 和 restart。 |
| 可审计 | tool review 位于所有 terminal/session request 前，未来可接权限策略和人工审批。 |
| 可进化 skill | agent 可以按需触发复盘，把 lessons 写回 skill 附件，形成经验沉淀闭环。 |
| 代码理解能力不污染内核 | LSP 能力通过 `codeq` CLI 暴露，不改变能力通过 terminal/session 边界进入 harness 的约束。 |
| 测试保护状态边界 | 测试重点落在状态转移、CLI、锁、JSONL、validator 和 view model。 |

## 9. 当前风险与短板

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 持续验证要跟上 | 最新审计中 `npm run build` 和全量 `npm test` 已通过；后续改动仍要保持这条线常绿。 | 把 build/test/diff check 固定为提交前检查。 |
| 文档与实现快速变化 | README 已包含 codeq/state/IM/skill 新能力，部分实现仍在未提交工作区中快速演进。 | 每次功能落地后同步更新对应设计文档和 project report。 |
| 状态持久化仍需闭环 | 设计中有 `.tiny-agent/`、locks、JSONL ledger，但所有 CLI 是否都完全使用同一 resolver 还需要持续验证。 | 用集成测试覆盖多 CLI 共用 state root、并发写、resume/replay。 |
| terminal/session 约束对模型要求高 | 模型必须学会通过 shell 调 skill/codeq/im 等 CLI，并在 heredoc、前台 stdin consumer、`--text-stdin` 和 session 管理之间做正确选择，而不是直接获得 typed business tool affordance。 | 在 system prompt 和 examples 中强化 heredoc / `--text-stdin` / session observe 的边界，并避免示例污染大生成文件路径。 |
| review 目前默认 approve | 安全边界存在，但策略能力还未产品化。 | 增加危险命令分类、workspace policy、网络/文件权限和人工确认模式。 |
| TUI 仍偏观察 | 当前 TUI 更像 transcript player，控制动作和 session tail 仍可增强。 | 增加 session log tail、active skill、review pending、approval 操作和 replay/follow。 |

## 10. 后续建设建议

### 10.1 先把当前 active path 跑绿

短期应优先确保：

1. `npm run typecheck` 通过。
2. `tiny-agent`、`im`、`skill`、`codeq` 的 bin 入口都能从 build 后产物运行。
3. `.tiny-agent/` state root、runs、sessions、environment、skills、IM channels 使用统一 resolver。
4. README、design docs、system prompt 与实现保持一致。

### 10.2 把可恢复执行做成主线

项目最有价值的不是“能调用 bash”，而是失败后能知道：

- 当前 run 处于哪个状态
- 哪个 model decision 触发了哪个 request
- request 是否通过 review
- bash 输出完整日志在哪里
- environment event 是否已被消费
- skill run 是否仍 active
- 是否需要复盘并沉淀 lessons

这条主线应继续围绕 state、transcript、logs、environment、TUI 和 replay 打磨。

### 10.3 把 CLI 能力生态收敛成统一契约

`skill`、`codeq`、`im` 已经展示了模式：

```text
capability as CLI
  -> run through terminal session
  -> reviewed as a terminal/session request
  -> output as JSON
  -> logged in session
  -> summarized into observation / environment reminder
```

后续 MCP、memory、sub-agent、project-specific tools 都可以沿用这个契约。这样 agent 能力会增长，但 harness 内核不会被业务工具污染。

### 10.4 对外叙事聚焦三句话

建议对外表达可以聚焦为：

1. tiny-agent-harness keeps terminal/session tools as the action surface and protected-paces every terminal write.
2. tiny-agent-harness turns agent execution into explicit state and durable logs.
3. tiny-agent-harness lets skills, code intelligence, IM, and future tools evolve as CLIs without bloating the core runtime.

中文版本：

1. tiny-agent-harness 让 terminal/session tools 成为动作面，并对每次 terminal write 进行保护性 pacing。
2. tiny-agent-harness 把 agent 执行过程变成显式状态和可持久化日志。
3. tiny-agent-harness 让 skill、代码智能、IM 和未来工具以 CLI 生态演进，而不是膨胀内核。

## 11. 结论

`tiny-agent-harness` 已经形成一个清晰的 coding agent runtime 骨架：DeepSeek V4 FIM two-pass model adapter、显式 run state、orchestrator effect loop、terminal/session tool 边界、PTY 输入模型、PTY session manager、environment event model、skill lifecycle、code intelligence CLI、state storage、transcript 和 TUI player。

按当前快照估算，项目约 1.95 万行统计源码/文档/测试，其中测试约 6 千行、文档约 5 千行。它的工程投入重点不是堆功能，而是把 agent 执行过程变得可解释、可审计、可恢复。

当前最值得继续推进的是：把 build/test/diff check 固化到提交流程、统一 state root 落地、打通 CLI bin 入口、强化 TUI 观察和控制能力，并把 skill 复盘 lessons 机制发展成未来 skill 进化的基础。
