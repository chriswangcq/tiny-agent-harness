# Tool Call And Observation Design

本文记录 tiny-agent-harness 第一版的 tool call、bash session 和 observation 协议。

## Design Principles

1. Agent 对外只有一个真实工具：`bash`。
2. MCP 也是 CLI，不作为 harness 内置 SDK。Agent 调 MCP 时本质上仍然是运行 bash 命令。
3. Harness 原生负责 bash session lifecycle，但不提供业务工具。
4. Tool review 位于 bash 执行之前。demo 模式下所有请求都 approve。
5. Observation 只返回本次新增输出窗口和 return code。完整输出持久化到 session log，Agent 通过 bash 原生命令自行翻页查看。

## Agent Output Protocol

模型每轮只能输出 JSON。一次输出要么请求 action，要么给出 final。

请求执行 bash 命令：

```json
{
  "thought": "I need to inspect the repository.",
  "action": {
    "tool": "bash",
    "session": "default",
    "command": "find . -maxdepth 2 -type f | sort",
    "timeoutMs": 10000
  }
}
```

请求 session control：

```json
{
  "thought": "The dev server may still be starting, so I will poll the session.",
  "action": {
    "tool": "bash",
    "control": "poll",
    "session": "server"
  }
}
```

任务完成：

```json
{
  "thought": "The requested change is complete.",
  "final": "Implemented the feature and verified the tests pass."
}
```

## Bash Tool Request

所有 command request 必须显式指定 `session`。

```ts
type BashCommandRequest = {
  tool: "bash";
  session: string;
  command: string;
  timeoutMs?: number;
};
```

示例：

```json
{
  "tool": "bash",
  "session": "default",
  "command": "pwd && ls -la",
  "timeoutMs": 10000
}
```

## Bash Session Controls

Session lifecycle 是 harness 原生控制面。它仍然走 `bash` action，但不是普通 bash command。

```ts
type BashControlRequest =
  | {
      tool: "bash";
      control: "list";
    }
  | {
      tool: "bash";
      control: "create";
      session: string;
      cwd?: string;
      shell?: string;
      env?: Record<string, string>;
      defaultTimeoutMs?: number;
      maxObservationBytes?: number;
    }
  | {
      tool: "bash";
      control: "status" | "poll" | "interrupt" | "terminate" | "restart";
      session: string;
    }
  | {
      tool: "bash";
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
      tool: "bash";
      session: string;
      command: string;
      timeoutMs: number;
    }
  | {
      kind: "control";
      tool: "bash";
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
  "output": "Vite dev server running at http://localhost:5173\n",
  "outputTruncated": false,
  "outputLogPath": ".tiny-agent/sessions/server.log",
  "outputStartOffset": 0,
  "outputEndOffset": 52
}
```

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
printf '\n__TAH_COMMAND_DONE__ rc=%s cwd=%s\n' "$?" "$PWD"
```

规则：

- Marker 写入 session log，方便 debug 和 replay。
- Marker 不返回给 Agent 的 observation output。
- 如果 marker 出现，session 回到 `idle`，并解析 `returnCode` 和最新 `cwd`。
- 如果 marker 没出现且 timeout 到达，session 可能仍为 `running`，`returnCode` 为 `null`。

## Execution Semantics

1. Harness 接收 Agent JSON。
2. 如果是 final，结束 run。
3. 如果是 action，构造 `ToolRequest`。
4. `ToolRequest` 进入 review。
5. 如果 rejected，返回 rejection observation 给 Agent。
6. 如果 approved，bash session manager 执行 command 或 control。
7. Session output append 到 `output.logPath`。
8. Observation 只返回自 `lastObservationOffset` 之后的新增输出窗口。
9. 如果新增输出超过 `maxObservationBytes`，截断并设置 `outputTruncated: true`。
10. Agent 需要更多上下文时，通过 bash 命令读取 session log 或项目文件。

## Prompt Guidance For Agent

Agent system prompt 应明确：

```text
You can only use bash.
Every bash command must specify a session.
Avoid interactive commands when possible.
Use create/list/status/poll/sendInput/interrupt/terminate/restart to manage sessions.
Long-running services should run in named sessions.
Bash output is incremental and may be truncated.
For large outputs, redirect to files or inspect session logs with sed, tail, rg, awk, or similar shell tools.
MCP, memory, skills, tests, code edits, and sub-agents are all invoked through bash commands.
```
