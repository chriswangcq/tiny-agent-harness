# Tool Call And Observation Design

本文记录 tiny-agent-harness 第一版的 tool call、bash session 和 observation 协议。

## Design Principles

1. Agent 的唯一外部动作面仍是 `bash`。
2. `stash_file` 是 model-visible 的内部 staging 工具，只把生成文件字节写进 harness artifact state；落到目标文件系统仍要通过 `bash` 执行 `artifact write`。
3. MCP 也是 CLI，不作为 harness 内置 SDK。Agent 调 MCP 时本质上仍然是运行 bash 命令。
4. Harness 原生负责 bash session lifecycle 和 file artifact staging，但不提供业务工具。
5. Tool review 位于工具执行之前。demo 模式下所有请求都 approve。
6. Observation 只返回本次新增输出窗口和 return code。完整输出持久化到 session log，Agent 通过 bash 原生命令自行翻页查看。

## FIM Decision Tool Call Protocol

模型层使用 DeepSeek V4 FIM two-pass。第一通生成 reasoning，第二通生成 DeepSeek V4 DSML tool-call frame 的中间内容。

Decision pass 使用 DeepSeek V4 DSML tool-call 边界，但不走 API provider-native tool calling。Harness 手工组装 prompt 和 stop token，并解析 FIM 填充的中间段。

Decision pass 由 harness 预填：

```text
<｜Assistant｜><think>
{thinking_from_pass_1}
</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="
```

请求不传 `suffix`。模型输出遇到 `</｜DSML｜invoke>` 时停止，harness 在本地追加 trailer：

```text
</｜DSML｜invoke>
</｜DSML｜tool_calls><｜end▁of▁sentence｜>
```

模型只需要补：

```text
function_name">
<｜DSML｜parameter name="param_name" string="true|false">param_value</｜DSML｜parameter>
```

允许的 function name：

- `bash`: 外部 bash tool call。
- `io_wait`: 内部等待请求。

模型适配层把 FIM decision 归一化为：

```ts
type ModelTurn =
  | {
      kind: "tool_call";
      toolCall: InternalToolCall;
      thinking: AgentThinking;
      rawDecision: string;
      raw?: unknown;
    }
  | {
      kind: "io_wait";
      wait: IoWaitRequest;
      thinking: AgentThinking;
      rawDecision: string;
      raw?: unknown;
    }
  | {
      kind: "invalid_output";
      message: string;
      thinking?: AgentThinking;
      rawDecision?: string;
      raw?: unknown;
    };

type InternalToolCall = {
  id: string;
  name: "bash";
  arguments: BashToolInput;
  raw?: unknown;
};
```

请求执行 bash 命令时，tool call name 是 `bash`，arguments 是：

```text
bash">
<｜DSML｜parameter name="session" string="true">default</｜DSML｜parameter>
<｜DSML｜parameter name="command" string="true">find . -maxdepth 2 -type f | sort</｜DSML｜parameter>
<｜DSML｜parameter name="timeoutMs" string="false">10000</｜DSML｜parameter>
```

请求 session control 时，tool call name 仍然是 `bash`，arguments 是：

```text
bash">
<｜DSML｜parameter name="control" string="true">poll</｜DSML｜parameter>
<｜DSML｜parameter name="session" string="true">server</｜DSML｜parameter>
```

FIM 不提供 provider-generated tool call id，所以 harness 生成 `InternalToolCall.id`。

## Bash Tool Input

Command request 可以省略 `session`；省略或空字符串会在 validator 中归一化为 `default`。内部 `ToolRequest` 仍然持有显式 session，方便审计和执行。

```ts
type BashToolInput = BashCommandInput | BashControlInput;

type BashCommandInput = {
  session?: string;
  command: string;
  timeoutMs?: number; // default: 30000
};
```

示例：

```json
{
  "session": "default",
  "command": "pwd && ls -la",
  "timeoutMs": 10000
}
```

`timeoutMs` 表示 harness 聚焦等待该命令完成的最长时间，默认 `30000` 毫秒。

普通 bash command 的默认语义：

1. Harness 向指定 session 写入命令。
2. Harness 聚焦等待命令完成。
3. 如果命令在 `timeoutMs` 内完成，observation 返回 `returnCode` 和新增输出，session 回到 `idle`。
4. 如果超过 `timeoutMs` 仍未完成，harness 退出聚焦，把控制权还给 Agent，observation 提示命令仍在运行。
5. 超时退出聚焦不等于 kill。Agent 后续可用 `poll` 读取新增输出，或用 `interrupt` / `terminate` / `restart` 处理该 session。

## Bash Session Controls

Session lifecycle 是 harness 原生控制面。它仍然走 `bash` tool call，但不是普通 bash command。

```ts
type BashControlInput =
  | {
      control: "list";
    }
  | {
      control: "create";
      session: string;
      cwd?: string;
      shell?: string;
      env?: Record<string, string>;
      defaultTimeoutMs?: number;
      maxObservationBytes?: number;
    }
  | {
      control: "status" | "poll" | "interrupt" | "terminate" | "restart";
      session: string;
    }
  | {
      control: "sendInput";
      session: string;
      input: string;
    };
```

第一版支持的 controls：

- `list`: 列出所有 session。
- `create`: 显式创建一个 session。
- `status`: 查看单个 session 状态。
- `poll`: 不执行新命令，只读取单个 session 的新增输出。
- `sendInput`: 向 running 或 blocked session 写入 stdin，例如 `y\n`。
- `interrupt`: 向 session 前台进程发送 Ctrl-C。
- `terminate`: kill 当前 session。
- `restart`: terminate 后重新创建一个干净 session。

Harness 启动时可以自动创建 `default` session，降低首次使用成本。其它 session 推荐由 Agent 显式 `create`。

## Bash Session

`BashSession` 是 harness 内部对象，不是暴露给模型的新工具。

```ts
type BashSessionState = "idle" | "running" | "blocked" | "terminated";

type CurrentCommand = {
  id: string;
  command: string;
  startedAt: string;
  timeoutMs: number;
  status: "running" | "exited" | "timed_out" | "interrupted";
  returnCode: number | null;
};

type SessionOutput = {
  logPath: string;
  totalBytes: number;
  lastObservationOffset: number;
  maxObservationBytes: number;
  truncatedCount: number;
};

type BashSession = {
  id: string;
  state: BashSessionState;

  shell: string;
  cwd: string;
  env: Record<string, string>;
  pty: boolean;

  currentCommand?: CurrentCommand;
  output: SessionOutput;

  limits: {
    defaultTimeoutMs: number;
    maxObservationBytes: number;
    idleTimeoutMs?: number;
  };

  createdAt: string;
  updatedAt: string;
};
```

建议的持久化目录：

```text
.tiny-agent/
  sessions/
    default.log
    server.log
    test.log
  transcripts/
    run-2026-05-25T19-30-00.jsonl
```

每个 session 一个 append-only log file。Observation 返回截断后的新增输出，但完整输出保存在 `output.logPath`。

Agent 如需查看更多输出，应使用 bash 原生命令读取日志：

```bash
sed -n '1,120p' .tiny-agent/sessions/default.log
tail -200 .tiny-agent/sessions/server.log
rg "Error" .tiny-agent/sessions/test.log
```

## Tool Review

所有 tool request 在执行前进入 review 模块。

```ts
type ToolRequest =
  | {
      kind: "command";
      toolName: "bash";
      toolCallId: string;
      session: string;
      command: string;
      timeoutMs: number;
    }
  | {
      kind: "control";
      toolName: "bash";
      toolCallId: string;
      session?: string;
      control: "list" | "create" | "status" | "poll" | "sendInput" | "interrupt" | "terminate" | "restart";
      input?: string;
    };

type ToolReviewDecision = {
  status: "approved" | "rejected";
  reason: string;
  reviewer: string;
  warnings?: string[];
};
```

Demo 实现：

```ts
class AlwaysApproveReviewer {
  async review(_request: ToolRequest): Promise<ToolReviewDecision> {
    return {
      status: "approved",
      reason: "Demo mode: all tool calls are approved.",
      reviewer: "always-approve"
    };
  }
}
```

审核模块只决定能否执行，不负责执行命令。执行仍由 bash session manager 完成。

## Observation

Observation 统一返回 session 状态、return code、新增输出窗口和日志位置。

```ts
type BashObservation = {
  session: string | null;
  state?: "idle" | "running" | "blocked" | "terminated";
  returnCode: number | null;
  timedOut?: boolean;
  focusReleased?: boolean;

  output: string;
  outputTruncated: boolean;
  outputLogPath?: string;
  outputStartOffset?: number;
  outputEndOffset?: number;

  control?: "list" | "create" | "status" | "poll" | "sendInput" | "interrupt" | "terminate" | "restart";
  sessions?: BashSessionSummary[];
  message?: string;
};

type BashSessionSummary = {
  id: string;
  state: "idle" | "running" | "blocked" | "terminated";
  cwd: string;
  currentCommand?: string;
  outputLogPath: string;
  updatedAt: string;
};
```

命令成功退出示例：

```json
{
  "session": "default",
  "state": "idle",
  "returnCode": 0,
  "output": "README.md\ndocs\n",
  "outputTruncated": false,
  "outputLogPath": ".tiny-agent/sessions/default.log",
  "outputStartOffset": 1200,
  "outputEndOffset": 1215
}
```

命令仍在运行示例：

```json
{
  "session": "server",
  "state": "running",
  "returnCode": null,
  "timedOut": true,
  "focusReleased": true,
  "output": "Vite dev server running at http://localhost:5173\n",
  "outputTruncated": false,
  "outputLogPath": ".tiny-agent/sessions/server.log",
  "outputStartOffset": 0,
  "outputEndOffset": 52
}
```

这里的 `timedOut: true` 表示 harness 已经停止等待该命令，不表示命令失败或被杀死。`focusReleased: true` 表示 Agent 可以继续下一步决策，但该 session 仍处于 `running`，不能直接接收新的普通 command。

输出被截断示例：

```json
{
  "session": "test",
  "state": "idle",
  "returnCode": 1,
  "output": "...truncated output window...",
  "outputTruncated": true,
  "outputLogPath": ".tiny-agent/sessions/test.log",
  "outputStartOffset": 4096,
  "outputEndOffset": 12288
}
```

## Command Completion Marker

为了可靠拿到 return code 和 cwd，harness 可以在普通命令后注入内部 marker：

```bash
<user command>
printf '\n__TAH_COMMAND_DONE__ id=<command-id> rc=%s cwd=%s\n' "$?" "$PWD"
```

规则：

- Marker 写入 session log，方便 debug 和 replay。
- Marker 必须绑定当前 command id。旧 log 或用户命令输出里的 marker-like 文本不能完成当前命令。
- Marker 不返回给 Agent 的 observation output。
- 如果 marker 出现，session 回到 `idle`，并解析 `returnCode` 和最新 `cwd`。
- 如果 marker 没出现且 timeout 到达，session 可能仍为 `running`，`returnCode` 为 `null`。

## Execution Semantics

1. DeepSeek FIM adapter 完成 thinking pass 和 decision pass。
2. 如果是 `io_wait`，run state 进入 `waiting_for_io`，直到匹配的 environment event 到达。
3. 如果是 `bash` tool call，校验 arguments。
4. 校验通过后构造 `ToolRequest`。
5. `ToolRequest` 进入 review。
6. 如果 rejected，返回 rejection observation 给 Agent。
7. 如果 approved，bash session manager 执行 command 或 control。
8. 普通 command 默认聚焦等待完成，等待上限为 `timeoutMs`，默认 30 秒。
9. 如果命令在等待窗口内完成，解析 return code，session 回到 `idle`。
10. 如果命令超过等待窗口仍未完成，返回 `timedOut: true` 和 `focusReleased: true`，session 保持 `running`。
11. Session output append 到 `output.logPath`。
12. Observation 只返回自 `lastObservationOffset` 之后的新增输出窗口。
13. 如果新增输出超过 `maxObservationBytes`，截断并设置 `outputTruncated: true`。
14. Agent 需要更多上下文时，通过 bash 命令读取 session log 或项目文件。
15. 任务完成时，Agent 通过 bash 调用 IM CLI 发送用户可见答复，然后返回 `io_wait` 等待下一条用户消息或环境事件。

## Tool Description Guidance

工具使用方法主要放在 `bash` tool definition 的 description 和 input schema 里，而不是塞进一大段 FIM context。

FIM context 只保留高层约束，例如：

```text
All external actions must use the provided tools.
The only external action tool is bash. Use stash_file only to stage generated file bytes before bash materializes them.
When the task is complete, send the answer through the IM CLI with bash, then return io_wait.
```
