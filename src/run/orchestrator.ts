import type { RunError, RunEvent } from "../types/run.js";
import type {
  AgentThinking,
  FimStepOutput,
  ModelProgressEvent,
  ModelStepContext,
  V4ChatMessage,
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
import { Environment } from "../environment/environment.js";
import { wrapReminderAsUserContent } from "../model/prompt-builder.js";
import type { ActiveSkillRunSummary } from "../types/skill.js";
import { AgentRunState } from "./state.js";
import {
  TranscriptStore,
  type RunDebugArtifact,
} from "../transcript/store.js";
import type { ContextWindowPort } from "./context-window.js";

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

export interface PromptPort {
  buildMessages(task: string, history: HistoryItem[]): V4ChatMessage[];
}

export interface RunSessionPort {
  saveHistory(runId: string, history: readonly HistoryItem[]): void;
}

export type HistoryItem =
  | { type: "tool_call"; toolCall: InternalToolCall; thinking?: AgentThinking }
  | {
      type: "io_wait_call";
      toolCallId: string;
      wait: IoWaitRequest;
      thinking?: AgentThinking;
    }
  | {
      type: "observation";
      observation: ToolObservation;
      toolCallId?: string;
    }
  | { type: "environment_reminder"; content: string };

export interface RunPorts {
  model: ModelPort;
  validator: ValidatorPort;
  reviewer: ReviewerPort;
  terminal: TerminalPort;
  prompt: PromptPort;
  contextWindow: ContextWindowPort;
  session: RunSessionPort;
  tools: ToolDefinition[];
  environment: EnvironmentPort;
  listActiveSkillRuns: () => ActiveSkillRunSummary[];
}

export class RunOrchestrator {
  private state: AgentRunState;
  private readonly transcript: TranscriptStore;
  private readonly ports: RunPorts;
  private readonly history: HistoryItem[];

  constructor(
    initialState: AgentRunState,
    transcript: TranscriptStore,
    ports: RunPorts,
    initialHistory: HistoryItem[] = [],
  ) {
    this.state = initialState;
    this.transcript = transcript;
    this.ports = ports;
    this.history = [...initialHistory];
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
      this.saveHistory();
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
            this.history.push({
              type: "environment_reminder",
              content: envReminder,
            });
            this.saveHistory();
          }
        }

        await this.compactHistoryIfNeeded();

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
          this.history.push({
            type: "tool_call",
            toolCall,
            thinking: this.state.data.pendingModelOutput?.thinking,
          });
        }
        this.history.push({ type: "observation", observation });
        this.saveHistory();

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
        this.saveHistory();

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
        this.history.push({
          type: "io_wait_call",
          toolCallId: ioWaitToolCallId,
          wait: effect.wait,
          thinking: this.state.data.pendingModelOutput?.thinking,
        });
        this.saveHistory();

        const unsettledMessage = pendingImSendMessage(this.history);
        if (unsettledMessage !== undefined) {
          this.history.push({
            type: "observation",
            toolCallId: ioWaitToolCallId,
            observation: {
              kind: "io_wait",
              message: unsettledMessage,
              recoverable: true,
            },
          });
          this.saveHistory();
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

        this.history.push({
          type: "observation",
          toolCallId: ioWaitToolCallId,
          observation: {
            kind: "io_wait",
            message: "io_wait satisfied by external event.",
            recoverable: false,
            event,
          },
        });
        this.saveHistory();

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

  private async compactHistoryIfNeeded(): Promise<void> {
    const tokenCount = this.ports.contextWindow.countHistoryTokens(this.history);
    const maxTokens = this.ports.contextWindow.maxHistoryTokens;
    if (tokenCount < maxTokens) {
      return;
    }

    const compaction = this.ports.contextWindow.compactHistory({
      history: this.history,
      tokenCount,
      maxTokens,
      stepIndex: this.state.data.stepIndex,
    });
    if (compaction === undefined || compaction.droppedItemCount === 0) {
      return;
    }


    // Phase 2: Enrich summary via port-based LLM semantic summary
    if (this.ports.contextWindow.llmEnrichSummary) {
      try {
        const enriched = await this.ports.contextWindow.llmEnrichSummary(
          compaction.summary,
          this.history.slice(0, compaction.droppedItemCount),
        );
        if (enriched && !enriched.startsWith("[LLM")) {
          const firstItem = compaction.history[0];
          if (firstItem && firstItem.type === "environment_reminder") {
            firstItem.content += enriched;
            compaction.summary += enriched;
          }
        }
      } catch {
        /* LLM enrichment is best-effort */
      }
    }

    // Phase 3: Safe re-injection of project guidance files only
    try {
      const fs = await import("node:fs");
      const { join } = await import("node:path");
      for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
        const full = join(process.cwd(), rel);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            const c = fs.readFileSync(full, "utf-8").slice(0, 1000);
            compaction.history.push({
              type: "environment_reminder",
              content: `[Re-inject: ${rel}]\n${c}`,
            });
          }
        } catch { /* skip */ }
      }
    } catch { /* best-effort */ }

    this.history.splice(0, this.history.length, ...compaction.history);
    this.saveHistory();
    const { history: _history, ...eventCompaction } = compaction;
    await this.record({
      type: "history_compacted",
      stepIndex: this.state.data.stepIndex,
      compaction: eventCompaction,
      timestamp: this.now(),
    });
  }

  private saveHistory(): void {
    this.ports.session.saveHistory(this.state.data.runId, this.history);
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

function pendingImSendMessage(history: readonly HistoryItem[]): string | undefined {
  const latestObservationIndex = findLastHistoryIndex(
    history,
    (entry) => entry.type === "observation",
  );
  if (latestObservationIndex === -1) {
    return undefined;
  }

  const latestObservation = history[latestObservationIndex] as Extract<
    HistoryItem,
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

  const latestToolCall = history
    .slice(0, latestObservationIndex)
    .reverse()
    .find((entry): entry is Extract<HistoryItem, { type: "tool_call" }> =>
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

function findLastHistoryIndex(
  history: readonly HistoryItem[],
  predicate: (entry: HistoryItem) => boolean,
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (predicate(history[index]!)) {
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
