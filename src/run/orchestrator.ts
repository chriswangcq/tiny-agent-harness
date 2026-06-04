import { createHash } from "node:crypto";
import type { RunError, RunEvent } from "../types/run.js";
import type { ModelDecisionTrace, RunArtifactRef } from "../types/run.js";
import type {
  AgentThinking,
  FimStepOutput,
  ModelProgressEvent,
  ModelStepContext,
} from "../types/model.js";
import type {
  ToolCallValidation,
  ToolDefinition,
  ToolObservation,
  ToolRequest,
  ToolReviewDecision,
} from "../types/tools.js";
import type { TerminalObservation } from "../terminal/types.js";
import type { InternalToolCall } from "../types/model.js";
import type { EnvironmentPort, EnvironmentEvent, IoWaitRequest } from "../types/environment.js";
import { ENVIRONMENT_EVENT_LEVELS, validateIoWaitRequest } from "../types/environment.js";
import { Environment } from "../environment/environment.js";
import type { ActiveSkillRunSummary } from "../types/skill.js";
import { AgentRunState } from "./state.js";
import {
  TranscriptStore,
  type RunDebugArtifact,
} from "../transcript/store.js";
import type {
  ModelContextItem,
  ModelContextSessionPort,
  ModelContextSessionSnapshot,
} from "../model/context-session.js";

const MODEL_THINKING_DELTA_MIN_INTERVAL_MS = 80;
const MODEL_THINKING_DELTA_MAX_BUFFER_CHARS = 160;
const RAW_DECISION_PREVIEW_CHARS = 400;

export interface ModelPort {
  generateTurn(
    context: ModelStepContext,
    options: {
      tools: ToolDefinition[];
      onProgress?: (event: ModelProgressEvent) => void | Promise<void>;
    },
  ): Promise<FimStepOutput>;
}

export interface ValidatorPort {
  validate(toolCall: InternalToolCall): ToolCallValidation;
}

export interface ReviewerPort {
  review(request: ToolRequest): Promise<ToolReviewDecision>;
}

export interface TerminalPort {
  execute(request: ToolRequest): Promise<ToolObservation>;
}

export interface RunSessionPort {
  saveModelContext(runId: string, snapshot: ModelContextSessionSnapshot): void;
}

export interface RunPorts {
  model: ModelPort;
  validator: ValidatorPort;
  reviewer: ReviewerPort;
  terminal: TerminalPort;
  modelContext: ModelContextSessionPort;
  session: RunSessionPort;
  tools: ToolDefinition[];
  environment: EnvironmentPort;
  listActiveSkillRuns: () => ActiveSkillRunSummary[];
}

export class RunOrchestrator {
  private state: AgentRunState;
  private readonly transcript: TranscriptStore;
  private readonly ports: RunPorts;

  constructor(
    initialState: AgentRunState,
    transcript: TranscriptStore,
    ports: RunPorts,
  ) {
    this.state = initialState;
    this.transcript = transcript;
    this.ports = ports;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async record(event: RunEvent): Promise<void> {
    this.transcript.append(event);
    this.state = this.state.apply(event);
    this.transcript.saveState(this.state.data);
  }

  async run(): Promise<AgentRunState> {
    this.transcript.ensureDir();

    if (this.state.status === "created") {
      await this.record({
        type: "run_started",
        runId: this.state.data.runId,
        task: this.state.data.task,
        cwd: this.state.data.cwd,
        timestamp: this.now(),
      });
    } else {
      await this.record({
        type: "run_resumed",
        runId: this.state.data.runId,
        previousStatus: this.state.status,
        timestamp: this.now(),
      });
      this.saveModelContext();
    }

    while (true) {
      const effect = this.state.nextEffect();

      if (effect.type === "call_model") {
        let context: ModelStepContext;
        try {
          // Consume environment events before calling the model
          const envEvents = this.ports.environment.consumeSince({
            runId: this.state.data.runId,
          });
          if (envEvents.length > 0) {
            await this.record({
              type: "environment_events_consumed",
              runId: this.state.data.runId,
              eventIds: envEvents.map((e) => e.id),
              timestamp: this.now(),
            });

            const envReminder = Environment.renderReminder(envEvents);
            if (envReminder) {
              this.ports.modelContext.append({
                type: "environment_reminder",
                content: envReminder,
              });
              this.saveModelContext();
            }
          }

          await this.compactModelContextIfNeeded();

          const activeSkillRuns = this.ports.listActiveSkillRuns();
          const transientReminders =
            activeSkillRuns.length > 0
              ? [renderActiveSkillReminder(activeSkillRuns)]
              : [];
          const { messages } = this.ports.modelContext.prepareModelTurn({
            transientReminders,
          });

          context = {
            runId: this.state.data.runId,
            stepIndex: this.state.data.stepIndex,
            messages,
          };
        } catch (error) {
          await this.failRun(error, "MODEL_CONTEXT_ERROR");
          break;
        }

        await this.record({
          type: "model_requested",
          stepIndex: this.state.data.stepIndex,
          timestamp: this.now(),
        });

        const thinkingTrace = createThinkingTraceSink();
        const thinkingProgress = createThinkingProgressRecorder({
          stepIndex: this.state.data.stepIndex,
          now: () => this.now(),
          append: (event) => this.transcript.append(event),
        });
        let output: FimStepOutput;
        try {
          output = await this.ports.model.generateTurn(context, {
            tools: this.ports.tools,
            onProgress: async (progress) => {
              if (progress.type === "thinking_delta") {
                thinkingTrace.append(progress);
                await thinkingProgress.append(progress);
              }
            },
          });
        } catch (error) {
          await thinkingProgress.flush();
          await this.failRun(error, "MODEL_ERROR");
          break;
        }
        await thinkingProgress.flush();
        output = this.persistModelDebugArtifacts(
          output,
          this.state.data.stepIndex,
          thinkingTrace.content(),
        );

        const modelStepIndex = this.state.data.stepIndex;
        await this.record({
          type: "model_output_received",
          stepIndex: modelStepIndex,
          output,
          turn: output.turn,
          timestamp: this.now(),
        });
        await this.record({
          type: "model_decision_recorded",
          stepIndex: modelStepIndex,
          decision: buildModelDecisionTrace({
            runId: this.state.data.runId,
            stepIndex: modelStepIndex,
            output,
          }),
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "validate_tool_call") {
        let result: ToolCallValidation;
        try {
          result = this.ports.validator.validate(effect.toolCall);
        } catch (error) {
          await this.failRun(error, "TOOL_VALIDATION_ERROR");
          break;
        }

        await this.record({
          type: "tool_call_validated",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          toolCall: effect.toolCall,
          result,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "review_tool") {
        await this.record({
          type: "tool_review_requested",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          request: effect.request,
          timestamp: this.now(),
        });

        let decision: ToolReviewDecision;
        try {
          decision = await this.ports.reviewer.review(effect.request);
        } catch (error) {
          await this.failRun(error, "TOOL_REVIEW_ERROR");
          break;
        }

        await this.record({
          type: "tool_reviewed",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          request: effect.request,
          decision,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "execute_tool") {
        await this.record({
          type: "tool_execution_started",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          request: effect.request,
          timestamp: this.now(),
        });

        let observation: ToolObservation;
        try {
          observation = await this.executeToolRequest(effect.request);
        } catch (error) {
          await this.failRun(error, "TOOL_EXECUTION_ERROR");
          break;
        }
        const toolCall =
          this.state.data.pendingToolCall ??
          (this.state.data.pendingModelTurn?.kind === "tool_call"
            ? this.state.data.pendingModelTurn.toolCall
            : undefined);

        const finishedStepIndex = this.state.data.stepIndex;
        const runtimeEffectProvenance = {
          kind: "runtime_effect" as const,
          stepIndex: finishedStepIndex,
        };

        if (toolCall) {
          this.ports.modelContext.append({
            type: "tool_call",
            toolCall,
            thinking: this.state.data.pendingModelOutput?.thinking,
            provenance: runtimeEffectProvenance,
          });
        }
        this.ports.modelContext.append({
          type: "observation",
          observation,
          provenance: runtimeEffectProvenance,
        });
        this.saveModelContext();

        await this.record({
          type: "tool_execution_finished",
          stepIndex: finishedStepIndex,
          decisionId: buildDecisionId(this.state.data.runId, finishedStepIndex),
          request: effect.request,
          observation,
          timestamp: this.now(),
        });
        await this.recordTerminalEnvironmentEvents(
          effect.request,
          observation,
          finishedStepIndex,
        );
        continue;
      }

      if (effect.type === "append_observation") {
        this.ports.modelContext.append({
          type: "observation",
          observation: effect.observation,
        });
        this.saveModelContext();

        await this.record({
          type: "observation_appended",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          observation: effect.observation,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "wait_io") {
        const ioWaitToolCallId = this.pendingIoWaitToolCallId();
        this.ports.modelContext.append({
          type: "io_wait_call",
          toolCallId: ioWaitToolCallId,
          wait: effect.wait,
          thinking: this.state.data.pendingModelOutput?.thinking,
        });
        this.saveModelContext();

        const invalidWait = validateIoWaitRequest(effect.wait);
        if (invalidWait !== undefined) {
          const observation = {
            kind: "io_wait" as const,
            message: invalidWait,
            recoverable: true,
          };
          this.ports.modelContext.append({
            type: "observation",
            toolCallId: ioWaitToolCallId,
            observation,
          });
          this.saveModelContext();
          await this.record({
            type: "observation_appended",
            stepIndex: this.state.data.stepIndex,
            decisionId: this.currentDecisionId(),
            observation,
            timestamp: this.now(),
          });
          continue;
        }

        const unsettledMessage = pendingImSendMessage(
          this.ports.modelContext.snapshot().items,
        );
        if (unsettledMessage !== undefined) {
          this.ports.modelContext.append({
            type: "observation",
            toolCallId: ioWaitToolCallId,
            observation: {
              kind: "io_wait",
              message: unsettledMessage,
              recoverable: true,
            },
          });
          this.saveModelContext();
          await this.record({
            type: "observation_appended",
            stepIndex: this.state.data.stepIndex,
            decisionId: this.currentDecisionId(),
            observation: {
              kind: "io_wait",
              message: unsettledMessage,
              recoverable: true,
            },
            timestamp: this.now(),
          });
          continue;
        }

        await this.record({
          type: "io_wait_started",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          wait: effect.wait,
          timestamp: this.now(),
        });

        let event: EnvironmentEvent;
        const waitPromise = this.ports.environment.waitFor({
          runId: this.state.data.runId,
          wait: effect.wait,
        });
        const stopSessionPump = this.startSessionEnvironmentPump(
          this.state.data.stepIndex,
        );
        try {
          event = await waitPromise;
        } catch (error) {
          await this.failRun(error, "IO_WAIT_ERROR");
          break;
        } finally {
          stopSessionPump();
        }

        this.ports.modelContext.append({
          type: "observation",
          toolCallId: ioWaitToolCallId,
          observation: {
            kind: "io_wait",
            message: "io_wait satisfied by external event.",
            recoverable: false,
            event,
          },
        });
        this.saveModelContext();

        await this.record({
          type: "io_wait_satisfied",
          stepIndex: this.state.data.stepIndex,
          decisionId: this.currentDecisionId(),
          wait: effect.wait,
          event,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "stop") {
        const finalStatus =
          this.state.status === "cancelled"
            ? "cancelled" as const
            : "failed" as const;

        const event: RunEvent = {
          type: "run_finished",
          status: finalStatus,
          error: this.state.data.error,
          timestamp: this.now(),
        };

        if (
          this.state.status === "cancelled" ||
          this.state.status === "failed"
        ) {
          this.transcript.append(event);
          this.transcript.saveState(this.state.data);
        } else {
          await this.record(event);
        }
        break;
      }
    }

    return this.state;
  }

  private pendingIoWaitToolCallId(): string {
    return `fim-call-${this.state.data.runId}-${this.state.data.stepIndex}`;
  }

  private currentDecisionId(): string {
    return buildDecisionId(this.state.data.runId, this.state.data.stepIndex);
  }

  private async failRun(error: unknown, code: string): Promise<void> {
    await this.record({
      type: "run_finished",
      status: "failed",
      error: toRunError(error, code),
      timestamp: this.now(),
    });
  }

  private async executeToolRequest(
    request: ToolRequest,
  ): Promise<ToolObservation> {
    return this.ports.terminal.execute(request);
  }

  private async recordTerminalEnvironmentEvents(
    request: ToolRequest,
    observation: ToolObservation,
    stepIndex: number,
  ): Promise<void> {
    if (!isTerminalObservation(observation) || observation.result !== "ok") {
      return;
    }

    const events = terminalObservationToEnvironmentEvents({
      runId: this.state.data.runId,
      stepIndex,
      request,
      observation,
      timestamp: this.now(),
    });

    for (const event of events) {
      const appended = this.ports.environment.appendEvent(event);
      if (appended === false) {
        continue;
      }
      await this.record({
        type: "environment_event_recorded",
        event,
        timestamp: this.now(),
      });
    }
  }

  private startSessionEnvironmentPump(stepIndex: number): () => void {
    let stopped = false;
    let inFlight = false;
    let tick = 0;
    const interval = setInterval(() => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          const request: ToolRequest = {
            kind: "terminal_tool",
            toolName: "session_observe",
            toolCallId: `session-watch-${this.state.data.runId}-${stepIndex}-${tick++}`,
            request: { kind: "session_observe" },
          };
          const observation = await this.ports.terminal.execute(request);
          await this.recordTerminalEnvironmentEvents(
            request,
            observation,
            stepIndex,
          );
        } catch {
          // Background session observation is best-effort; explicit tool calls
          // still surface terminal failures to the model.
        } finally {
          inFlight = false;
        }
      })();
    }, 250);
    interval.unref?.();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  private persistModelDebugArtifacts(
    output: FimStepOutput,
    stepIndex: number,
    thinkingTrace: string = "",
  ): FimStepOutput {
    let thinking = output.thinking;
    if (!hasPrompt(thinking.raw) && thinkingTrace.length === 0) {
      return output;
    }

    if (hasPrompt(thinking.raw)) {
      const promptRef = this.transcript.writeDebugArtifact(
        `debug/prompts/step-${String(stepIndex).padStart(4, "0")}-thinking.prompt.txt`,
        thinking.raw.prompt,
      );
      thinking = withPromptRef(thinking, promptRef);
    }

    if (thinkingTrace.length > 0) {
      const traceRef = this.transcript.writeDebugArtifact(
        `debug/thinking/step-${String(stepIndex).padStart(4, "0")}-thinking.trace.txt`,
        thinkingTrace,
      );
      thinking = withThinkingRawPatch(thinking, { traceRef });
    }

    return {
      ...output,
      thinking,
      turn: withTurnThinking(output.turn, thinking),
    };
  }

  private async compactModelContextIfNeeded(): Promise<void> {
    const compaction = await this.ports.modelContext.compactIfNeeded({
      stepIndex: this.state.data.stepIndex,
    });
    if (compaction === undefined || compaction.droppedItemCount === 0) {
      return;
    }

    this.saveModelContext();
    const { items: _items, ...eventCompaction } = compaction;
    await this.record({
      type: "history_compacted",
      stepIndex: this.state.data.stepIndex,
      compaction: eventCompaction,
      timestamp: this.now(),
    });
  }

  private saveModelContext(): void {
    this.ports.session.saveModelContext(
      this.state.data.runId,
      this.ports.modelContext.snapshot(),
    );
  }
}

function renderActiveSkillReminder(runs: ActiveSkillRunSummary[]): string {
  const lines = ["Active skill reminder:"];
  for (const run of runs) {
    let line = `- [${run.skillRunId}] skill=${run.skill} status=${run.status}`;
    if (run.executionReturnCode !== undefined) {
      line += ` rc=${run.executionReturnCode}`;
    }
    line += ` log=${run.executionLogPath}`;
    if (run.status === "review_pending" && run.reviewTaskPath) {
      line += ` task=${run.reviewTaskPath}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function buildDecisionId(runId: string, stepIndex: number): string {
  return `decision-${runId}-${stepIndex}`;
}

function buildModelDecisionTrace(input: {
  runId: string;
  stepIndex: number;
  output: FimStepOutput;
}): ModelDecisionTrace {
  const { output, runId, stepIndex } = input;
  const turn = output.turn;
  const trace: ModelDecisionTrace = {
    schemaVersion: 1,
    decisionId: buildDecisionId(runId, stepIndex),
    stepIndex,
    kind: turn.kind,
    thinking: buildThinkingFacts(output.thinking),
    rawDecision: buildRawDecisionFacts(output.rawDecision),
  };

  if (turn.kind === "tool_call") {
    trace.toolCall = {
      id: turn.toolCall.id,
      name: turn.toolCall.name,
      arguments: turn.toolCall.arguments,
    };
  } else if (turn.kind === "io_wait") {
    trace.ioWait = turn.wait;
  } else {
    trace.invalidOutput = {
      message: turn.message,
      ...(turn.diagnostic ? { diagnostic: turn.diagnostic } : {}),
    };
  }

  return trace;
}

function buildThinkingFacts(thinking: AgentThinking): ModelDecisionTrace["thinking"] {
  return {
    contentChars: thinking.content.length,
    contentBytes: Buffer.byteLength(thinking.content, "utf-8"),
    ...optionalArtifactRef("promptRef", artifactRef(thinking.raw, "promptRef")),
    ...optionalArtifactRef("traceRef", artifactRef(thinking.raw, "traceRef")),
  };
}

function optionalArtifactRef<K extends "promptRef" | "traceRef">(
  key: K,
  value: RunArtifactRef | undefined,
): Pick<ModelDecisionTrace["thinking"], K> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Pick<ModelDecisionTrace["thinking"], K>;
}

function buildRawDecisionFacts(rawDecision: string): NonNullable<ModelDecisionTrace["rawDecision"]> {
  return {
    bytes: Buffer.byteLength(rawDecision, "utf-8"),
    sha256: createHash("sha256").update(rawDecision, "utf-8").digest("hex"),
    preview: compactRawDecisionPreview(rawDecision),
  };
}

function compactRawDecisionPreview(rawDecision: string): string {
  if (rawDecision.length <= RAW_DECISION_PREVIEW_CHARS) {
    return rawDecision;
  }
  return `${rawDecision.slice(0, RAW_DECISION_PREVIEW_CHARS - 3)}...`;
}

function artifactRef(
  raw: unknown,
  key: "promptRef" | "traceRef",
): RunArtifactRef | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = (raw as Record<string, unknown>)[key];
  return isRunArtifactRef(value) ? value : undefined;
}

function isRunArtifactRef(value: unknown): value is RunArtifactRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { relativePath?: unknown }).relativePath === "string" &&
    typeof (value as { bytes?: unknown }).bytes === "number" &&
    typeof (value as { sha256?: unknown }).sha256 === "string"
  );
}

function toRunError(error: unknown, code: string): RunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      code,
      details: {
        name: error.name,
        stack: error.stack,
        cause: serializeErrorCause((error as Error & { cause?: unknown }).cause),
      },
    };
  }

  return {
    message: String(error),
    code,
  };
}

function hasPrompt(value: unknown): value is { prompt: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prompt?: unknown }).prompt === "string"
  );
}

function withPromptRef(
  thinking: AgentThinking,
  promptRef: RunDebugArtifact,
): AgentThinking {
  if (!hasPrompt(thinking.raw)) {
    return thinking;
  }
  const { prompt: _prompt, ...raw } = thinking.raw;
  return {
    ...thinking,
    raw: {
      ...raw,
      promptRef,
    },
  };
}

function withThinkingRawPatch(
  thinking: AgentThinking,
  patch: Record<string, unknown>,
): AgentThinking {
  return {
    ...thinking,
    raw: {
      ...rawObject(thinking.raw),
      ...patch,
    },
  };
}

function rawObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (raw === undefined) {
    return {};
  }
  return { rawValue: raw };
}

function withTurnThinking(
  turn: FimStepOutput["turn"],
  thinking: AgentThinking,
): FimStepOutput["turn"] {
  switch (turn.kind) {
    case "tool_call":
      return { ...turn, thinking };
    case "io_wait":
      return { ...turn, thinking };
    case "invalid_output":
      return { ...turn, thinking };
  }
}

function createThinkingTraceSink(): {
  append(event: ModelProgressEvent): void;
  content(): string;
} {
  const chunks = new Map<number, string>();
  return {
    append(event) {
      chunks.set(event.sequence, event.content);
    },
    content() {
      return [...chunks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, content]) => content)
        .join("");
    },
  };
}

function createThinkingProgressRecorder(options: {
  stepIndex: number;
  now: () => string;
  append: (event: Extract<RunEvent, { type: "model_thinking_delta" }>) => void;
}): {
  append(event: ModelProgressEvent): Promise<void>;
  flush(): Promise<void>;
} {
  let pending = "";
  let sequence = 0;
  let lastEmittedAtMs: number | undefined;

  async function flushAt(timestamp: string, timestampMs: number): Promise<void> {
    if (pending.length === 0) return;
    const delta = pending;
    pending = "";
    options.append({
      type: "model_thinking_delta",
      stepIndex: options.stepIndex,
      delta,
      sequence,
      timestamp,
    });
    sequence++;
    lastEmittedAtMs = timestampMs;
  }

  return {
    async append(event): Promise<void> {
      if (event.content.length === 0) return;
      pending += event.content;
      const timestamp = options.now();
      const nowMs = timestampMsOrZero(timestamp);
      const shouldEmit =
        lastEmittedAtMs === undefined ||
        pending.length >= MODEL_THINKING_DELTA_MAX_BUFFER_CHARS ||
        nowMs - lastEmittedAtMs >= MODEL_THINKING_DELTA_MIN_INTERVAL_MS;
      if (shouldEmit) {
        await flushAt(timestamp, nowMs);
      }
    },
    async flush(): Promise<void> {
      const timestamp = options.now();
      await flushAt(timestamp, timestampMsOrZero(timestamp));
    },
  };
}

function timestampMsOrZero(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function serializeErrorCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const errorCode = (cause as Error & { code?: unknown }).code;
    return {
      name: cause.name,
      message: cause.message,
      code: typeof errorCode === "string" ? errorCode : undefined,
    };
  }
  return cause;
}

function pendingImSendMessage(
  items: readonly ModelContextItem[],
): string | undefined {
  const latestObservationIndex = findLastHistoryIndex(
    items,
    (entry) => entry.type === "observation",
  );
  if (latestObservationIndex === -1) {
    return undefined;
  }

  const latestObservation = items[latestObservationIndex] as Extract<
    ModelContextItem,
    { type: "observation" }
  >;
  const observation = latestObservation.observation;
  if (!isTerminalObservation(observation)) {
    return undefined;
  }
  if (observation.result !== "ok" || observation.request !== "terminal_write") {
    return undefined;
  }
  if (observation.returnedToPrompt) {
    return undefined;
  }

  const latestToolCall = items
    .slice(0, latestObservationIndex)
    .reverse()
    .find((entry): entry is Extract<ModelContextItem, { type: "tool_call" }> =>
      entry.type === "tool_call",
    );
  if (
    latestToolCall?.toolCall.name !== "terminal_write" ||
    !isTerminalWriteArguments(latestToolCall.toolCall.arguments) ||
    !isImSendText(latestToolCall.toolCall.arguments.text)
  ) {
    return undefined;
  }

  return "Cannot wait for user input yet: the latest IM send terminal_write has not returned to a shell prompt. Observe the session until the command finishes and the prompt returns, then call io_wait.";
}

function terminalObservationToEnvironmentEvents(input: {
  runId: string;
  stepIndex: number;
  request: ToolRequest;
  observation: TerminalObservation;
  timestamp: string;
}): EnvironmentEvent[] {
  const { request, observation } = input;
  const terminalEvents = observation.terminalEvents ?? [];
  const promptEvent = terminalEvents
    .filter((event) => event.kind === "prompt")
    .at(-1);
  const continuationEvent = terminalEvents
    .filter((event) => event.kind === "continuation_prompt")
    .at(-1);
  const outputEvents = terminalEvents.filter((event) => event.kind === "output");
  const eventBase = {
    source: "session" as const,
    timestamp: input.timestamp,
    session: observation.observedSession,
    currentSession: observation.currentSession,
    request: observation.request,
    inputSeq: observation.terminal.inputSeq,
    cwd: observation.terminal.lastShellPrompt?.cwd,
    lastReturnCode: observation.terminal.lastShellPrompt?.lastReturnCode,
    foregroundProcess: observation.terminal.foregroundProcess,
  };
  const idPrefix = `env-session-${input.runId}-${stableEventIdPart(observation.observedSession)}`;
  const events: EnvironmentEvent[] = [];

  if (outputEvents.length > 0) {
    events.push({
      ...eventBase,
      id: `${idPrefix}-output-${observation.terminal.inputSeq}`,
      level: ENVIRONMENT_EVENT_LEVELS.NOISE,
      kind: "session_output_available",
    });
  }

  if (request.request.kind === "session_focus") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-focused-${stableEventIdPart(request.toolCallId)}`,
      level: ENVIRONMENT_EVENT_LEVELS.DEFAULT,
      kind: "session_focused",
    });
  }

  if (request.request.kind === "session_restart") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-restarted-${stableEventIdPart(request.toolCallId)}`,
      level: ENVIRONMENT_EVENT_LEVELS.DEFAULT,
      kind: "session_restarted",
    });
  }

  if (continuationEvent !== undefined) {
    const continuationKey = promptFactKey({
      promptSeq: continuationEvent.promptSeq,
      promptNonce: continuationEvent.promptNonce,
      fallback: observation.terminal.inputSeq,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-continuation-${continuationKey}`,
      level: ENVIRONMENT_EVENT_LEVELS.MEANINGFUL,
      kind: "session_continuation_prompt",
      promptSeq: continuationEvent.promptSeq,
      continuationReason: continuationEvent.reason,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-input-ready-continuation-${continuationKey}`,
      level: ENVIRONMENT_EVENT_LEVELS.MEANINGFUL,
      kind: "session_input_ready",
      promptSeq: continuationEvent.promptSeq,
      continuationReason: continuationEvent.reason,
    });
  }

  if (promptEvent !== undefined || observation.returnedToPrompt) {
    const promptSeq =
      promptEvent?.promptSeq ?? observation.terminal.lastShellPrompt?.promptSeq;
    const promptKey = promptFactKey({
      promptSeq,
      promptNonce: promptEvent?.promptNonce,
      fallback: observation.terminal.inputSeq,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-returned-${promptKey}`,
      level: ENVIRONMENT_EVENT_LEVELS.MEANINGFUL,
      kind: "session_returned_to_prompt",
      promptSeq,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-input-ready-prompt-${promptKey}`,
      level: ENVIRONMENT_EVENT_LEVELS.MEANINGFUL,
      kind: "session_input_ready",
      promptSeq,
    });
  }

  if (observation.terminal.syncStatus.kind === "unsynced") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-unsynced-${observation.terminal.inputSeq}-${stableEventIdPart(observation.terminal.syncStatus.reason)}`,
      level: ENVIRONMENT_EVENT_LEVELS.IMPORTANT,
      kind: "session_unsynced",
      reason: observation.terminal.syncStatus.reason,
    });
  }

  if (!observation.terminal.alive) {
    events.push({
      ...eventBase,
      id: `${idPrefix}-terminated-${observation.terminal.inputSeq}`,
      level: ENVIRONMENT_EVENT_LEVELS.IMPORTANT,
      kind: "session_terminated",
      reason: observation.terminal.termination?.reason,
      exitCode: observation.terminal.termination?.exitCode,
    });
  }

  return events;
}

function promptFactKey(input: {
  promptSeq: number | undefined;
  promptNonce: string | undefined;
  fallback: number;
}): string {
  if (input.promptNonce && input.promptNonce.length > 0) {
    const nonceKey = `nonce-${stableEventIdPart(input.promptNonce)}`;
    return input.promptSeq === undefined
      ? nonceKey
      : `${nonceKey}-seq-${input.promptSeq}`;
  }
  if (input.promptSeq !== undefined) {
    return `seq-${input.promptSeq}`;
  }
  return `input-${input.fallback}`;
}

function stableEventIdPart(value: string): string {
  return encodeURIComponent(value).replace(/%/gu, "_");
}

function findLastHistoryIndex(
  items: readonly ModelContextItem[],
  predicate: (entry: ModelContextItem) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}

function isTerminalObservation(value: unknown): value is TerminalObservation {
  return (
    typeof value === "object" &&
    value !== null &&
    "terminal" in value &&
    "request" in value &&
    "result" in value &&
    "returnedToPrompt" in value &&
    "screen" in value
  );
}

function isTerminalWriteArguments(
  value: unknown,
): value is { expectedInputSeq: number; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isImSendText(text: string): boolean {
  return /\bim\s+send\b/u.test(text);
}
