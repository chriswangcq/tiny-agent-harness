# Run Orchestrator And Agent Run State Design

本文记录 tiny-agent-harness 第一版 run loop、agent run state、effect 和 event 协议。

> Current implementation note: tiny-agent has no model-level `final` turn. User-visible replies are delivered by running host-backed `tiny-agent im send --kind status --text-stdin` through the current PTY session, then returning to `io_wait` to wait for the next environment event. Text that appears only in thinking is not delivered to the user.

## Design Principles

1. Run orchestrator 本质是一个 `for` / `while` loop。
2. Agent run state 是该 loop 的显式状态机，负责判断下一步要产生什么 effect。
3. Orchestrator 负责执行副作用：调用模型、审核工具、执行 terminal/session tool、写 transcript。
4. State transition 尽量保持纯逻辑：`state + event -> next state`。
5. 不用一堆局部变量隐式保存 pending model output、pending tool call、pending review。
6. Run state 必须能落盘，后续才方便 debug、resume、eval 和 self-improve。

## Module Responsibilities

```text
RunOrchestrator
  owns: loop, side effects, IO boundaries
  calls: ModelGateway-backed ModelPort, Environment, ToolReviewer, TerminalHost-backed TerminalPort, RuntimeReplica-backed run IM client, TranscriptStore

AgentRunState
  owns: status, step index, transcript pointers, pending tool call/review, pending IO wait
  references: active skill run reminder state through Environment / SkillRunStore
  exposes: nextEffect(), apply(event)

ModelGateway
  owns: default run ModelPort process boundary and provider isolation

DeepSeekFimAdapter
  owns: DeepSeek provider implementation details inside the ModelGateway process

ModelContextSession
  owns: model-visible context items, FIM message rendering, context-window compaction, snapshot/restore
  accepts: incremental environment reminders, tool calls, observations, io_wait calls

PromptBuilder
  owns: DeepSeek v4 chat-template compatible message serialization

RuntimeReplica / run IM binding
  owns: project-scoped socket boundary for endpoint pair creation, run binding, user message polling, ack, and agent reply delivery through im CLI

Environment
  owns: latest external events and consumed-event cursors
  owns: persistent reminder facts such as active skill runs

ToolCallValidator
  owns: schema validation and conversion from InternalToolCall to ToolRequest

ToolReviewer
  owns: approve/reject decision before execution

TerminalHost
  owns: terminal sessions and observations in a supervisor-recorded child process

ManagedTerminalRuntime
  owns: PTY/session implementation details inside the TerminalHost process

TranscriptStore
  owns: append-only run events on disk

RunSessionStore
  owns: persisted ModelContextSession snapshot for resume
```

The important split:

```text
AgentRunState decides what should happen next.
RunOrchestrator makes it happen.
```

## Agent Run State

```ts
type AgentRunStatus =
  | "created"
  | "running"
  | "waiting_for_model"
  | "waiting_for_review"
  | "waiting_for_tool"
  | "waiting_for_io"
  | "failed"
  | "cancelled";

type AgentRunState = {
  runId: string;
  status: AgentRunStatus;

  task: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;

  stepIndex: number;

  transcriptPath: string;
  lastEventId?: string;

  pendingModelOutput?: FimStepOutput;
  pendingModelTurn?: ModelTurn;
  pendingToolCall?: InternalToolCall;
  pendingToolRequest?: ToolRequest;
  pendingReview?: ToolReviewDecision;
  pendingIoWait?: IoWaitRequest;

  activeSkillRuns?: ActiveSkillRunSummary[];

  error?: RunError;
};
```

`status` 是互斥生命周期状态，不用 `isRunning`、`isDone`、`hasError` 这类并列布尔值。

`stepIndex` 表示已完成的 agent step 数。一次 step 通常包含：

```text
model output -> optional tool validation -> optional tool review -> optional tool execution -> observation
```

如果任务已经完成，模型仍然不直接返回用户可见正文；Agent 应通过 current PTY session 调用 host-backed `tiny-agent im send --kind status --text-stdin` 发送用户可见答复，然后返回 `io_wait`，让 run 等待下一条用户消息或环境事件。外部/本地 demo 注入用户消息必须通过 edge runtime replica 调用 `tiny-agent im post --runtime-host-socket <edge-socket>`，不能作为 agent 回复出口。所有 Agent 回复都应走 public IM；普通文本回复可以直接用 quoted heredoc，例如：

```bash
tiny-agent im send --kind status --text-stdin <<'IM'
Done.
IM
```

也可以在更简单时使用 `< reply.md` stdin redirection。发送后用 `session_observe` 确认 shell prompt/成功输出再 `io_wait`。如果最近一次 IM send 的 PTY observation 尚未回到 shell prompt，orchestrator 会把 `io_wait` 转成 recoverable observation，要求模型先 observe。所有 `terminal_write` PTY 输入都会由 runtime 保护性 pacing；生成文件、代码、HTML、JSON 等文本 payload 使用 shell-native heredoc/redirection，不再保留 staged bytes 旁路。

## Model Turn

模型原始响应必须经过 DeepSeek FIM adapter，run state 不直接消费 FIM 原始文本。

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

`invalid_output` 不一定让 run 失败。第一版可以把 invalid output 转成 observation，让 Agent 下一轮自我修正。

Invalid output should carry protocol diagnostics when the adapter can identify a stable cause. Current diagnostic codes cover V3/V4 boundary mismatch, raw JSON arguments, invalid JSON parameter frames, unsupported function names, missing parameter frames, and malformed `io_wait` arguments. TUI and replay/eval summaries should show these diagnostic codes instead of reducing them to a generic warning string.

`io_wait` 是 Agent 向自己的 run state machine 提交等待请求。它不是 terminal/session tool，也不执行外部业务动作；orchestrator 会等待 Environment 中出现满足条件的事件，满足后才允许下一轮 model step。

Current wait conditions are priority-only:

```ts
type IoWaitRequest = {
  reason?: string;
  minLevel?: number;
  // Deprecated compatibility shape accepted for old transcripts/model outputs.
  // Runtime matching still uses only minLevel.
  condition?: { minLevel?: number; [legacy: string]: unknown };
};
```

Omitting `minLevel` means "wake on the next meaningful event" (`level >= 10`). Explicit `minLevel: 0` means "wake on any new environment event", including low-value session output. Before each model turn, the orchestrator calls `consumeSince(runId)` and advances the run's environment cursor. If that same model turn later emits `io_wait`, the wait starts from that consumed cursor, not from the later wait-registration timestamp. This preserves user/environment events that arrive while the model is thinking and lets them satisfy `io_wait` immediately. `minLevel` matches events where `environmentEventLevel(event) >= minLevel`; user messages default to level `100` and should be treated as highest-priority operator input, skill events default to level `10`, and ordinary missing non-user levels default to `1`. Legacy `source`, `eventKind`, `session`, and `channel` condition fields are not runtime filters.

Before entering `waiting_for_io`, if the latest terminal observation has `returnedToPrompt: false`, the orchestrator performs a best-effort `session_observe` so prompt facts (`session_returned_to_prompt`, `session_input_ready`) are recorded as environment events through `recordTerminalEnvironmentEvents`. No synthetic prompt events are fabricated; if this pre-observe fails, the wait proceeds normally.

While `waiting_for_io`, the orchestrator also runs a best-effort `session_observe` pump. It does not append hidden tool observations to model history; it only converts new terminal facts into `EnvironmentEvent`s such as `session_output_available`, `session_input_ready`, `session_continuation_prompt`, and `session_returned_to_prompt`.

## Active Skill Run State

Skill run 不建议塞进 `AgentRunStatus` 顶层枚举。顶层状态已经表达当前 run 是否在等模型、等审核、等工具或等 IO；如果再加一个 `skill_running`，会和 `waiting_for_tool` 等状态互相覆盖。

更清晰的做法是：AgentRunState 保持主循环状态机，SkillRunState 作为子状态机存在。每轮 `call_model` 前，orchestrator 把 active skill runs 渲染进 system reminder。

```ts
type ActiveSkillRunSummary = {
  skillRunId: string;
  skill: string;
  status: "running" | "review_pending";
  executionReturnCode?: number;
  executionLogPath: string;
  reviewTaskPath?: string;
};
```

`running` 表示 skill 上下文仍然 active，不一定表示 shell process 仍在运行。关闭必须由 agent 显式运行：

```bash
tiny-agent skill close <skillRunId> --review none --json '<summary>'
tiny-agent skill close <skillRunId> --review required --json '<summary>'
```

如果 close 时选择 `--review required`，SkillRunState 进入 `review_pending`，并生成 `review-task.txt`。这个 review task 会持续进入 system reminder，直到 agent 运行：

```bash
tiny-agent skill review-complete <skillRunId> --json '<review>'
```

完成复盘后，经验教训追加到 skill 附件，例如：

```text
.tiny-agent/skills/<skill>/attachments/lessons.md
```

```ts
type FimStepOutput = {
  thinking: AgentThinking;
  rawDecision: string;
  turn: ModelTurn;
  usage?: unknown;
};
```

Tool call validation produces either a reviewable request or a recoverable observation.

```ts
type ToolCallValidation =
  | {
      status: "valid";
      request: ToolRequest;
    }
  | {
      status: "invalid";
      observation: AgentObservation;
    };
```

## Next Effect

`nextEffect(state)` 是 AgentRunState 对 orchestrator 的唯一指令出口。

```ts
type NextEffect =
  | {
      type: "call_model";
      context: ModelStepContext;
    }
  | {
      type: "validate_tool_call";
      toolCall: InternalToolCall;
    }
  | {
      type: "review_tool";
      request: ToolRequest;
    }
  | {
      type: "execute_tool";
      request: ToolRequest;
      review: ToolReviewDecision;
    }
  | {
      type: "append_observation";
      observation: AgentObservation;
    }
  | {
      type: "wait_io";
      wait: IoWaitRequest;
    }
  | {
      type: "stop";
      reason: "failed" | "cancelled";
    };
```

Notes:

- `call_model` is created when the run needs the next model decision.
- `validate_tool_call` is created after the model returns a tool call.
- `review_tool` is created after a tool call is validated and converted to a ToolRequest.
- `execute_tool` is created only after review approves.
- `append_observation` is useful for synthetic observations, such as invalid outputs, validation errors, or review rejections.
- `wait_io` is created after the model asks the run state machine to wait for external IO.
- `stop` is terminal.

## Run Events

Run state changes are driven by events. Events should also be appended to transcript JSONL.

```ts
type RunEvent =
  | {
      type: "run_started";
      runId: string;
      task: string;
      cwd: string;
      timestamp: string;
    }
  | {
      type: "run_resumed";
      runId: string;
      previousStatus: AgentRunStatus;
      timestamp: string;
    }
  | {
      type: "history_compacted";
      stepIndex: number;
      compaction: {
        summary: string;
        tokenCount: number;
        maxTokens: number;
        originalItemCount: number;
        retainedItemCount: number;
        droppedItemCount: number;
      };
      timestamp: string;
    }
  | {
      type: "model_requested";
      stepIndex: number;
      timestamp: string;
    }
  | {
      type: "model_output_received";
      stepIndex: number;
      output: FimStepOutput;
      turn: ModelTurn;
      timestamp: string;
    }
  | {
      type: "model_decision_recorded";
      stepIndex: number;
      decision: {
        schemaVersion: 1;
        decisionId: string;
        stepIndex: number;
        kind: "tool_call" | "io_wait" | "invalid_output";
        thinking: {
          contentChars: number;
          contentBytes: number;
          promptRef?: RunArtifactRef;
          traceRef?: RunArtifactRef;
        };
        rawDecision?: {
          bytes: number;
          sha256: string;
          preview: string;
        };
        toolCall?: { id: string; name: ToolName; arguments: TerminalToolInput };
        ioWait?: IoWaitRequest;
        invalidOutput?: { message: string; diagnostic?: ModelProtocolDiagnostic };
      };
      timestamp: string;
    }
  | {
      type: "model_thinking_delta";
      stepIndex: number;
      delta: string;
      sequence: number;
      timestamp: string;
    }
  | {
      type: "user_message_received";
      runId: string;
      message: UserMessage;
      timestamp: string;
    }
  | {
      type: "agent_message_sent";
      runId: string;
      message: AgentMessage;
      timestamp: string;
    }
  | {
      type: "io_wait_started";
      stepIndex: number;
      decisionId?: string;
      wait: IoWaitRequest;
      timestamp: string;
    }
  | {
      type: "io_wait_satisfied";
      stepIndex: number;
      decisionId?: string;
      wait: IoWaitRequest;
      event: EnvironmentEvent;
      timestamp: string;
    }
  | {
      type: "environment_event_recorded";
      event: EnvironmentEvent;
      timestamp: string;
    }
  | {
      type: "environment_events_consumed";
      runId: string;
      eventIds: string[];
      timestamp: string;
    }
  | {
      type: "tool_call_validated";
      stepIndex: number;
      decisionId?: string;
      toolCall: InternalToolCall;
      result: ToolCallValidation;
      timestamp: string;
    }
  | {
      type: "tool_review_requested";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_reviewed";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      decision: ToolReviewDecision;
      timestamp: string;
    }
  | {
      type: "tool_execution_started";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_execution_finished";
      stepIndex: number;
      decisionId?: string;
      request: ToolRequest;
      observation: TerminalObservation | SessionListObservation | AgentObservation;
      timestamp: string;
    }
  | {
      type: "observation_appended";
      stepIndex: number;
      decisionId?: string;
      observation: AgentObservation;
      timestamp: string;
    }
  | {
      type: "run_finished";
      status: "failed" | "cancelled";
      error?: RunError;
      timestamp: string;
    };
```

Before recording `model_output_received`, the orchestrator moves large raw debug payloads out of model output when possible. Today this applies to `thinking.raw.prompt`: the prompt text is written under the run directory as a debug artifact, and transcript/model output keep only a `promptRef` with `path`, `relativePath`, `bytes`, and `sha256`. This keeps `transcript.jsonl` and `session.json` useful for replay without repeatedly embedding full FIM prompts into model context.

Immediately after `model_output_received`, current runtime records `model_decision_recorded`. This is the compact durable decision fact for the step: `decisionId`, decision kind, tool name/arguments or `io_wait`, invalid-output diagnostic, raw decision hash/preview, and `thinking.raw.promptRef` / `thinking.raw.traceRef` when present. Later validation, review, tool execution, synthetic observation, and `io_wait` events emitted by the orchestrator include the same `decisionId` so projection and replay code can correlate facts without parsing the full model output payload.

When the model adapter returns normalized provider usage (see [DeepSeek V4 Native Tool-Call FIM Adapter](deepseek-fim-adapter.md)), the orchestrator also records `model_usage_recorded` with the same `stepIndex` and `decisionId`. The `usage` field carries normalized FIM usage (`thinking` and `decision` passes) with snake_case-preferred token counts, cache hit/miss breakdowns, finish reasons, and continuation rounds. Token usage summary is always derived from these durable `model_usage_recorded` facts — never from raw prompt texts, debug payloads, or provider-specific response parsing. The `src/model/token-usage-summary.ts` helper produces an aggregated `TokenUsageSummary` from transcript events.

This token usage slice records and aggregates durable token usage facts only.
It does **not** implement pricing or billing policy, does **not** include
dashboard or TUI cost display integration, and does **not** derive usage
summary from raw prompt texts, debug payloads, or provider-specific response
parsing.
TUI `tokenUsage` is a read-only `ViewModelBuilder` projection of the same
durable `model_usage_recorded` facts; it is not a pricing, billing, cost,
or raw prompt/debug/provider parsing dashboard.

## Orchestrator Loop

The orchestrator is deliberately simple.

```ts
async function runAgent(initialState: AgentRunState, ports: RunPorts) {
  let state = initialState;

  async function record(event: RunEvent) {
    await ports.transcript.append(event);
    state = state.apply(event);
    await ports.stateStore.save(state);
  }

  await record({
    type: "run_started",
    runId: state.runId,
    task: state.task,
    cwd: state.cwd,
    timestamp: ports.clock.now()
  });

  while (true) {
    const effect = state.nextEffect();

    if (effect.type === "call_model") {
      await record({
        type: "model_requested",
        stepIndex: state.stepIndex,
        timestamp: ports.clock.now()
      });

      const output = await ports.fim.generateTurn(effect.context, {
        tools: ports.tools.modelVisibleCatalog
      });
      const turn = output.turn;

      await record({
        type: "model_output_received",
        stepIndex: state.stepIndex,
        output,
        turn,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "validate_tool_call") {
      const result = ports.toolCallValidator.validate(effect.toolCall);

      await record({
        type: "tool_call_validated",
        stepIndex: state.stepIndex,
        toolCall: effect.toolCall,
        result,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "review_tool") {
      await record({
        type: "tool_review_requested",
        stepIndex: state.stepIndex,
        request: effect.request,
        timestamp: ports.clock.now()
      });

      const decision = await ports.reviewer.review(effect.request);

      await record({
        type: "tool_reviewed",
        stepIndex: state.stepIndex,
        request: effect.request,
        decision,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "execute_tool") {
      await record({
        type: "tool_execution_started",
        stepIndex: state.stepIndex,
        request: effect.request,
        timestamp: ports.clock.now()
      });

      const observation = await ports.terminal.execute(effect.request);

      await record({
        type: "tool_execution_finished",
        stepIndex: state.stepIndex,
        request: effect.request,
        observation,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "append_observation") {
      await record({
        type: "observation_appended",
        stepIndex: state.stepIndex,
        observation: effect.observation,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "wait_io") {
      await record({
        type: "io_wait_started",
        stepIndex: state.stepIndex,
        wait: effect.wait,
        timestamp: ports.clock.now()
      });

      const event = await ports.environment.waitFor({
        runId: state.runId,
        wait: effect.wait
      });

      await record({
        type: "io_wait_satisfied",
        stepIndex: state.stepIndex,
        wait: effect.wait,
        event,
        timestamp: ports.clock.now()
      });
      continue;
    }

    if (effect.type === "stop") {
      await record({
        type: "run_finished",
        status: state.status === "cancelled" ? "cancelled" : "failed",
        error: state.error,
        timestamp: ports.clock.now()
      });
      break;
    }
  }

  return state;
}
```

Every event goes through `record(event)`, so transcript append and state snapshot update cannot drift apart. The transcript remains append-only; the latest state can be reconstructed or cached as a snapshot.

`model_thinking_delta` is retained for historical transcript compatibility.
The active model-progress path stores streamed thinking chunks as debug trace
artifacts referenced from `model_output_received.output.thinking.raw.traceRef`
instead of appending per-chunk primary RunEvents.

## Transition Rules

```text
created + run_started
  -> running

running + model_requested
  -> waiting_for_model

waiting_for_model + model_thinking_delta
  -> waiting_for_model
  (historical observability-only compatibility; active runs use trace artifacts)

waiting_for_model + model_output_received(tool_call)
  -> running with pending tool call

waiting_for_model + model_output_received(io_wait)
  -> running with pending IO wait

waiting_for_model + model_output_received(invalid_output)
  -> running with synthetic invalid-output observation queued

running + tool_call_validated(valid)
  -> running with pending valid tool request

running + tool_call_validated(invalid)
  -> running with synthetic tool-validation observation queued

running + tool_review_requested
  -> waiting_for_review

waiting_for_review + tool_reviewed(approved)
  -> running with pending approved tool request

waiting_for_review + tool_reviewed(rejected)
  -> running with synthetic review-rejection observation queued

running + tool_execution_started
  -> waiting_for_tool

waiting_for_tool + tool_execution_finished
  -> running, stepIndex += 1

running + io_wait_started
  -> waiting_for_io

waiting_for_io + io_wait_satisfied
  -> running with synthetic user-message observation queued, stepIndex += 1

any persisted state + run_resumed
  -> running with persisted history restored by the orchestrator

any non-terminal + cancel
  -> cancelled

any non-terminal + unrecoverable error
  -> failed
```

Invalid transitions should fail loudly in development. For example:

```text
failed + model_output_received -> invalid
cancelled + model_output_received -> invalid
waiting_for_tool + model_output_received -> invalid
waiting_for_io + model_output_received -> invalid
running + tool_execution_finished with no pending request -> invalid
```

`nextEffect()` itself does not mutate state. It only reads the current state and chooses the next effect:

```text
created
  -> stop(failed) unless run_started has been recorded by the orchestrator

running + pending synthetic observation
  -> append_observation

running + pending tool call
  -> validate_tool_call

running + pending valid tool request
  -> review_tool

running + pending approved tool request
  -> execute_tool

running + pending IO wait
  -> wait_io

running + no pending work
  -> call_model

failed / cancelled
  -> stop(...)
```

At the boundary before `call_model`, the orchestrator consumes environment events:

```text
events = environment.consumeSince(runId)
if events not empty:
  reminder = renderEnvironmentReminder(events)
  context.messages.push({ role: "latest_reminder", content: reminder })
  record(environment_events_consumed)

activeSkillRuns = skillRunStore.listActive()
if activeSkillRuns not empty:
  context.messages.push({ role: "latest_reminder", content: renderActiveSkillReminder(activeSkillRuns) })
```

Reminder rendering follows the policy in `docs/environment-model.md`: newest events win, large outputs are represented by log paths, and consumed event ids advance the run's environment cursor.

Environment event reminders are consumed once. Active skill reminders are persistent state facts and are rendered every model step until the skill run reaches `closed`.

## Synthetic Observations

Some failures should go back to the Agent instead of ending the run immediately.

Invalid output observation:

```json
{
  "kind": "model_output",
  "message": "Model response did not contain a valid tool call.",
  "recoverable": true
}
```

Tool validation observation:

```json
{
  "kind": "tool_validation",
  "message": "Invalid terminal_write arguments: expectedInputSeq must match current session inputSeq.",
  "recoverable": true
}
```

Review rejection observation:

```json
{
  "kind": "tool_review",
  "message": "Tool request was rejected by reviewer.",
  "recoverable": true,
  "decision": {
    "status": "rejected",
    "reason": "Command requires approval."
  }
}
```

IO wait satisfied observation:

```json
{
  "kind": "io_wait",
  "message": "Environment event satisfied IO wait.",
  "recoverable": true,
  "event": {
    "id": "env-123",
    "kind": "user_message_received",
    "source": "im"
  }
}
```

These observations enter the transcript exactly like terminal observations, while the full EnvironmentEvent is also consumed into the next FIM step as environment context.

## Step Counting

`stepIndex` increments after one complete action cycle:

```text
model tool_call -> validate -> review -> execute/pseudo-observe -> observation appended
model io_wait -> wait until condition satisfied -> observation appended
```

Final answers do not increment `stepIndex`.

Invalid model outputs, tool validation errors, review rejections, and satisfied IO waits do increment `stepIndex` after the synthetic observation is appended. There is no fixed step budget; long-running sessions are controlled by `io_wait`, cancellation, process lifetime, and context compaction.

## Model Context Session

DeepSeek FIM completion itself is stateless over HTTP. tiny-agent wraps it with a local stateful `ModelContextSession` so the run loop submits only incremental context items:

```text
environment_reminder | tool_call | observation | io_wait_call
  -> ModelContextSession.append(...)
  -> ModelContextSession.compactIfNeeded(...)
  -> ModelContextSession.prepareModelTurn(...)
  -> ModelGateway.generateTurn(...)
  -> DeepSeekFimAdapter.generateTurn(...) inside the model-gateway process
```

The important boundary is ownership: `RunOrchestrator` does not own prompt history arrays, does not call `PromptBuilder` directly, and does not decide the context-window rewrite. It executes effects and records events; `ModelContextSession` owns the model-visible timeline and returns the next model messages.

Tool execution history is explicit about provenance. When the live runtime executes a terminal/session request, the appended tool call and observation carry `provenance.kind = "runtime_effect"`. When resume/replay rebuilds model-context items from transcript events, those rebuilt facts carry `provenance.kind = "transcript_replay"` plus the source event type, timestamp, and step index. Prompt rendering ignores this bookkeeping; it exists so recovery/eval/session-store code can distinguish historical facts from newly executed effects without creating a second execution path.

Active skill reminders are transient render inputs. They appear in the next model turn but are not persisted into the durable model context unless an explicit environment event or observation records them.

## Context Window

The prompt boundary compresses only model-visible context items. System prompt/tool contracts are not part of the compression budget.

Current default:

```text
max model-context tokens = 700_000
recent context items retained verbatim = 40
```

Before each `call_model`, `ModelContextSession` asks its injected `ModelContextWindowPort` to count model-context items. If the count reaches the threshold, the session replaces the older prefix with a deterministic `environment_reminder` summary and keeps the recent tail verbatim. The orchestrator receives explicit compaction metadata, records `history_compacted` for audit, and saves the updated `modelContext` snapshot to `session.json`.

Large debug strings should not participate in this budget. When the model adapter exposes raw prompt text for debugging, the orchestrator replaces it with a `promptRef` before the model output is persisted into state/transcript. The prompt remains inspectable on disk, while compaction only accounts for compact references and user/tool-facing model-context items.

## Persistence

Suggested run directory:

```text
.tiny-agent/
  runs/
    run-2026-05-25T20-00-00Z/
      state.json
      transcript.jsonl
      session.json
      debug/
        prompts/
          step-0000-thinking.prompt.txt
  sessions/
    default.log
    server.log
```

`state.json` is the latest snapshot.

`transcript.jsonl` is append-only and is the audit source.

`session.json` stores the persisted `ModelContextSessionSnapshot` used by resume. Its current schema stores `modelContext: { version, task, items }`. If it is missing, resume can reconstruct best-effort model-context items from `transcript.jsonl`.

`debug/prompts/*.prompt.txt` stores large model prompt artifacts referenced from transcript/model output by `promptRef`. The artifact metadata includes byte size and sha256 so later audits can verify which prompt was used without bloating replay state.

## Resume Semantics

Resume is supported through:

```bash
tiny-agent resume <runId|latest>
tiny-agent run --resume <runId|latest>
```

Resume does:

1. Load `state.json`.
2. Load `ModelContextSessionSnapshot` from `session.json`, or reconstruct best-effort model-context items from `transcript.jsonl`.
3. Append a resume reminder explaining that the PTY process tree is fresh.
4. Record `run_resumed` and continue from `nextEffect()`.

Resume restores run state and model-visible context, not the previous PTY process tree. Prior ssh, vim, cat, REPL, or other foreground processes do not survive. The next model step must inspect the fresh PTY with `session_observe` before assuming terminal state.

Recovery rules:

- `waiting_for_model`: resume as running and call the model again.
- `waiting_for_review`: re-run review for the pending tool request.
- `waiting_for_io`: wait for the persisted IO condition.
- `waiting_for_tool`: do not replay the tool. Convert the in-flight execution into a recoverable observation so the model must inspect filesystem/transcript/terminal state and retry deliberately if needed.

`src/run/recovery.ts` keeps the recovery checks as pure diagnostics over explicit snapshots. `src/run/replay.ts` builds replay/eval cases from explicit transcript events and state/session snapshots. These helpers are for debugger/eval/resume safety; they do not execute tools and they do not infer hidden filesystem state.

## Minimal First Implementation

Build only the current path:

1. `AgentRunState.nextEffect()`
2. `AgentRunState.apply(event)`
3. `RunOrchestrator.run()`
4. JSONL transcript append
5. Latest `state.json` snapshot
6. Table-driven tests for transition rules

Still deferred:

- parallel tool execution
- branching plans
- multi-agent scheduling
- web UI

The first implementation should stay boring: one task, one run, one loop, one pending effect at a time.
