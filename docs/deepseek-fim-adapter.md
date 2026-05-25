# DeepSeek V4 Native Tool-Call FIM Adapter Design

本文记录 tiny-agent-harness 第一版主模型适配层。

## Decision

主路径使用 DeepSeek V4 的 FIM Completion 做两段式生成，但 decision pass 输出 DeepSeek V4 native tool-call frame，而不是 harness 自定义 JSON block。

官方 FIM 约束：

- 使用 `base_url="https://api.deepseek.com/beta"`。
- 调用 `client.completions.create(...)`。
- 请求字段使用 `prompt` 和可选 `suffix`。
- 官方说明最大补全长度为 4K。
- V4 模型 ID 使用 `deepseek-v4-pro`，需要更快/更便宜时可换 `deepseek-v4-flash`。
- 官方 Models & Pricing 表显示 V4 支持 Tool Calls、Chat Prefix Completion 和 FIM Completion；FIM 仅支持 non-thinking mode，所以本 harness 的 thinking 是通过第一段 FIM 自己生成的 artifact。

参考：

- <https://api-docs.deepseek.com/guides/fim_completion/>
- <https://api-docs.deepseek.com/guides/tool_calls>
- <https://api-docs.deepseek.com/quick_start/pricing/>

## Why FIM

这个 harness 想要一轮 ReAct step 被显式拆成两次生成：

```text
1. reasoning-only generation
2. tool-call-or-final decision generation
```

FIM 的 `prompt + suffix` 形式可以把模型输出夹在两个边界之间，让 harness 控制模型“这一段只能填 thinking”或“这一段只能填 DeepSeek native tool-call middle”。

这不是把 FIM 当普通代码补全用，而是把它当成受约束的 step generator。

Decision pass 贴近 DeepSeek V4 post-train 的 tool-call 格式：

```text
<｜Assistant｜></think>
<｜tool▁calls▁begin｜>
<｜tool▁call▁begin｜>bash<｜tool▁sep｜>{"session":"default","command":"pwd"}
<｜tool▁call▁end｜>
<｜tool▁calls▁end｜>
<｜end▁of▁sentence｜>
```

Harness 只让模型补中间这一段：

```text
function_name<｜tool▁sep｜>{json_arguments}
```

## Module

```text
DeepSeekFimAdapter
  owns: two FIM calls per agent step
  input: ModelStepContext
  output: ModelTurn

DeepSeekV4NativeToolTemplateRenderer
  owns: DeepSeek V4 special-token prompt and suffix construction

NativeToolDecisionParser
  owns: function_name<｜tool▁sep｜>{json_arguments} parsing into ModelTurn
```

Run orchestrator 仍然只看到一个 `call_model` effect。两次 FIM 调用是 adapter 内部细节。

```text
RunOrchestrator
  -> DeepSeekFimAdapter.generateTurn(context)
       -> generateThinking()
       -> generateDecision(thinking)
       -> normalize decision to ModelTurn
```

## Model Step Context

```ts
type ModelStepContext = {
  runId: string;
  stepIndex: number;
  task: string;
  cwd: string;
  recentTranscript: AgentObservation[];
  sessionSummaries: BashSessionSummary[];
  bashTool: ToolDefinition;
};
```

The adapter builds a compact plain-text context from this state. Large bash output is not pasted wholesale; observations already contain log paths and offsets.

## Pass 1: Generate Thinking

The first FIM call generates only reasoning text.

```ts
type FimCompletionRequest = {
  model: "deepseek-v4-pro";
  prompt: string;
  suffix?: string;
  max_tokens: number;
};
```

Thinking prompt shape:

```text
<｜begin▁of▁sentence｜>{system_prompt}

<｜User｜>
{task}

{environment_reminder}

{transcript_summary}

{tool_and_bash_contract}

<｜Assistant｜><think>
```

Thinking suffix:

```text
</think>
```

The filled middle is stored as:

```ts
type AgentThinking = {
  content: string;
  raw?: unknown;
};
```

Thinking is not shown to the user as a final answer. It is recorded in transcript for debugging and self-improvement.

## Pass 2: Generate Native Tool Decision

The second FIM call generates only the middle of one DeepSeek native tool call.

Decision prompt shape:

```text
<｜begin▁of▁sentence｜>{system_prompt}

<｜User｜>
{task}

{environment_reminder}

{transcript_summary}

{tool_and_bash_contract}

<｜Assistant｜><think>
{thinking_from_pass_1}
</think>
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
```

Decision suffix:

```text
<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜>
```

The filled middle must be:

```text
function_name<｜tool▁sep｜>{json_arguments}
```

Allowed decision functions:

- `bash`: external bash tool call.
- `io_wait`: internal wait request.
- `final`: internal completion request.

Examples:

```text
bash<｜tool▁sep｜>{"session":"default","command":"pwd && ls -la","timeoutMs":30000}
```

```text
io_wait<｜tool▁sep｜>{"reason":"Waiting for the user's next message before continuing.","condition":{"kind":"new_user_message","channel":"default"}}
```

```text
final<｜tool▁sep｜>{"content":"Done."}
```

This is still a harness decision grammar, but its surface form matches DeepSeek native tool-call training format.

## Native Tool Decision Parser

The parser receives only the FIM-filled middle:

```text
{name}<｜tool▁sep｜>{json}
```

Parsing steps:

1. Trim whitespace.
2. Split once on `<｜tool▁sep｜>`.
3. Validate function name is one of `bash`, `io_wait`, `final`.
4. Parse the JSON arguments.
5. Normalize into `ModelTurn`.
6. Reject any extra assistant content before or after the single tool call.

Normalization:

```text
bash(args)
  -> ModelTurn.tool_call with InternalToolCall(name="bash", arguments=args)

io_wait(args)
  -> ModelTurn.io_wait

final(args)
  -> ModelTurn.final
```

`io_wait` and `final` are not external tools. They reuse native tool-call framing only because it aligns with DeepSeek V4's post-training format and gives the decision pass one consistent output shape.

## Model Turn

```ts
type ModelTurn =
  | {
      kind: "final";
      content: string;
      thinking: AgentThinking;
      rawDecision: string;
    }
  | {
      kind: "tool_call";
      toolCall: InternalToolCall;
      thinking: AgentThinking;
      rawDecision: string;
    }
  | {
      kind: "io_wait";
      wait: IoWaitRequest;
      thinking: AgentThinking;
      rawDecision: string;
    }
  | {
      kind: "invalid_output";
      message: string;
      thinking?: AgentThinking;
      rawDecision?: string;
};
```

First version supports only one wait condition:

```ts
type IoWaitRequest = {
  reason?: string;
  condition:
    | {
        kind: "event";
        eventKind: EnvironmentEvent["kind"];
        source?: EnvironmentEvent["source"];
      }
    | {
        kind: "new_user_message";
        channel: string;
        cursor?: string;
      };
};
```

Because FIM does not provide provider-generated tool call ids, the harness creates them:

```text
fim-call-{runId}-{stepIndex}
```

Tool call normalization:

```ts
type InternalToolCall = {
  id: string;
  name: "bash";
  arguments: BashToolInput;
  raw?: unknown;
};
```

## Invalid Decision Handling

Decision generation can fail in normal model ways:

- missing `<｜tool▁sep｜>`
- unsupported function name
- arguments are not valid JSON
- function arguments do not match `bash`, `io_wait`, or `final` schema
- extra assistant content appears before or after the single native tool call middle

Parser-level failures become `ModelTurn.invalid_output`.

Schema-level failures become tool-validation observations in the run state.

## API Configuration

```ts
type DeepSeekFimConfig = {
  apiKeyEnv: "DEEPSEEK_API_KEY";
  baseUrl: "https://api.deepseek.com/beta";
  model: "deepseek-v4-pro";
  thinkingMaxTokens: number; // <= 4096
  decisionMaxTokens: number; // <= 4096
};
```

Suggested defaults:

```json
{
  "model": "deepseek-v4-pro",
  "thinkingMaxTokens": 2048,
  "decisionMaxTokens": 1024
}
```

## Transcript Events

Two-pass generation should be visible in transcript.

```ts
type FimModelEvent =
  | {
      type: "fim_thinking_generated";
      stepIndex: number;
      thinking: AgentThinking;
      timestamp: string;
    }
  | {
      type: "fim_decision_generated";
      stepIndex: number;
      rawDecision: string;
      turn: ModelTurn;
      timestamp: string;
    };
```

Prompt text can be saved separately under the run directory:

```text
.tiny-agent/
  runs/
    run-.../
      prompts/
        step-000-thinking.prompt.txt
        step-000-thinking.suffix.txt
        step-000-decision.prompt.txt
        step-000-decision.suffix.txt
```

## Prompt Boundary Rules

The FIM prompt should describe current state, not teach a full manual.

The tool definition provides:

- tool name
- description
- JSON schema

The decision grammar provides:

- native decision function `bash`
- native decision function `io_wait`
- native decision function `final`
- special separator `<｜tool▁sep｜>`
- JSON argument schemas for each decision function

The prompt should not include alternate historical APIs or examples that contradict the current path.

## First Implementation

Implement only:

1. `DeepSeekFimAdapter.generateTurn(context)`
2. `generateThinking(context)`
3. `generateDecision(context, thinking)`
4. `parseDecision(rawDecision)`
5. transcript events for thinking and decision

Defer:

- streaming
- provider-managed chat tool calls
- strict JSON mode
- FIM as a standalone code completion CLI

The current path is: DeepSeek V4 FIM two-pass, DeepSeek native tool-call framing for decision output, one decision function call per step.
