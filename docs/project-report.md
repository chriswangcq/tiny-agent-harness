# tiny-agent-harness 项目报告

> 生成日期：2026-06-03
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
| 统一外部动作面 | 交互动作通过 terminal/session tools；文件和生成内容通过 shell-native heredoc、stdin redirection 或 CLI 落盘。MCP、memory、skills、sub-agent、code intelligence、测试、git 等能力都通过 CLI 进入 terminal session；其中 codeq/skill/MCP 的公开 CLI 只连接 run-owned resident host socket。 |
| 可观察与可恢复执行 | run state、transcript JSONL、session history、debug prompt artifacts、session log、environment events、skill run state、TUI view model 共同构成可审计执行轨迹。 |

## 2. 系统整体架构

项目采用小内核、强边界、事件驱动的结构。核心模块不是按业务工具拆分，而是按“状态归属”和“副作用边界”拆分。

```text
User / IM
  |
  v
public IM channel log  ->  run-owned im-host poller  ->  Environment  ->  system reminder
  |                    ^
  v                    |
RunOrchestrator <-> AgentRunState
  |                    |
  |                    v
  |              TranscriptStore
  |
  +-> ModelGateway process
  |
  +-> ToolCallValidator -> ToolReviewer -> TerminalHost process
                                      |
                                      v
                         CLI capabilities: skill / codeq / git / tests / MCP

TUI
  reads: run-scoped transcript/state/session logs/environment/skill/debug artifacts
```

按层级可以拆成六层：

| 层级 | 主要模块 | 职责 |
| --- | --- | --- |
| 模型适配层 | `src/model` | DeepSeek V4 FIM two-pass、native tool-call frame 解析、`ModelTurn` 归一化、prompt 构造。 |
| 运行编排层 | `src/run` | agent run 状态机、effect 选择、事件驱动状态转移、run lifecycle。 |
| 模型上下文层 | `src/model/context-session.ts`、`src/model/context-window.ts`、`src/model/prompt-builder.ts` | 本地有状态 FIM context wrapper：接收 incremental context item，负责 prompt message 渲染、context compaction、snapshot/restore。 |
| 工具执行层 | `src/tools`、`src/terminal-host`、`src/bash` | 静态 terminal/session tool catalog、tool validation、review boundary、TerminalHost 进程、PTY-backed terminal session 和 observation。 |
| 外部事件层 | `src/environment`、`src/im` | IM 消息、terminal/skill/environment events、`io_wait`、事件消费游标和 factual reminder。 |
| 能力 CLI 层 | `src/skill`、`src/code-intel`、`src/mcp`、`src/cli` | host-backed `tiny-agent skill` / `tiny-agent codeq` / `tiny-agent mcp`，public IM CLI，用户命令入口。 |
| 可观察层 | `src/transcript`、`src/tui`、`src/state` | transcript/state 持久化、文件锁、JSONL ledger、TUI transcript player、debugger domain 和 view model。 |
| 评估与治理层 | `src/run/recovery.ts`、`src/run/replay.ts`、`src/tools/policy.ts`、`src/subagent` | resume/replay/eval case、模型协议诊断、tool policy reviewer 和 sub-agent team FSM 基础域。 |

这套架构的关键特点是：harness 内核不理解每个外部能力的业务语义。它只关心 bash 请求是否合规、是否被审核、是否执行完成、输出在哪里、事件如何进入下一轮模型上下文。

## 3. 核心执行链路

一次 agent step 的主路径大致如下：

```text
task / environment reminder
  -> ModelContextSession
  -> PromptBuilder
  -> ModelGateway process
  -> provider adapter thinking pass
  -> provider adapter decision pass
  -> ModelTurn
  -> AgentRunState.nextEffect()
  -> ToolCallValidator
  -> ToolReviewer
  -> TerminalHost process
  -> TerminalObservation | SessionListObservation
  -> TranscriptStore
  -> next model step
```

这条链路体现了几个设计选择：

1. **模型输出不直接驱动副作用**

   DeepSeek FIM 输出必须先被 adapter 解析为 `ModelTurn`，再由 run state 决定下一步 effect。无效输出、schema 错误和 review 拒绝都会转成 recoverable observation。

2. **所有交互能力共享 terminal/session 边界**

   `tiny-agent skill run ...`、`tiny-agent codeq diagnostics ...`、`npm test`、`git`、MCP CLI 调用，本质上都是 terminal session 中的一条命令。Skill、CodeQ 和 MCP 命令通过当前 run 注入的 host socket 进入 resident host；生成文件、IM 回复和报告通过 heredoc、stdin redirection 或项目内 CLI 完成。它们共享 tool review、session log、one-screen observation 和 transcript。

3. **`io_wait` 是状态机决策**

   等待用户消息或外部事件不是 `sleep`，也不是 bash 工具。模型可以返回 `io_wait`，run 进入 `waiting_for_io`，直到 `Environment.waitFor(...)` 被匹配事件唤醒。

4. **大输出外化到日志**

   Active target design 中，Observation 返回 bounded visual window 的 `screen.text`、`screen.window`、terminal facts、`returnedToPrompt` 和 log path。附近 semantic scrollback 可用 `session_observe` 的 `startLine` / `lineCount` 翻页；完整 raw 输出由 session log 保存，agent 需要搜索或精确 raw 历史时再通过 bash 使用 `tail`、`sed`、`rg` 查看。FIM prompt 和 streamed thinking 这类大调试 payload 分别通过 `debug/prompts/`、`debug/thinking` artifact 外置，transcript/history 只保留 `promptRef` / `traceRef`。

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
| `terminal_key` | 向 current session 发送 enter、tab、space、q、方向键、escape、ctrl-d 等非中断按键。 |
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

### 4.4 Environment 与 Public IM

`src/environment` 是外部世界事件模型。IM 新消息、terminal session 状态、命令完成/超时、skill run started/closed/review pending/review completed 都应进入 `EnvironmentEvent`。

事件分两类：

| 类型 | 行为 |
| --- | --- |
| one-shot event | 按 run cursor 消费一次，渲染成 factual environment reminder。 |
| persistent fact | 例如 active skill run，每轮持续提醒，直到状态关闭。 |

事件还有显式 priority level。默认 `io_wait` 只等待 meaningful 及以上事件，避免
level-0 session output noise 造成 wake storm；用户消息固定归一到 level `100`，
可以立即打断普通 wait。TUI detail 会展示 wait/event 的 wake reason，但这只是
观察面解释，不改变 runtime prompt 中的事实事件。

`src/im` 则提供用户消息 transport 的边界。设计上用户通信不是模型工具，而是 orchestrator port。agent 如果需要等待用户输入，应使用 `io_wait`，而不是 shell sleep 或直接阻塞模型循环。

### 4.5 Skill CLI

`src/skill` 将 skills 设计为普通 CLI 能力，而不是 harness 内置工具。当前实现是 run-scoped all-host：`tiny-agent run` 启动 `skill-host`，TerminalHost 注入 `TAH_SKILL_HOST_SOCKET`，普通 `tiny-agent skill ...` 只作为 socket client。agent 使用 skill 的方式仍然是：

```bash
tiny-agent skill list --json
tiny-agent skill show coding-review --json
tiny-agent skill run coding-review --json '{"path":"src"}'
tiny-agent skill close <skillRunId> --review none --json '<summary>'
tiny-agent skill close <skillRunId> --review required --json '<summary>'
tiny-agent skill review-complete <skillRunId> --json '<review>'
tiny-agent skill validate coding-review --json
```

`tiny-agent skill show` 只返回元数据（`name`, `manifest?`, `readmePath`, `contentLineCount`），不返回 SKILL.md 正文。读取正文需由 agent 在终端对 `readmePath` 执行 `sed -n` 等 shell 命令分段获取。

当前 runtime 已支持本地 `tiny-agent skill install`，但安装、discovery、run、
close、review-complete 和 validate 都通过 run-owned skill host 服务公开 CLI；缺少
host socket 时不会回退到 direct store/runner。

一个关键设计点是：skill 执行完成后是否复盘由 agent 判断。harness 提供 `running`、`review_pending`、`closed` 状态和 lessons 写入位置，但不把复盘作为固定后置流程强加给所有 skill run。

这为未来 skill 自我进化预留了路径：agent 可以根据执行结果、失败模式、任务风险判断是否沉淀经验，复盘后把 lessons 写入 skill 附件，未来再汇总为 skill 级别改进。

### 4.6 Code Intelligence CLI

`src/code-intel` 提供 `tiny-agent codeq` 子命令，把 TypeScript / JavaScript 的 LSP 能力暴露给 agent。它不是新 tool，agent 调用它仍然是 bash 命令：

```bash
tiny-agent codeq diagnostics --workspace --json
tiny-agent codeq symbols src/run/orchestrator.ts --json
tiny-agent codeq workspace-symbols RunOrchestrator --json
tiny-agent codeq definition src/run/orchestrator.ts:37:18 --json
tiny-agent codeq references src/run/orchestrator.ts:37:18 --json
tiny-agent codeq implementations src/run/orchestrator.ts:37:18 --json
tiny-agent codeq incoming-calls src/run/orchestrator.ts:37:18 --json
tiny-agent codeq outgoing-calls src/run/orchestrator.ts:37:18 --json
tiny-agent codeq hover src/run/orchestrator.ts:37:18 --json
```

`tiny-agent codeq` 补齐 `rg` 和直接读文件不擅长的语义查询能力，例如真实定义、引用点、实现点、call hierarchy、document/workspace symbols、hover 类型信息和 language server diagnostics。当前实现是 run-scoped all-host：`tiny-agent run` 启动同生共死的 `codeq-host` sidecar，TerminalHost 注入 `TAH_CODEQ_HOST_SOCKET`，普通 `tiny-agent codeq ...` 只作为 socket client 调用该 host；没有 direct CLI fallback，也不跨 run 共享 host。

同一套 Resident Host Contract 也用于 `skill-host` 和 `mcp-host`：run 负责启动、
监督、注入 socket 和回收；公开 CLI 只做 socket request/response，不创建隐藏
fallback。Skill 的 durable owner 仍是 `skills/` 与 `skill-runs/`，MCP registry 的
durable owner 仍是 project-scoped `mcp-servers.json`。

当前 `tiny-agent codeq` 是只读查询子命令，`--apply` 会被解析层拒绝。未来如果增加 rename 或
code action，也应先以 dry-run `WorkspaceEdit` 摘要形式进入 terminal/session
review，再由 agent 用普通补丁流程落盘。

### 4.7 State Storage 与 File Locking

`src/state` 和 `docs/state-storage-locking.md` 描述了 `~/.tiny-agent/projects/<projectId>/` home-scoped 状态目录、snapshot JSON、append-only JSONL、plain log 和目录锁规则。

核心思路是：

- run state、session history、session state、skill run state 属于 snapshot JSON
- transcript、environment events、public IM channel messages 属于 append-only JSONL
- bash output、skill execution output 和 run debug prompt artifact 属于可按路径 inspect 的文件
- 写 snapshot 和 ledger 时使用文件锁，reader 通过 offset / idempotency 处理并发

这让多个 CLI 能在同一个 home project state root 下共享状态，同时保持可 inspect、可 grep、可恢复，并避免 runtime 文件污染源码目录。

### 4.8 TUI

`src/tui` 是 transcript player / control surface。它读取 `transcript.jsonl` 和 `state.json`，通过纯逻辑 `ViewModelBuilder` 转成：

- run header
- conversation items
- loop frames
- session views
- active skill views

TUI 不拥有 agent 状态，不参与模型决策，也不直接改写 run state。这避免了“第二个 orchestrator”问题。

`src/tui/debugger.ts` 是 TUI 的纯 debugger domain。它消费显式传入的 `TuiViewModel`、`LoopFrame` 和 run snapshot，提供 loop frame query、detail section 解析、problem summary、run index 和 run comparison。它不扫描文件系统，也不依赖 blessed renderer；历史 run browser、warn/error filter 和 eval viewer 后续都应该复用这层。


`buildRunBrowserControlIntent(rows, request)` 是同一文件中的纯控制意图边界。TUI 调用它生成可审计的 `RunBrowserControlIntent`（包含 action、runId、index、`effect: "none"`、`owner: "runtime_cli"`、`review: "required"`），但不执行任何副作用，也不读取时间、文件系统或运行态全局状态。`buildRunBrowserControlIntentDisplay(...)` 和 run browser view model 只把这些意图投影成 operator 可见 metadata；renderer 负责宽度安全展示 attach/resume/control、target、owner、review 和 effect。实际的 attach、resume、control 执行归 runtime/CLI 所有，tool review 链必须在 effectful 路径中保留。TUI 绝不直接修改 run state；direct mutation 请求会确定性地返回 `unsafe_mutation`，其他错误路径会返回 `missing_run_id` 或 `unknown_run_id`。

### 4.9 Recovery / Replay / Eval

`src/run/recovery.ts` 和 `src/run/replay.ts` 把 resume 与 replay 相关判断从 orchestrator 中抽出成纯函数：

- `diagnoseRunRecovery(...)` 检查 `state.json`、transcript、session snapshot 和 step cursor 是否能安全恢复。
- `buildReplayCase(...)` 从显式 run snapshot / transcript events 构造可回放 case。
- `buildEvalCaseSummary(...)` 生成 compact eval summary，包含 model/tool/io_wait 计数、invalid output 计数和 recovery finding codes。

这层的重点不是自动重放副作用，而是给 resume/debug/eval 提供可测试的事实摘要。`waiting_for_tool` 等 in-flight 状态仍然不能被自动重放。

### 4.10 Model Protocol Diagnostics

DeepSeek V4 DSML 解析失败不再只是一个字符串错误。`src/model/dsml-decision-parser.ts` 会返回稳定 diagnostic code，例如 legacy V3 token、raw JSON parameters、unsupported function、invalid parameter JSON 等。`ModelTurn.invalid_output` 携带该 diagnostic，TUI detail 可以展示协议层原因。

这使得“模型为什么 warn / invalid_output”可以被复盘，而不是只能从 raw text 猜。

### 4.11 Tool Policy And Redaction

默认 CLI runtime 仍使用 `AlwaysApproveReviewer`，这保持 demo 行为不变。但 `src/tools/policy.ts` 已经提供纯 `evaluateToolPolicy(request, options)`，可识别危险 terminal writes、警告网络/全局安装/git push 等高风险动作，并通过 `ToolPolicyReviewer` 适配现有 reviewer port。

`src/tui/redaction.ts` 只服务 TUI/display，不属于 agent runtime 历史压缩路径。它覆盖 API key / token / password / secret assignment、Bearer token、私钥块、`sk-`/`ds-` style key、长 terminal_write payload 和 base64-like payload，目的是避免 TUI detail 被敏感文本或长展示字符串污染。

模型可见 `ModelContextSession` items 不走这层 display redaction。terminal observation 和 tool-call context item 应保持事实完整；真正需要压缩上下文时，应走显式 context compaction，并向模型说明压缩发生了，而不是静默把字段替换成 redacted placeholder。

### 4.12 Sub-agent Team Domain

`src/subagent` 当前是 sub-agent team 的轻量控制面：核心是 project-scoped roster/lifecycle 模型。team adapter 负责 team roster snapshot 落盘，不再拥有 task FSM 或 IM dispatch。派工由上层显式调用 public IM direct-file admin 边界，例如 `tiny-agent im admin post --from user:main --to member:<teamId>/<memberId> --text ...` 完成；team-member-owned run 通过 `tiny-agent im admin bind --run-id <runId> --self member:<teamId>/<memberId> --peer user:main` 关联 endpoint pair。它提供：

- `TeamRosterState`：member / status / run binding / assignment label / applied event ids。
- `applyTeamRosterEvent(...)`：纯 FSM reducer，处理 add/update/status/heartbeat/terminate。
- `team-cli-adapter.ts`：显式 fs / clock / id ports，从 project-scoped team event stream 投影当前 roster，执行命令，先 append `teams/<teamId>/events.jsonl`，再写回 `teams/<teamId>/state.json` snapshot。
- `team_created`、`roster_event`：team directory 的唯一事件类型；旧 `task_event` 被拒绝。
- `summarizeTeamRoster(...)` / `lookupMember(...)` / role/status 列表 helper 给 TUI、CLI、MCP、cloud adapter 消费。

这个边界让未来 “subagent team 管理服务” 可以先复用可测 roster 状态机，再在外层接进 MCP、云端队列、本地 worker launcher 或 IM。workspace、branch、ledger 仍通过 IM 指令、metadata 或 handoff evidence 表达，不成为 roster schema 的必填字段。`teams/<teamId>/events.jsonl` 是 team 事实源和 canonical read source，`teams/<teamId>/state.json` 是由事件流写出的 roster projection snapshot。


### 4.13 Subagent Lifecycle Runtime 与可观察性

`src/subagent` 在纯状态域之外，还提供了 supervisor lifecycle 存储、lifecycle runtime adapter、status projector、worker 进程状态和 TUI lifecycle audit projection。

#### Supervisor store

`src/subagent/supervisor-store.ts` 定义 supervisor lifecycle 事件类型（`member_added`、`member_status_changed`、`member_heartbeat`、`member_terminated`、`lease_*`、`heartbeat_recorded`、`shutdown_*`、`reaper_*`）和 active team-scoped 路径规划。事件按 append-only JSONL 写入 `~/.tiny-agent/projects/<projectId>/teams/<teamId>/supervisor/lifecycle-events.jsonl`，snapshot 写入 `supervisor/snapshot.json`。

#### Lifecycle runtime adapter

`src/subagent/lifecycle-runtime-adapter.ts` 是纯 adapter，接收显式 `TeamSnapshot`（含 `rosterState` 与 `processExistence?: Record<string, boolean>`）和注入 port（时钟、事件追加、进程 shutdown、roster event），提供 `recordHeartbeat`、`enumerateWorkers`、`runReaper`、`requestShutdown`。它内部调用 `supervisor-lifecycle.ts` 的纯决策函数（`interpretHeartbeat`、`evaluateLease`、`computeLifecycleState`、`decideReaperAction`）来推导 `WorkerLifecycleState`（healthy / stale / expired / grace_period / shutdown / terminated / missing_process / unknown）。

CLI 可发现性：`tiny-agent --help` 暴露 `tiny-agent team <group>`，`tiny-agent team --help` 暴露 `tiny-agent team create|member|lifecycle`，外部派工通过 `tiny-agent im admin post`。普通 team 命令的 effect boundary 在 `src/subagent/team-cli-adapter.ts`；lifecycle 命令的 effect boundary 在 `src/subagent/lifecycle-cli-adapter.ts`。新的 ownership model 要求 lifecycle write path 显式绑定 `teamId`，不能从 run id 隐式猜 team。

**Reaper shutdown chain**: the `runReaper` adapter function identifies stale active workers (heartbeat age past threshold, member status not `terminated` or `offline`). For each stale worker it emits a `shutdown_requested` lifecycle event, attempts graceful shutdown, then records `shutdown_completed` or `shutdown_failed`. Successful shutdown marks the roster member status `terminated`. This unified chain ensures stale workers are cleanly retired and do not accumulate in the team snapshot.

**Process existence 是 adapter-boundary snapshot input。** `TeamSnapshot.processExistence` 是 `Record<string, boolean>`，由外层（worker launcher spawn 后写入 `workers/<workerId>/state.json`，或 CLI adapter 在 reaper/shutdown 执行前读取 OS process table）注入 adapter。Lifecycle 决策层不自己读 `/proc` 或调用 `process.kill`——它只消费注入的 boolean snapshot 并推导 `missing_process` 状态。

#### Status projector

`src/subagent/status-projector.ts` 是纯函数 `projectWorkerStatus(input)`，从显式输入 snapshot（`TeamMember`、可选的 `RunSnapshot`、`ImSnapshot`、`LedgerSnapshot`、`LifecycleTemplate` 和显式 `now` ISO timestamp）推导 `WorkerStatusCode`（healthy / degraded / stuck / idle / offline / done / terminated / unknown）。输出包含 risk flags（`stale_heartbeat`、`missing_evidence`、`im_silence`、`ledger_stall`、`run_stall`），供 master agent 和 TUI 消费。

#### Worker 进程状态

`src/subagent/local-worker-launcher.ts` 的 active `planTeamScopedWorkerPaths` 定义 team member worker 目录：`~/.tiny-agent/projects/<projectId>/teams/<teamId>/members/<memberId>/`，包含 `state.json`（worker 运行状态）和 `output.log`（worker 输出日志），并通过 `teams/<teamId>/runs/<runId>.json` 记录 team-owned run reference。Process existence 在 spawn 成功后由 launcher 写入，后续被 lifecycle adapter 读取为 `TeamSnapshot.processExistence`。`src/subagent/supervisor-lifecycle.ts` 的 `ProcessTableEntry`（pid / workerId / startTime / exists）是 lifecycle 决策层可见的进程快照契约。

#### TUI lifecycle audit projection（display projection）

`src/tui/lifecycle-audit-projection.ts` 的 `TeamLifecycleAuditReader` 读取 active team supervisor audit source：`~/.tiny-agent/projects/<projectId>/teams/<teamId>/supervisor/lifecycle-events.jsonl`。纯函数 `projectLifecycleAuditEvents()` 负责 typed event-to-display mapping，产出 TUI view model 可用的 `auditEvents`。

**这是 display projection chain，不是 orchestrator**：audit reader 从 durable lifecycle-events.jsonl 读取事实，纯 projection 函数将事件映射为显示行（severity / row key / bounded text），TUI renderer 渲染。整条链不拥有 agent 状态，不参与模型决策，也不直接改写 supervisor lifecycle 事件。



## 5. 代码工作量统计

当前源码口径统计约为：

| 指标 | 数量 |
| --- | ---: |
| 统计文件数 | 175 个 |
| 统计总行数 | 39,317 行 |
| 测试文件数 | 57 个 `.test.ts` |
| 测试相关行数 | 15,329 行 |

按目录拆分：

| 目录 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src` | 101 | 18,195 |
| `tests` | 58 | 15,329 |
| `docs` | 15 | 5,592 |
| `prompts` | 1 | 201 |

按主要模块拆分：

| 模块 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src/tui` | 10 | 3,633 |
| `src/model` | 8 | 2,274 |
| `src/run` | 6 | 1,860 |
| `src/code-intel` | 13 | 1,818 |
| `src/cli` | 8 | 1,546 |
| `src/tools` | 5 | 907 |
| `src/types` | 7 | 894 |
| `src/terminal` | 6 | 834 |
| `src/application` | 6 | 699 |
| `src/bash` | 4 | 635 |
| `src/streaming` | 3 | 511 |
| `src/mcp` | 6 | 500 |
| `src/subagent` | 2 | 495 |
| `src/skill` | 4 | 478 |
| `src/state` | 6 | 423 |
| `src/environment` | 2 | 382 |
| `src/im` | 2 | 216 |
| `src/transcript` | 2 | 77 |

按文件类型拆分：

| 类型 | 文件数 | 行数 |
| --- | ---: | ---: |
| TypeScript (`.ts`) | 158 | 33,341 |
| Markdown (`.md`) | 16 | 5,793 |
| JavaScript module (`.mjs`) | 1 | 183 |

从分布看，项目已经不再是一个单文件 prototype：测试行数约为源码行数的 84%，文档和 prompt 也形成了较完整的设计账本，说明当前重点在协议、边界、状态机、可观察性和可维护性设计。

## 6. 工程成熟度观察

当前验证状态：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过。 |
| `npm run build` | 通过。 |
| `npm test` | 通过，57 个测试文件、575 个测试。 |

工程成熟度可以从几个方面观察：

1. **状态机优先**

   run lifecycle、tool validation、IO wait、skill run、state storage 都在向显式状态和事件记录收敛，而不是依赖隐式内存。

2. **边界清楚**

   Model adapter、run orchestrator、validator、reviewer、terminal manager、environment、skill、codeq、TUI 都有相对明确的职责边界。

3. **测试覆盖关键骨架**

   当前测试覆盖 run state、environment、validator、terminal session、skill discovery/store/CLI、state lock/jsonl/root、code-intel、public IM、TUI view model 等关键边界。

4. **文档驱动明显**

   `docs/` 中存在 run orchestrator、tool call、DeepSeek FIM、environment、IM、skill、state storage、code intelligence、TUI 等设计文档，很多实现可以回溯到设计意图。

5. **仍处于快速演进期**

   项目仍在快速迭代，尤其是 terminal/session、environment、TUI、MCP、sub-agent domain 和 context session 等边界仍会继续收敛。这个阶段要特别注意 README、docs、system prompt 和代码 active path 的一致性。

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
| CLI ecosystem first | skill、codeq、im、MCP 和未来 memory/sub-agent runtime 都以 CLI 方式进入同一审计边界。 |
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
| 代码理解能力不污染内核 | LSP 能力通过 `tiny-agent codeq` 暴露，不改变能力通过 terminal/session 边界进入 harness 的约束。 |
| 测试保护状态边界 | 测试重点落在状态转移、CLI、锁、JSONL、validator 和 view model。 |

## 9. 当前风险与短板

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| 持续验证要跟上 | 最新审计中 `npm run typecheck`、`npm run build` 和全量 `npm test` 已通过；后续改动仍要保持这条线常绿。 | 把 typecheck/build/test/diff check 固定为提交前检查。 |
| 文档与实现快速变化 | README、docs、system prompt 已覆盖 terminal/session、MCP、IM、skill、TUI、state layout、sub-agent domain 和 recovery/replay；这些边界仍会继续演进。 | 每次功能落地后同步更新对应设计文档和 project report。 |
| 状态持久化仍需持续校准 | 主路径已经把 IM、environment、skill-runs、resident host socket/state、debug artifacts 和 session logs 收敛到明确目录；但人工调试路径、host socket 注入和锁粒度仍要持续验证。 | 用集成测试覆盖 run-scoped env 注入、多 CLI 共用 state root、并发写、resume/replay。 |
| terminal/session 约束对模型要求高 | 模型必须学会通过 shell 调 skill/codeq/im 等 CLI，并在 heredoc、前台 stdin consumer、`--text-stdin` 和 session 管理之间做正确选择，而不是直接获得 typed business tool affordance。 | 在 system prompt 和 examples 中强化 heredoc / `--text-stdin` / session observe 的边界，并避免示例污染大生成文件路径。 |
| 低级 session noise 仍需观察 | 当前 `io_wait` 采用 priority-based wait；默认 wait 已提升为 meaningful event 阈值，level-0 `session_output_available` 不再唤醒普通 wait，用户消息仍以 level `100` 打断窄 wait。剩余风险在于长期运行 session 的事件体量和 reminder 可读性。 | 持续治理 event taxonomy：对低价值 session noise 做去重、聚合或 persistent fact 化，并用 TUI/debugger 展示 wake reason。 |
| review 目前默认 approve | 默认 runtime 仍是 demo approve，但已有纯 policy evaluator / ToolPolicyReviewer 可作为产品模式基础。 | 增加显式配置开关、workspace policy、网络/文件权限和人工确认模式。 |
| TUI 仍偏观察 | 当前 TUI 已有 conversation/loop/detail/PTY panes 和 read-only fixed viewport，但 runtime control、run browser、eval viewer 仍可增强。 | 在不让 TUI 成为第二个 orchestrator 的前提下，增加 approval 操作、run compare、eval viewer 和更稳定的 PTY fit 提示。 |

## 10. 后续建设建议

### 10.1 先把当前 active path 跑绿

短期应优先确保：

1. `npm run typecheck`、`npm run build`、`npm test` 持续通过。
2. `tiny-agent` 主 bin 以及 `tiny-agent im/skill/mcp/codeq/team` 子命令都能从 build 后产物运行。
3. `~/.tiny-agent/projects/<projectId>/` project state root 与 `runs/<runId>/` run-scoped state 使用统一 resolver/env 注入规则。
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

`tiny-agent skill`、`tiny-agent codeq`、`tiny-agent mcp`、`tiny-agent im` 已经展示了模式：

```text
capability as CLI
  -> run through terminal session
  -> if the capability owns live resources, route through the run-owned host socket
  -> reviewed as a terminal/session request
  -> output as JSON
  -> logged in session
  -> summarized into observation / environment reminder
```

后续 memory、sub-agent runtime、project-specific tools 都可以沿用这个契约。这样 agent 能力会增长，但 harness 内核不会被业务工具污染。

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

`tiny-agent-harness` 已经形成一个清晰的 coding agent runtime 骨架：DeepSeek V4 FIM two-pass model adapter、有状态 FIM context wrapper、显式 run state、orchestrator effect loop、terminal/session tool 边界、PTY 输入模型、PTY session manager、environment event model、skill lifecycle、MCP CLI、code intelligence CLI、state storage、transcript、recovery/replay 和 TUI player。

按当前快照估算，项目约 3.93 万行统计源码/文档/测试，其中测试约 1.53 万行、文档约 5.6 千行。它的工程投入重点不是堆功能，而是把 agent 执行过程变得可解释、可审计、可恢复。

当前最值得继续推进的是：把 typecheck/build/test/diff check 固化到提交流程，继续治理 environment event 体量，增强 TUI 的 run browser/eval viewer/approval 体验，并把 skill 复盘 lessons 与未来 sub-agent team 管理服务连接起来。

## Status Projector

`src/subagent/status-projector.ts` provides a pure-function worker status projector: `projectWorkerStatus(input: ProjectorInput): WorkerStatusProjection`. It derives a `WorkerStatusCode` (`healthy` | `degraded` | `stuck` | `idle` | `offline` | `done` | `terminated` | `unknown`) from explicit input snapshots (member, run, IM, ledger), a lifecycle template, and an explicit `now` ISO timestamp in `ProjectorConfig`.

Key design properties:
- **No side effects**: zero `Date.now()`, `new Date()`, `process.env`, `fs`, or network calls. Timestamp parsing uses a RegExp-based UTC ISO 8601 parser with `Date.UTC` and no clock read.
- **Invalid input is guarded**: unrecognised timestamps produce 0 ms (treated as missing evidence) instead of NaN propagation.
- **Evidence and risk flags**: every input timestamp is mapped to an `EvidenceItem` with computed `ageMs`. Risk flags (`stale_heartbeat`, `missing_heartbeat`, `missing_evidence`, `stale_evidence`, `im_silence`, `ledger_stall`, `run_stall`) are derived from evidence age vs. configured thresholds and lifecycle template.
- **Member semantics**: `terminated` and `offline` are terminal; `stale` maps to `degraded`; only `active` maps to `healthy` with zero risk flags.
- **"done" requires corroboration**: run `finished` status **or** zero open problems in the ledger, with zero risk flags. A single IM event or display state does not trigger "done".
- **Purity contract**: identical inputs produce identical outputs; all time flows through the explicit `config.now` parameter.

The projector is re-exported via `src/subagent/index.ts` and tested in `tests/subagent-status-projector.test.ts`.
