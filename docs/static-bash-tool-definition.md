# Static Bash Tool Definition Design

本文记录 tiny-agent-harness 第一版工具定义方案。

## Decision

第一版不做动态 tool registry，不做插件式注册，也不允许用户配置新增工具。

Harness 写死唯一内置工具：

```text
bash
```

但它仍然用通用 tool definition 形状描述给 DeepSeek FIM adapter。FIM adapter 会把这份定义写入 decision prompt，并在 decision 生成后用同一份 schema 做校验。

```text
StaticToolCatalog
  contains exactly one tool: bash

DeepSeekFimAdapter
  receives common ToolDefinition[]
  writes tool description and schema into FIM decision context
  normalizes FIM decision JSON into InternalToolCall

RunOrchestrator
  receives InternalToolCall
  validates arguments
  sends ToolRequest to review
  executes through BashSessionManager
```

## Non Goals

第一版明确不做：

- runtime tool registration
- external plugin loading
- per-project tool enable/disable config
- multiple business tools such as `read_file` / `write_file` / `run_tests`
- MCP as an in-process SDK tool

MCP、memory、skills、sub-agent、tests、code edits 都必须通过 `bash` 调用 CLI。

## Common Tool Definition

这是 harness 内部使用的 tool definition。

```ts
type ToolName = "bash";

type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
};
```

第一版工具目录是常量：

```ts
const BASH_TOOL_DEFINITION: ToolDefinition = {
  name: "bash",
  description: "Run bash commands or manage persistent bash sessions. All external actions must go through this tool.",
  inputSchema: BashToolInputSchema
};

const STATIC_TOOL_CATALOG = [BASH_TOOL_DEFINITION] as const;
```

这里叫 catalog，而不是 registry，是为了避免暗示运行时可注册。后续如果要扩展，也应该先明确是否仍坚持 all-in-bash。

## Internal Tool Call

无论 FIM decision 原始文本是什么，模型适配层都尝试归一化为：

```ts
type InternalToolCall = {
  id: string;
  name: "bash";
  arguments: BashToolInput;
  raw?: unknown;
};
```

因为 FIM 没有 provider-generated tool call id，harness 会生成 `id`，格式建议为 `fim-call-{runId}-{stepIndex}`。

## Model Turn

Model adapter 输出三种结果：

```ts
type ModelTurn =
  | {
      kind: "final";
      content: string;
      raw?: unknown;
    }
  | {
      kind: "tool_call";
      toolCall: InternalToolCall;
      raw?: unknown;
    }
  | {
      kind: "invalid_output";
      message: string;
      raw?: unknown;
    };
```

Run state 只消费 `ModelTurn`，不直接消费 FIM 原始文本。

## Bash Tool Input

因为 tool call 的 name 已经是 `bash`，arguments 里不再重复携带 `tool: "bash"`。

```ts
type BashToolInput = BashCommandInput | BashControlInput;

type BashCommandInput = {
  session: string;
  command: string;
  timeoutMs?: number;
};

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

Command 示例：

```json
{
  "session": "default",
  "command": "pwd && ls -la",
  "timeoutMs": 10000
}
```

Control 示例：

```json
{
  "control": "poll",
  "session": "server"
}
```

## JSON Schema Shape

`BashToolInputSchema` 使用 `oneOf` 区分普通命令和 session control。

```json
{
  "type": "object",
  "oneOf": [
    {
      "title": "BashCommandInput",
      "required": ["session", "command"],
      "properties": {
        "session": {
          "type": "string",
          "description": "Persistent bash session id, such as default, server, test, or scratch."
        },
        "command": {
          "type": "string",
          "description": "Bash command to execute in the specified session."
        },
        "timeoutMs": {
          "type": "number",
          "description": "How long the harness should focus-wait for completion. Defaults to 30000."
        }
      },
      "additionalProperties": false
    },
    {
      "title": "BashListControlInput",
      "required": ["control"],
      "properties": {
        "control": {
          "const": "list"
        }
      },
      "additionalProperties": false
    },
    {
      "title": "BashCreateControlInput",
      "required": ["control", "session"],
      "properties": {
        "control": {
          "const": "create"
        },
        "session": {
          "type": "string"
        },
        "cwd": {
          "type": "string"
        },
        "shell": {
          "type": "string"
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "defaultTimeoutMs": {
          "type": "number"
        },
        "maxObservationBytes": {
          "type": "number"
        }
      },
      "additionalProperties": false
    },
    {
      "title": "BashSessionControlInput",
      "required": ["control", "session"],
      "properties": {
        "control": {
          "enum": ["status", "poll", "interrupt", "terminate", "restart"]
        },
        "session": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    {
      "title": "BashSendInputControlInput",
      "required": ["control", "session", "input"],
      "properties": {
        "control": {
          "const": "sendInput"
        },
        "session": {
          "type": "string"
        },
        "input": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  ]
}
```

## Validation

Validation happens after FIM decision normalization and before review.

```text
FIM decision JSON
  -> InternalToolCall
  -> schema validation
  -> ToolRequest
  -> review
  -> execution
```

Invalid arguments produce a synthetic observation instead of executing:

```json
{
  "kind": "tool_validation",
  "message": "Invalid bash tool arguments: command input requires session and command.",
  "recoverable": true
}
```

This observation is fed back into the next model turn.

## Tool Request

Validated tool calls become reviewable `ToolRequest`.

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
      createOptions?: {
        cwd?: string;
        shell?: string;
        env?: Record<string, string>;
        defaultTimeoutMs?: number;
        maxObservationBytes?: number;
      };
    };
```

`timeoutMs` defaults to `30000` during this conversion.

## Tool Result

After execution, the result keeps harness-level identity:

```ts
type ToolResult = {
  toolCallId: string;
  toolName: "bash";
  observation: BashObservation | AgentObservation;
};
```

For the FIM adapter, `ToolResult` is rendered into the next step context as an observation. There is no provider-native tool result message.

## Execution Chain

```text
1. DeepSeekFimAdapter writes STATIC_TOOL_CATALOG into the FIM decision context.
2. FIM thinking pass generates reasoning-only text.
3. FIM decision pass returns final content or a bash tool call decision.
4. DeepSeekFimAdapter normalizes the decision into ModelTurn.
5. If ModelTurn is final, AgentRunState completes the run.
6. If ModelTurn is tool_call, harness validates the bash arguments.
7. Valid arguments become ToolRequest.
8. ToolRequest enters ToolReviewer.
9. Approved request is executed by BashSessionManager.
10. BashSessionManager returns BashObservation.
11. ToolResult is appended to transcript and rendered into the next FIM step context.
```

## Implementation Notes

Keep the first implementation deliberately narrow:

- define `BASH_TOOL_DEFINITION` as a constant
- define `STATIC_TOOL_CATALOG` as `[BASH_TOOL_DEFINITION]`
- reject any tool call whose name is not `bash`
- reject bash arguments that fail schema validation
- do not add a public registration API
- do not read tool definitions from config files

This preserves the core idea: the harness is extensible in architecture, but the demo has one clear current path.
