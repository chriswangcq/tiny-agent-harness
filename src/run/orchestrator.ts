import type { RunError, RunEvent } from "../types/run.js";
import type {
  AgentThinking,
  FimStepOutput,
  ModelProgressEvent,
  ModelStepContext,
  V4ChatMessage,
} from "../types/model.js";
import type {
  AgentObservation,
  BashToolRequest,
  StashFileToolRequest,
  ToolCallValidation,
  ToolDefinition,
  ToolRequest,
  ToolReviewDecision,
} from "../types/tools.js";
import type { PtyObservation } from "../terminal/types.js";
import type { InternalToolCall } from "../types/model.js";
import type { EnvironmentPort, EnvironmentEvent, IoWaitRequest } from "../types/environment.js";
import { Environment } from "../environment/environment.js";
import { wrapReminderAsUserContent } from "../model/prompt-builder.js";
import type { ActiveSkillRunSummary } from "../types/skill.js";
import { AgentRunState } from "./state.js";
import { TranscriptStore } from "../transcript/store.js";

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
  execute(request: BashToolRequest): Promise<PtyObservation>;
}

export interface StashFilePort {
  stash(request: StashFileToolRequest): Promise<AgentObservation>;
}

export interface PromptPort {
  buildMessages(task: string, history: HistoryItem[]): V4ChatMessage[];
}

export type HistoryItem =
  | { type: "tool_call"; toolCall: InternalToolCall; thinking?: AgentThinking }
  | { type: "observation"; observation: PtyObservation | AgentObservation }
  | { type: "environment_reminder"; content: string };

export interface RunPorts {
  model: ModelPort;
  validator: ValidatorPort;
  reviewer: ReviewerPort;
  terminal: TerminalPort;
  stashFiles: StashFilePort;
  prompt: PromptPort;
  tools: ToolDefinition[];
  environment: EnvironmentPort;
  listActiveSkillRuns: () => ActiveSkillRunSummary[];
}

export class RunOrchestrator {
  private state: AgentRunState;
  private readonly transcript: TranscriptStore;
  private readonly ports: RunPorts;
  private readonly history: HistoryItem[] = [];

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

    await this.record({
      type: "run_started",
      runId: this.state.data.runId,
      task: this.state.data.task,
      cwd: this.state.data.cwd,
      maxSteps: this.state.data.maxSteps,
      timestamp: this.now(),
    });

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
            this.history.push({
              type: "environment_reminder",
              content: envReminder,
            });
          }
        }

        const messages = this.ports.prompt.buildMessages(
          this.state.data.task,
          this.history,
        );

        // Render active skill runs as persistent reminder
        const activeSkillRuns = this.ports.listActiveSkillRuns();
        if (activeSkillRuns.length > 0) {
          const reminder = renderActiveSkillReminder(activeSkillRuns);
          messages.push({
            role: "user",
            content: wrapReminderAsUserContent(reminder),
          });
        }

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

        let observation: PtyObservation | AgentObservation;
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
          this.history.push({
            type: "tool_call",
            toolCall,
            thinking: this.state.data.pendingModelOutput?.thinking,
          });
        }
        this.history.push({ type: "observation", observation });

        await this.record({
          type: "tool_execution_finished",
          stepIndex: this.state.data.stepIndex,
          request: effect.request,
          observation,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "append_observation") {
        this.history.push({ type: "observation", observation: effect.observation });

        await this.record({
          type: "observation_appended",
          stepIndex: this.state.data.stepIndex,
          observation: effect.observation,
          timestamp: this.now(),
        });
        continue;
      }

      if (effect.type === "wait_io") {
        const unsettledMessage = pendingImSendMessage(this.history);
        if (unsettledMessage !== undefined) {
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
        try {
          event = await this.ports.environment.waitFor({
            runId: this.state.data.runId,
            wait: effect.wait,
          });
        } catch (error) {
          await this.failRun(error, "IO_WAIT_ERROR");
          break;
        }

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
  ): Promise<PtyObservation | AgentObservation> {
    if (request.kind === "stash_file") {
      return this.ports.stashFiles.stash(request);
    }
    return this.ports.terminal.execute(request);
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

function pendingImSendMessage(history: readonly HistoryItem[]): string | undefined {
  const latestObservation = [...history].reverse().find(
    (entry): entry is Extract<HistoryItem, { type: "observation" }> =>
      entry.type === "observation",
  );
  if (latestObservation === undefined) {
    return undefined;
  }

  const observation = latestObservation.observation;
  if (!isPtyObservation(observation)) {
    return undefined;
  }
  if (observation.result !== "ok" || observation.action.kind !== "write_text") {
    return undefined;
  }
  if (!isImSendPreview(observation.action.preview)) {
    return undefined;
  }
  if (observation.events.some((event) => event.kind === "prompt")) {
    return undefined;
  }

  return "Cannot wait for user input yet: the latest IM send write_text has not returned to a shell prompt. Poll until the command finishes and the prompt returns, then call io_wait.";
}

function isPtyObservation(value: PtyObservation | AgentObservation): value is PtyObservation {
  return (
    typeof value === "object" &&
    value !== null &&
    "terminal" in value &&
    "action" in value &&
    "events" in value
  );
}

function isImSendPreview(preview: string | undefined): boolean {
  return preview !== undefined && /\bim\s+send\b/u.test(preview);
}
