import type {
  AgentRunStateData,
  RuntimeStuckReason,

  AgentRunStatus,
  NextEffect,
  RunEvent,
} from "../types/run.js";
import { markRuntimeStuckReported } from "./progress.js";
import type { AgentObservation } from "../types/tools.js";

const TERMINAL_STATUSES: Set<AgentRunStatus> = new Set([
  "failed",
  "cancelled",
]);

export class AgentRunState {
  readonly data: Readonly<AgentRunStateData>;

  constructor(data: AgentRunStateData) {
    this.data = Object.freeze({ ...data });
  }

  static create(params: {
    runId: string;
    task: string;
    cwd: string;
    transcriptPath: string;
    now?: string;
  }): AgentRunState {
    const now = params.now ?? new Date().toISOString();
    return new AgentRunState({
      runId: params.runId,
      status: "created",
      task: params.task,
      cwd: params.cwd,
      createdAt: now,
      updatedAt: now,
      stepIndex: 0,
      transcriptPath: params.transcriptPath,
    });
  }

  get status(): AgentRunStatus {
    return this.data.status;
  }

  nextEffect(): NextEffect {
    const { status } = this.data;

    if (status === "failed") {
      return { type: "stop", reason: "failed" };
    }
    if (status === "cancelled") {
      return { type: "stop", reason: "cancelled" };
    }

    if (status === "created") {
      return { type: "stop", reason: "failed" };
    }

    // running — check pending work in priority order
    if (status === "running") {
      // 1. Pending synthetic observation to append
      if (this.data.pendingModelTurn?.kind === "invalid_output" && !this.data.pendingToolCall && !this.data.pendingToolRequest) {
        const obs: AgentObservation = {
          kind: "model_output",
          message: this.data.pendingModelTurn.message,
          recoverable: true,
        };
        return { type: "append_observation", observation: obs };
      }

      // 2. Pending tool call needing validation
      if (this.data.pendingToolCall && !this.data.pendingToolRequest) {
        return { type: "validate_tool_call", toolCall: this.data.pendingToolCall };
      }

      // 3. Pending valid tool request needing review (no review yet)
      if (this.data.pendingToolRequest && !this.data.pendingReview) {
        return { type: "review_tool", request: this.data.pendingToolRequest };
      }

      // 4. Pending approved tool request needing execution
      if (this.data.pendingToolRequest && this.data.pendingReview?.status === "approved") {
        return {
          type: "execute_tool",
          request: this.data.pendingToolRequest,
          review: this.data.pendingReview,
        };
      }

      // 5. Pending rejected review -> synthetic observation
      if (this.data.pendingToolRequest && this.data.pendingReview?.status === "rejected") {
        const obs: AgentObservation = {
          kind: "tool_review",
          message: "Tool request was rejected by reviewer.",
          recoverable: true,
          decision: {
            status: "rejected",
            reason: this.data.pendingReview.reason,
          },
        };
        return { type: "append_observation", observation: obs };
      }

      // 6. Pending IO wait
      if (this.data.pendingIoWait) {
        return { type: "wait_io", wait: this.data.pendingIoWait };
      }

      // 7. No pending work — call model. Runs are externally controlled by
      // io_wait, cancellation, and process lifetime rather than a step budget.
      return {
        type: "call_model",
        context: {
          runId: this.data.runId,
          stepIndex: this.data.stepIndex,
          messages: [],
        },
      };
    }

    // waiting states should not call nextEffect — orchestrator should
    // only call nextEffect when in "running" or terminal states
    if (status === "waiting_for_model" || status === "waiting_for_review" || status === "waiting_for_tool" || status === "waiting_for_io") {
      return { type: "stop", reason: "failed" };
    }

    return { type: "stop", reason: "failed" };
  }

  apply(event: RunEvent): AgentRunState {
    const now = event.timestamp;
    const s = this.data;

    switch (event.type) {
      case "run_started": {
        this.assertStatus("created", event.type);
        return this.next({
          status: "running",
          updatedAt: now,
        });
      }

      case "run_resumed": {
        if (s.status === "waiting_for_tool") {
          return this.next({
            status: "running",
            pendingModelOutput: undefined,
            pendingModelTurn: {
              kind: "invalid_output",
              message:
                "Run resumed while a tool execution was in flight. The previous process/PTY was not resumed, so the harness did not replay the tool automatically. Inspect the filesystem, transcript, and terminal state before deliberately retrying any side-effecting action.",
            },
            pendingToolCall: undefined,
            pendingToolRequest: undefined,
            pendingReview: undefined,
            updatedAt: now,
          });
        }
        return this.next({
          status: "running",
          error: undefined,
          updatedAt: now,
        });
      }

      case "model_requested": {
        this.assertStatus("running", event.type);
        return this.next({
          status: "waiting_for_model",
          updatedAt: now,
        });
      }

      case "model_output_received": {
        this.assertStatus("waiting_for_model", event.type);
        const turn = event.turn;

        if (turn.kind === "tool_call") {
          return this.next({
            status: "running",
            pendingModelOutput: event.output,
            pendingModelTurn: turn,
            pendingToolCall: turn.toolCall,
            pendingToolRequest: undefined,
            pendingReview: undefined,
            pendingIoWait: undefined,
            updatedAt: now,
          });
        }

        if (turn.kind === "io_wait") {
          return this.next({
            status: "running",
            pendingModelOutput: event.output,
            pendingModelTurn: turn,
            pendingIoWait: turn.wait,
            pendingToolCall: undefined,
            pendingToolRequest: undefined,
            pendingReview: undefined,
            updatedAt: now,
          });
        }

        // invalid_output
        return this.next({
          status: "running",
          pendingModelOutput: event.output,
          pendingModelTurn: turn,
          pendingToolCall: undefined,
          pendingToolRequest: undefined,
          pendingReview: undefined,
          pendingIoWait: undefined,
          updatedAt: now,
        });
      }

      case "model_thinking_delta":
        return this.next({ updatedAt: now });

      case "model_decision_recorded":
        return this.next({ updatedAt: now });

      case "tool_call_validated": {
        this.assertStatus("running", event.type);
        if (!s.pendingToolCall) {
          throw new Error(`Invalid transition: ${event.type} with no pending tool call`);
        }

        if (event.result.status === "valid") {
          return this.next({
            pendingToolCall: undefined,
            pendingToolRequest: event.result.request,
            updatedAt: now,
          });
        }

        // invalid — queue synthetic observation
        return this.next({
          pendingToolCall: undefined,
          pendingModelTurn: {
            kind: "invalid_output",
            message: event.result.observation.message,
          },
          updatedAt: now,
        });
      }

      case "tool_review_requested": {
        this.assertStatus("running", event.type);
        return this.next({
          status: "waiting_for_review",
          updatedAt: now,
        });
      }

      case "tool_reviewed": {
        this.assertStatus("waiting_for_review", event.type);
        if (event.decision.status === "approved") {
          return this.next({
            status: "running",
            pendingReview: event.decision,
            updatedAt: now,
          });
        }

        // rejected
        return this.next({
          status: "running",
          pendingReview: event.decision,
          updatedAt: now,
        });
      }

      case "tool_execution_started": {
        this.assertStatus("running", event.type);
        if (!s.pendingToolRequest || !s.pendingReview || s.pendingReview.status !== "approved") {
          throw new Error(`Invalid transition: ${event.type} requires approved pending request`);
        }
        return this.next({
          status: "waiting_for_tool",
          updatedAt: now,
        });
      }

      case "tool_execution_finished": {
        this.assertStatus("waiting_for_tool", event.type);
        return this.next({
          status: "running",
          stepIndex: s.stepIndex + 1,
          pendingModelOutput: undefined,
          pendingModelTurn: undefined,
          pendingToolCall: undefined,
          pendingToolRequest: undefined,
          pendingReview: undefined,
          pendingIoWait: undefined,
          updatedAt: now,
        });
      }

      case "observation_appended": {
        this.assertStatus("running", event.type);
        return this.next({
          status: "running",
          stepIndex: s.stepIndex + 1,
          pendingModelOutput: undefined,
          pendingModelTurn: undefined,
          pendingToolCall: undefined,
          pendingToolRequest: undefined,
          pendingReview: undefined,
          pendingIoWait: undefined,
          updatedAt: now,
        });
      }
      case "runtime_stuck_detected": {
        return this.next({
          runtimeProgress: markRuntimeStuckReported(
            s.runtimeProgress,
            event.reason,
          ),
          updatedAt: now,
        });
      }


      case "run_finished": {
        if (TERMINAL_STATUSES.has(s.status)) {
          throw new Error(`Invalid transition: ${event.type} from terminal status ${s.status}`);
        }
        const nextStatus = event.status;
        return this.next({
          status: nextStatus,
          error: event.error,
          updatedAt: now,
        });
      }

      case "user_message_received":
      case "agent_message_sent":
        return this.next({ updatedAt: now });

      case "io_wait_started": {
        this.assertStatus("running", event.type);
        return this.next({
          status: "waiting_for_io",
          updatedAt: now,
        });
      }

      case "io_wait_satisfied": {
        this.assertStatus("waiting_for_io", event.type);
        return this.next({
          status: "running",
          stepIndex: s.stepIndex + 1,
          pendingModelOutput: undefined,
          pendingModelTurn: undefined,
          pendingToolCall: undefined,
          pendingToolRequest: undefined,
          pendingReview: undefined,
          pendingIoWait: undefined,
          updatedAt: now,
        });
      }

      case "environment_event_recorded":
        return this.next({ updatedAt: now });

      case "environment_events_consumed":
        return this.next({ updatedAt: now });

      case "history_compacted":
        return this.next({ updatedAt: now });

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${(_exhaustive as RunEvent).type}`);
      }
    }
  }

  withRuntimeProgress(patch: Pick<AgentRunStateData, "runtimeProgress">): AgentRunState {
    return this.next(patch);
  }

  private assertStatus(expected: AgentRunStatus, eventType: string): void {
    if (this.data.status !== expected) {
      throw new Error(
        `Invalid transition: ${eventType} requires status '${expected}', got '${this.data.status}'`
      );
    }
  }

  private next(patch: Partial<AgentRunStateData>): AgentRunState {
    return new AgentRunState({ ...this.data, ...patch });
  }
}
