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
2. tool-call-only decision generation
```

FIM 的 string completion 形式让 harness 直接发送 encoded `prompt`。Thinking pass 使用 `suffix: "</think>"`，decision pass 不传 suffix，而是用 stop token `</｜DSML｜invoke>` 截断后在本地追加收尾 frame。

这不是把 FIM 当普通代码补全用，而是把它当成受约束的 step generator。

Decision pass 贴近 DeepSeek V4 post-train 的 DSML tool-call 格式：

```text
<｜Assistant｜><think>
{thinking_from_pass_1}
</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="kind" string="true">write_text</｜DSML｜parameter>
<｜DSML｜parameter name="expectedInputSeq" string="false">0</｜DSML｜parameter>
<｜DSML｜parameter name="text" string="true">pwd
</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls><｜end▁of▁sentence｜>
```

Harness 只让模型补中间这一段：

```text
function_name">
<｜DSML｜parameter name="param_name" string="true|false">param_value</｜DSML｜parameter>
```

## Module

```text
DeepSeekFimAdapter
  owns: two FIM calls per agent step
  input: ModelStepContext
  output: ModelTurn

DeepSeekV4DsmlToolTemplateRenderer
  owns: DeepSeek V4 DSML prompt and boundary construction

NativeToolDecisionParser
  owns: DSML invoke/parameter parsing into ModelTurn
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
  messages: V4ChatMessage[];
};
```

The adapter encodes the messages prepared by the orchestrator. There is no special persistent User main message in this harness. User input is part of the Environment; `user_message_received` events are rendered into environment reminders and passed as `latest_reminder` messages. Large bash output is not pasted wholesale; observations carry the current session `outputTail` plus log paths and offsets.

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

Thinking is not shown to the user as the user-visible answer. It is recorded in transcript for debugging and self-improvement.

The FIM HTTP request uses the string completion interface:

```json
{
  "prompt": "<encoded prompt string>",
  "suffix": "</think>",
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

During the thinking pass, the adapter emits progress callbacks from the
streamed SSE chunks:

```ts
type ModelProgressEvent = {
  type: "thinking_delta";
  content: string;
  sequence: number;
};
```

`RunOrchestrator` persists those callbacks as `model_thinking_delta`
transcript events. These events are observability-only: they let the TUI update
the running model frame, but they do not replace `model_output_received` or
change the final `ModelTurn` contract.

Thinking content is normalized before it is stored or injected into the
decision prompt. If a streamed thinking response accidentally crosses into
`</think>`, `<｜DSML｜tool_calls>`, an invoke frame, or legacy tool-call markup,
the adapter truncates at that boundary. The live progress emitter keeps a small
lookbehind buffer so split boundary tokens are not leaked into TUI output.

## Pass 2: Generate Native Tool Decision

The second FIM call generates only the middle of one DeepSeek V4 DSML tool call.

Decision prompt shape:

```text
<｜begin▁of▁sentence｜>{system_prompt}

{environment_reminder}

{transcript_summary}

{tool_and_bash_contract}

<｜Assistant｜><think>
{thinking_from_pass_1}
</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="
```

Decision trailer appended locally after streaming completes:

```text
</｜DSML｜invoke>
</｜DSML｜tool_calls><｜end▁of▁sentence｜>
```

The filled middle must be:

```text
function_name">
<｜DSML｜parameter name="param_name" string="true|false">param_value</｜DSML｜parameter>
```

The decision pass also uses the streamed FIM string interface. Streamed text
chunks are concatenated into the full DSML middle first; only then does the
native DSML parser validate the function name, parameter tags, `string` flags,
JSON-valued parameters, and trailing frame tokens.

Unlike the thinking pass, the decision request does not send `suffix`. The
request sends `stop: ["</｜DSML｜invoke>"]`; the adapter appends
`</｜DSML｜invoke>\n</｜DSML｜tool_calls><｜end▁of▁sentence｜>` locally before
parsing so a provider-side suffix cannot poison continuation prompts.

Allowed decision functions:

- `bash`: PTY action tool call.
- `stash_file`: staged file bytes tool call.
- `io_wait`: internal wait request.

Examples:

```text
bash">
<｜DSML｜parameter name="kind" string="true">write_text</｜DSML｜parameter>
<｜DSML｜parameter name="expectedInputSeq" string="false">0</｜DSML｜parameter>
<｜DSML｜parameter name="text" string="true">pwd && ls -la
</｜DSML｜parameter>
```

```text
io_wait">
<｜DSML｜parameter name="reason" string="true">Waiting for the user's next message before continuing.</｜DSML｜parameter>
<｜DSML｜parameter name="condition" string="false">{"kind":"new_user_message","channel":"default"}</｜DSML｜parameter>
```

This is still a harness decision grammar, but its surface form matches DeepSeek native tool-call training format.

## Native Tool Decision Parser

The parser receives only the FIM-filled middle:

```text
{name}">
<｜DSML｜parameter name="..." string="true|false">...</｜DSML｜parameter>
```

Parsing steps:

1. Trim whitespace.
2. Extract the DSML invoke name and parameters.
3. Validate function name is one of `bash`, `io_wait`.
4. Parse parameter values according to their `string` flag.
5. Normalize into `ModelTurn`.
6. Reject any extra assistant content before or after the single tool call.

Normalization:

```text
bash(args)
  -> ModelTurn.tool_call with InternalToolCall(name="bash", arguments=args)

io_wait(args)
  -> ModelTurn.io_wait

```

`io_wait` is not an external tool. It reuses native tool-call framing only because it aligns with DeepSeek V4's post-training format and gives the decision pass one consistent output shape.

## Model Turn

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
- function arguments do not match `bash` or `io_wait` schema
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
  requestRetryMaxAttempts?: number; // default 3
  requestRetryInitialDelayMs?: number; // default 500
  requestRetryMaxDelayMs?: number; // default 4000
};
```

Suggested defaults:

```json
{
  "model": "deepseek-v4-pro",
  "thinkingMaxTokens": 2048,
  "decisionMaxTokens": 1024,
  "requestRetryMaxAttempts": 3
}
```

FIM request retry is scoped to failures before streaming starts: fetch/connect
failures plus HTTP `429` and `5xx`. Once the SSE stream is being parsed, errors
are surfaced directly instead of replaying the request, so transcripted thinking
or decision chunks are not duplicated.

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
6. streamed FIM string responses for both thinking and decision passes

Defer:

- provider-managed chat tool calls
- strict JSON mode
- FIM as a standalone code completion CLI

The current path is: DeepSeek V4 FIM two-pass, DeepSeek native tool-call framing for decision output, one decision function call per step.
