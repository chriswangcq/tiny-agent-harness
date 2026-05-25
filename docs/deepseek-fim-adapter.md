# DeepSeek FIM Two-Pass Adapter Design

本文记录 tiny-agent-harness 第一版主模型适配层。

## Decision

主路径使用 DeepSeek FIM Completion，而不是 chat completions 或 provider-native tool calling。

官方 FIM 约束：

- 使用 `base_url="https://api.deepseek.com/beta"`。
- 调用 `client.completions.create(...)`。
- 请求字段使用 `prompt` 和可选 `suffix`。
- 官方说明最大补全长度为 4K。

参考：<https://api-docs.deepseek.com/zh-cn/guides/fim_completion>

## Why FIM

这个 harness 想要一轮 ReAct step 被显式拆成两次生成：

```text
1. reasoning-only generation
2. tool-call-or-final decision generation
```

FIM 的 `prompt + suffix` 形式可以把模型输出夹在两个边界之间，让 harness 控制模型“这一段只能填 thinking”或“这一段只能填 decision”。

这不是把 FIM 当普通代码补全用，而是把它当成受约束的 step generator。

## Module

```text
DeepSeekFimAdapter
  owns: two FIM calls per agent step
  input: ModelStepContext
  output: ModelTurn

FimPromptBuilder
  owns: plain-text FIM prompt and suffix construction

FimDecisionParser
  owns: decision JSON parsing into ModelTurn
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
<tah_context>
Task:
...

Recent observations:
...

Available tool:
bash ...
</tah_context>

<agent_thinking>
```

Thinking suffix:

```text
</agent_thinking>
```

The filled middle is stored as:

```ts
type AgentThinking = {
  text: string;
  source: "deepseek_fim";
};
```

Thinking is not shown to the user as a final answer. It is recorded in transcript for debugging and self-improvement.

## Pass 2: Generate Decision

The second FIM call generates only the next decision.

Decision prompt shape:

```text
<tah_context>
...
</tah_context>

<agent_thinking>
...thinking from pass 1...
</agent_thinking>

<next_decision>
```

Decision suffix:

```text
</next_decision>
```

The filled middle must be one JSON object matching one of these shapes:

```json
{
  "type": "tool_call",
  "name": "bash",
  "arguments": {
    "session": "default",
    "command": "pwd && ls -la",
    "timeoutMs": 30000
  }
}
```

```json
{
  "type": "final",
  "content": "Done."
}
```

```json
{
  "type": "io_wait",
  "reason": "Waiting for the user's next message before continuing.",
  "condition": {
    "kind": "event",
    "eventKind": "user_message_received",
    "source": "im"
  }
}
```

This is a harness decision grammar. It is not provider-native tool calling.

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

- not valid JSON
- JSON is not an object
- missing `type`
- unsupported `type`
- tool name is not `bash`
- `arguments` fail bash tool schema validation

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

- `type: "tool_call"`
- `type: "final"`

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
- native chat tool calls
- strict JSON mode
- FIM as a standalone code completion CLI

The current path is: DeepSeek FIM two-pass, one bash tool, one tool call per step.
