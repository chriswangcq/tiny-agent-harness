import type { RunEvent } from "../types/run.js";
import type { FimStepOutput, ModelStepContext, ModelPromptMessage } from "../types/model.js";
import type { ToolDefinition, ToolRequest, ToolReviewDecision, ToolCallValidation, AgentObservation } from "../types/tools.js";
import type { BashObservation } from "../types/bash.js";
import type { InternalToolCall } from "../types/model.js";
import type { EnvironmentPort, EnvironmentEvent, IoWaitRequest } from "../types/environment.js";
import { Environment } from "../environment/environment.js";
import type { ActiveSkillRunSummary } from "../types/skill.js";
import { AgentRunState } from "./state.js";
import { TranscriptStore } from "../transcript/store.js";

export interface ModelPort {
  generateTurn(context: ModelStepContext, options: { bashTool: ToolDefinition }): Promise<FimStepOutput>;
}

export interface ValidatorPort {
  validate(toolCall: InternalToolCall): ToolCallValidation;
}

export interface ReviewerPort {
  review(request: ToolRequest): Promise<ToolReviewDecision>;
}

export interface BashPort {
  execute(request: ToolRequest): Promise<BashObservation>;
}

export interface PromptPort {
  buildMessages(task: string, history: HistoryItem[]): ModelPromptMessage[];
}

export type HistoryItem =
  | { type: "tool_call"; toolCall: InternalToolCall }
  | { type: "observation"; observation: BashObservation | AgentObservation }
  | { type: "user_message"; text: string; channel: string; timestamp: string };

export interface RunPorts {
  model: ModelPort;
  validator: ValidatorPort;
  reviewer: ReviewerPort;
  bash: BashPort;
  prompt: PromptPort;
  bashTool: ToolDefinition;
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

          for (const evt of envEvents) {
            if (evt.kind === "user_message_received") {
              this.history.push({
                type: "user_message",
                text: evt.message.text,
                channel: evt.message.channel,
                timestamp: evt.timestamp,
              });
            }
          }
        }

        const messages = this.ports.prompt.buildMessages(
          this.state.data.task,
          this.history,
        );

        // Render consumed environment events as system reminder
        if (envEvents.length > 0) {
          const envReminder = Environment.renderReminder(envEvents);
          if (envReminder) {
            messages.push({ role: "system", content: envReminder });
          }
        }

        // Render active skill runs as persistent reminder
        const activeSkillRuns = this.ports.listActiveSkillRuns();
        if (activeSkillRuns.length > 0) {
          const reminder = renderActiveSkillReminder(activeSkillRuns);
          messages.push({ role: "system", content: reminder });
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

        const output = await this.ports.model.generateTurn(context, {
          bashTool: this.ports.bashTool,
        });

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
        const result = this.ports.validator.validate(effect.toolCall);

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

        const decision = await this.ports.reviewer.review(effect.request);

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

        const observation = await this.ports.bash.execute(effect.request);
        const toolCall =
          this.state.data.pendingToolCall ??
          (this.state.data.pendingModelTurn?.kind === "tool_call"
            ? this.state.data.pendingModelTurn.toolCall
            : undefined);

        if (toolCall) {
          this.history.push({ type: "tool_call", toolCall });
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
        await this.record({
          type: "io_wait_started",
          stepIndex: this.state.data.stepIndex,
          wait: effect.wait,
          timestamp: this.now(),
        });

        const event = await this.ports.environment.waitFor({
          runId: this.state.data.runId,
          wait: effect.wait,
        });

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
          this.state.status === "completed"
            ? "completed" as const
            : this.state.status === "cancelled"
              ? "cancelled" as const
              : "failed" as const;

        const event: RunEvent = {
          type: "run_finished",
          status: finalStatus,
          final: this.state.data.final,
          error: this.state.data.error,
          timestamp: this.now(),
        };

        if (
          this.state.status === "completed" ||
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
