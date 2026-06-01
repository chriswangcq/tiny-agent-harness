import type { RunError, RunEvent } from "../types/run.js";
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
import { validateIoWaitRequest } from "../types/environment.js";
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

        const context: ModelStepContext = {
          runId: this.state.data.runId,
          stepIndex: this.state.data.stepIndex,
          messages,
        };

        await this.record({
          type: "model_requested",
          stepIndex: this.state.data.stepIndex,
          timestamp: this.now(),
        });

        let output: FimStepOutput;
        try {
          output = await this.ports.model.generateTurn(context, {
            tools: this.ports.tools,
            onProgress: async (progress) => {
              if (progress.type === "thinking_delta") {
                await this.record({
                  type: "model_thinking_delta",
                  stepIndex: context.stepIndex,
                  delta: progress.content,
                  sequence: progress.sequence,
                  timestamp: this.now(),
                });
              }
            },
          });
        } catch (error) {
          await this.failRun(error, "MODEL_ERROR");
          break;
        }
        output = this.persistModelDebugArtifacts(output, this.state.data.stepIndex);

        await this.record({
          type: "model_output_received",
          stepIndex: this.state.data.stepIndex,
          output,
          turn: output.turn,
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

        if (toolCall) {
          this.ports.modelContext.append({
            type: "tool_call",
            toolCall,
            thinking: this.state.data.pendingModelOutput?.thinking,
          });
        }
        this.ports.modelContext.append({ type: "observation", observation });
        this.saveModelContext();

        const finishedStepIndex = this.state.data.stepIndex;
        await this.record({
          type: "tool_execution_finished",
          stepIndex: finishedStepIndex,
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
      this.ports.environment.appendEvent(event);
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
  ): FimStepOutput {
    const raw = output.thinking.raw;
    if (!hasPrompt(raw)) {
      return output;
    }

    const promptRef = this.transcript.writeDebugArtifact(
      `debug/prompts/step-${String(stepIndex).padStart(4, "0")}-thinking.prompt.txt`,
      raw.prompt,
    );
    const thinking = withPromptRef(output.thinking, promptRef);
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
  const idPrefix = `env-session-${input.runId}-${input.stepIndex}-${request.toolCallId}`;
  const events: EnvironmentEvent[] = [];

  if (outputEvents.length > 0) {
    events.push({
      ...eventBase,
      id: `${idPrefix}-output-${observation.terminal.inputSeq}`,
      level: 0,
      kind: "session_output_available",
    });
  }

  if (request.request.kind === "session_focus") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-focused`,
      level: 1,
      kind: "session_focused",
    });
  }

  if (request.request.kind === "session_restart") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-restarted`,
      level: 1,
      kind: "session_restarted",
    });
  }

  if (continuationEvent !== undefined) {
    events.push({
      ...eventBase,
      id: `${idPrefix}-continuation-${continuationEvent.promptSeq}`,
      level: 10,
      kind: "session_continuation_prompt",
      promptSeq: continuationEvent.promptSeq,
      continuationReason: continuationEvent.reason,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-input-ready-continuation-${continuationEvent.promptSeq}`,
      level: 10,
      kind: "session_input_ready",
      promptSeq: continuationEvent.promptSeq,
      continuationReason: continuationEvent.reason,
    });
  }

  if (promptEvent !== undefined || observation.returnedToPrompt) {
    const promptSeq =
      promptEvent?.promptSeq ?? observation.terminal.lastShellPrompt?.promptSeq;
    events.push({
      ...eventBase,
      id: `${idPrefix}-returned-${promptSeq ?? observation.terminal.inputSeq}`,
      level: 10,
      kind: "session_returned_to_prompt",
      promptSeq,
    });
    events.push({
      ...eventBase,
      id: `${idPrefix}-input-ready-prompt-${promptSeq ?? observation.terminal.inputSeq}`,
      level: 10,
      kind: "session_input_ready",
      promptSeq,
    });
  }

  if (observation.terminal.syncStatus.kind === "unsynced") {
    events.push({
      ...eventBase,
      id: `${idPrefix}-unsynced`,
      level: 50,
      kind: "session_unsynced",
      reason: observation.terminal.syncStatus.reason,
    });
  }

  if (!observation.terminal.alive) {
    events.push({
      ...eventBase,
      id: `${idPrefix}-terminated`,
      level: 50,
      kind: "session_terminated",
      reason: observation.terminal.termination?.reason,
      exitCode: observation.terminal.termination?.exitCode,
    });
  }

  return events;
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
