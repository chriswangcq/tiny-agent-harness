# Run Orchestrator And Agent Run State Design

本文记录 tiny-agent-harness 第一版 run loop、agent run state、effect 和 event 协议。

## Design Principles

1. Run orchestrator 本质是一个 `for` / `while` loop。
2. Agent run state 是该 loop 的显式状态机，负责判断下一步要产生什么 effect。
3. Orchestrator 负责执行副作用：调用模型、审核工具、执行 bash、写 transcript。
4. State transition 尽量保持纯逻辑：`state + event -> next state`。
5. 不用一堆局部变量隐式保存 pending model output、pending tool call、pending review。
6. Run state 必须能落盘，后续才方便 debug、resume、eval 和 self-improve。

## Module Responsibilities

```text
RunOrchestrator
  owns: loop, side effects, IO boundaries
  calls: DeepSeekFimAdapter, Environment, ToolReviewer, BashSessionManager, ImCliTransport, TranscriptStore

AgentRunState
  owns: status, step index, transcript pointers, pending tool call/review, stop conditions
  exposes: nextEffect(), apply(event)

DeepSeekFimAdapter
  owns: two FIM completions per model step and conversion into ModelTurn

FimPromptBuilder
  owns: FIM prompt/suffix construction from task, config, transcript, session summaries

ImCliTransport
  owns: user message receive/send through im CLI

Environment
  owns: latest external events and consumed-event cursors

ToolCallValidator
  owns: schema validation and conversion from InternalToolCall to ToolRequest

ToolReviewer
  owns: approve/reject decision before execution

BashSessionManager
  owns: bash sessions and observations

TranscriptStore
  owns: append-only run events on disk
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
  | "completed"
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
  maxSteps: number;

  transcriptPath: string;
  lastEventId?: string;

  pendingModelOutput?: FimStepOutput;
  pendingModelTurn?: ModelTurn;
  pendingToolCall?: InternalToolCall;
  pendingToolRequest?: ToolRequest;
  pendingReview?: ToolReviewDecision;
  pendingIoWait?: IoWaitRequest;

  final?: string;
  error?: RunError;
};
```

`status` 是互斥生命周期状态，不用 `isRunning`、`isDone`、`hasError` 这类并列布尔值。

`stepIndex` 表示已完成的 agent step 数。一次 step 通常包含：

```text
model output -> optional tool validation -> optional tool review -> optional tool execution -> observation
```

如果模型直接返回 final，则该 run 完成，不再增加新的 tool step。

## Model Turn

模型原始响应必须经过 DeepSeek FIM adapter，run state 不直接消费 FIM 原始文本。

```ts
type ModelTurn =
  | {
      kind: "final";
      content: string;
      thinking: AgentThinking;
      rawDecision: string;
      raw?: unknown;
    }
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

`io_wait` 是 Agent 向自己的 run state machine 提交等待请求。它不是 bash tool，也不执行外部业务动作；orchestrator 会等待 Environment 中出现满足条件的事件，满足后才允许下一轮 model step。

First version supports only new user message wait:

```ts
type IoWaitRequest = {
  reason?: string;
  condition:
    | {
        kind: "new_user_message";
        channel: string;
        cursor?: string;
      }
    | {
        kind: "event";
        eventKind: EnvironmentEvent["kind"];
        source?: EnvironmentEvent["source"];
      };
};
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
      reason: "final" | "max_steps" | "failed" | "cancelled";
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
      maxSteps: number;
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
      wait: IoWaitRequest;
      timestamp: string;
    }
  | {
      type: "io_wait_satisfied";
      stepIndex: number;
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
      toolCall: InternalToolCall;
      result: ToolCallValidation;
      timestamp: string;
    }
  | {
      type: "tool_review_requested";
      stepIndex: number;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_reviewed";
      stepIndex: number;
      request: ToolRequest;
      decision: ToolReviewDecision;
      timestamp: string;
    }
  | {
      type: "tool_execution_started";
      stepIndex: number;
      request: ToolRequest;
      timestamp: string;
    }
  | {
      type: "tool_execution_finished";
      stepIndex: number;
      request: ToolRequest;
      observation: BashObservation;
      timestamp: string;
    }
  | {
      type: "observation_appended";
      stepIndex: number;
      observation: AgentObservation;
      timestamp: string;
    }
  | {
      type: "run_finished";
      status: "completed" | "failed" | "cancelled";
      final?: string;
      error?: RunError;
      timestamp: string;
    };
```

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
    maxSteps: state.maxSteps,
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
        bashTool: ports.tools.bash
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

      const observation = await ports.bash.execute(effect.request);

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
        status: state.status === "completed" ? "completed" : state.status === "cancelled" ? "cancelled" : "failed",
        final: state.final,
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

## Transition Rules

```text
created + run_started
  -> running

running + model_requested
  -> waiting_for_model

waiting_for_model + model_output_received(final)
  -> completed

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

running + stepIndex >= maxSteps
  -> failed with max-steps error

any non-terminal + cancel
  -> cancelled

any non-terminal + unrecoverable error
  -> failed
```

Invalid transitions should fail loudly in development. For example:

```text
completed + model_output_received -> invalid
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

running + no pending work + stepIndex < maxSteps
  -> call_model

running + stepIndex >= maxSteps
  -> stop(max_steps)

completed / failed / cancelled
  -> stop(...)
```

## Synthetic Observations

Some failures should go back to the Agent instead of ending the run immediately.

Invalid output observation:

```json
{
  "kind": "model_output",
  "message": "Model response did not contain final content or a valid tool call.",
  "recoverable": true
}
```

Tool validation observation:

```json
{
  "kind": "tool_validation",
  "message": "Invalid bash tool arguments: command input requires session and command.",
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

These observations enter the transcript exactly like bash observations, while the full EnvironmentEvent is also consumed into the next FIM step as a system reminder.

## Step Counting

`stepIndex` increments after one complete action cycle:

```text
model tool_call -> validate -> review -> execute/pseudo-observe -> observation appended
model io_wait -> wait until condition satisfied -> observation appended
```

Final answers do not increment `stepIndex`.

Invalid model outputs, tool validation errors, review rejections, and satisfied IO waits do increment `stepIndex` after the synthetic observation is appended. This prevents an Agent from looping forever on invalid outputs, rejected commands, or repeated waits without spending budget.

## Persistence

Suggested run directory:

```text
.tiny-agent/
  runs/
    run-2026-05-25T20-00-00Z/
      state.json
      transcript.jsonl
      prompts/
        step-000.md
        step-001.md
  sessions/
    default.log
    server.log
```

`state.json` is the latest snapshot.

`transcript.jsonl` is append-only and is the audit source.

Prompt files are optional but useful for debugging model behavior without stuffing huge FIM prompt text into every JSONL event.

## Resume Semantics

First version can skip full resume, but the design should not block it.

Resume should:

1. Load `state.json`.
2. Normalize any persisted `waiting_*` state into a recoverable state.
3. Reconnect or recreate bash sessions.
4. Read session log paths from state/session metadata.
5. Continue from `nextEffect()`.

`waiting_for_model`, `waiting_for_review`, and `waiting_for_tool` mean a side effect was in flight. If the previous process died there, resume should not blindly assume the side effect completed.

Suggested recovery:

- `waiting_for_model`: append a recoverable observation that the model request was interrupted, then call the model again.
- `waiting_for_review`: re-run review for the pending tool request.
- `waiting_for_tool`: mark the pending execution as unknown and ask the session manager for `status` / `poll` before continuing.

## Minimal First Implementation

Build only the current path:

1. `AgentRunState.nextEffect()`
2. `AgentRunState.apply(event)`
3. `RunOrchestrator.run()`
4. JSONL transcript append
5. Latest `state.json` snapshot
6. Table-driven tests for transition rules

Defer:

- full process crash resume
- parallel tool execution
- branching plans
- multi-agent scheduling
- web UI

The first implementation should stay boring: one task, one run, one loop, one pending effect at a time.
