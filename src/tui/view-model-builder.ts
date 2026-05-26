// ─── View Model Builder ─────────────────────────────────────────────
//
// Maps a stream of RunEvent[] into TuiViewModel.
// Pure logic, no I/O. The builder is append-only: apply events in order,
// then call getViewModel() to snapshot the current state.

import type { RunEvent, AgentRunStateData } from "../types/run.js";
import type {
  UserMessage,
  AgentMessage,
  EnvironmentEvent,
} from "../types/environment.js";
import type {
  TuiViewModel,
  RunHeaderView,
  ConversationItem,
  LoopFrame,
  TuiLimits,
} from "./types.js";
import { DEFAULT_TUI_LIMITS } from "./types.js";

type ConversationProjectionItem = ConversationItem & {
  order: number;
};

export class ViewModelBuilder {
  private header: RunHeaderView = {
    runId: "",
    status: "created",
    stepIndex: 0,
    maxSteps: 0,
    cwd: "",
  };
  private conversation: ConversationProjectionItem[] = [];
  private loop: LoopFrame[] = [];
  private frameCounter = 0;
  private conversationCounter = 0;
  private seenConversationIds = new Set<string>();
  private readonly limits: TuiLimits;

  constructor(limits?: Partial<TuiLimits>) {
    this.limits = { ...DEFAULT_TUI_LIMITS, ...limits };
  }

  applyEvent(event: RunEvent): void {
    switch (event.type) {
      case "run_started":
        this.header = {
          ...this.header,
          runId: event.runId,
          status: "running",
          cwd: event.cwd,
          maxSteps: event.maxSteps,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        this.pushFrame({
          stepIndex: 0,
          timestamp: event.timestamp,
          phase: "environment",
          status: "ok",
          title: "run started",
          summary: `task: ${event.task}`,
        });
        break;

      case "model_requested":
        this.header.stepIndex = event.stepIndex;
        this.header.status = "waiting_for_model";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "model",
          status: "running",
          title: "model requested",
          summary: "",
        });
        break;

      case "model_output_received": {
        const turn = event.turn;
        switch (turn.kind) {
          case "tool_call": {
            const args = turn.toolCall.arguments;
            const session =
              "session" in args && typeof args.session === "string"
                ? args.session
                : "default";
            this.pushFrame({
              stepIndex: event.stepIndex,
              timestamp: event.timestamp,
              phase: "decision",
              status: "ok",
              title: "tool call: bash",
              summary: `session=${session}`,
            });
            break;
          }
          case "io_wait":
            this.pushFrame({
              stepIndex: event.stepIndex,
              timestamp: event.timestamp,
              phase: "io_wait",
              status: "waiting",
              title: "io wait requested",
              summary: turn.wait.reason ?? "",
            });
            break;
          case "invalid_output":
            this.pushFrame({
              stepIndex: event.stepIndex,
              timestamp: event.timestamp,
              phase: "decision",
              status: "warn",
              title: "invalid model output",
              summary: turn.message,
            });
            break;
        }
        // Add thinking detail if present
        if (event.output.thinking?.content) {
          const lastFrame = this.loop[this.loop.length - 1];
          if (lastFrame) {
            lastFrame.detail = `thinking (${event.output.thinking.content.length} chars)`;
          }
        }
        break;
      }

      case "tool_call_validated": {
        const isValid = event.result.status === "valid";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "validation",
          status: isValid ? "ok" : "warn",
          title: isValid ? "tool call validated" : "tool validation failed",
          summary: isValid
            ? ""
            : "observation" in event.result
              ? event.result.observation.message
              : "",
        });
        break;
      }

      case "tool_review_requested":
        this.header.status = "waiting_for_review";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "review",
          status: "running",
          title: "review requested",
          summary: "",
        });
        break;

      case "tool_reviewed":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "review",
          status: event.decision.status === "approved" ? "ok" : "warn",
          title: event.decision.status === "approved" ? "approved" : "rejected",
          summary: event.decision.reason ?? "",
        });
        break;

      case "tool_execution_started":
        this.header.status = "waiting_for_tool";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "tool",
          status: "running",
          title: "bash started",
          summary: "",
        });
        break;

      case "tool_execution_finished":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "tool",
          status: event.observation.returnCode === 0 ? "ok" : "error",
          title: `bash finished rc=${event.observation.returnCode}`,
          summary: event.observation.output?.slice(0, 200) ?? "",
          logPath: event.observation.outputLogPath,
        });
        break;

      case "observation_appended":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "observation",
          status: "ok",
          title: "observation appended",
          summary: "",
        });
        break;

      case "io_wait_started":
        this.header.status = "waiting_for_io";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "io_wait",
          status: "waiting",
          title: "waiting for IO",
          summary: event.wait.reason ?? "",
        });
        break;

      case "io_wait_satisfied":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "io_wait",
          status: "ok",
          title: "IO wait satisfied",
          summary: formatEnvironmentEventSummary(event.event),
          detail: JSON.stringify(event.event, null, 2),
        });
        break;

      case "environment_events_consumed":
        this.pushFrame({
          stepIndex: this.header.stepIndex,
          timestamp: event.timestamp,
          phase: "environment",
          status: "ok",
          title: `${event.eventIds.length} events consumed`,
          summary: event.eventIds.join(", "),
        });
        break;

      case "agent_message_sent":
        this.addConversationItem({
          id: agentConversationId(event.message),
          kind: "agent",
          timestamp: event.timestamp,
          text: event.message.text,
          messageKind: event.message.kind,
        });
        break;

      case "user_message_received":
        this.addConversationItem({
          id: userConversationId(event.message),
          kind: "user",
          timestamp: event.timestamp,
          channel: event.message.channel,
          text: event.message.text,
          sourceEventId: event.message.id,
        });
        break;

      case "run_finished":
        this.header.status = event.status;
        this.header.updatedAt = event.timestamp;
        this.pushFrame({
          stepIndex: this.header.stepIndex,
          timestamp: event.timestamp,
          phase: "environment",
          status: event.status === "cancelled" ? "ok" : "error",
          title: "run finished",
          summary: event.status,
        });
        break;

      case "environment_event_recorded":
        // Low-level event, no LoopFrame needed
        break;
    }
  }

  addImUserMessage(msg: UserMessage): void {
    this.addConversationItem({
      id: userConversationId(msg),
      kind: "user",
      timestamp: msg.createdAt,
      channel: msg.channel,
      text: msg.text,
      sourceEventId: msg.id,
    });
  }

  addImAgentMessage(msg: AgentMessage): void {
    this.addConversationItem({
      id: agentConversationId(msg),
      kind: "agent",
      timestamp: msg.createdAt,
      text: msg.text,
      messageKind: msg.kind,
    });
  }

  applyState(state: AgentRunStateData): void {
    this.header = {
      ...this.header,
      runId: state.runId,
      status: state.status,
      stepIndex: state.stepIndex,
      maxSteps: state.maxSteps,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      startedAt: state.createdAt,
    };
  }

  getViewModel(): TuiViewModel {
    const sortedConversation = [...this.conversation].sort(compareConversationItems);
    const conversation =
      sortedConversation.length > this.limits.maxConversationItems
        ? sortedConversation.slice(-this.limits.maxConversationItems)
        : sortedConversation;
    const loop =
      this.loop.length > this.limits.maxLoopFrames
        ? this.loop.slice(-this.limits.maxLoopFrames)
        : [...this.loop];
    return {
      run: { ...this.header },
      conversation: conversation.map(({ order: _order, ...item }) => item),
      loop,
      sessions: [],
      activeSkills: [],
    };
  }

  private pushFrame(frame: Omit<LoopFrame, "id">): void {
    this.frameCounter++;
    this.loop.push({ ...frame, id: `frame-${this.frameCounter}` });
  }

  private addConversationItem(item: ConversationItem): void {
    if (this.seenConversationIds.has(item.id)) return;
    this.seenConversationIds.add(item.id);
    this.conversationCounter++;
    this.conversation.push({ ...item, order: this.conversationCounter });
  }
}

function userConversationId(message: UserMessage): string {
  return `user:${message.id}`;
}

function agentConversationId(message: AgentMessage): string {
  return `agent:${message.createdAt}:${message.kind}:${message.text}`;
}

function compareConversationItems(
  left: ConversationProjectionItem,
  right: ConversationProjectionItem,
): number {
  const timeDiff = timestampMs(left.timestamp) - timestampMs(right.timestamp);
  if (timeDiff !== 0) return timeDiff;
  return left.order - right.order;
}

function timestampMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function formatEnvironmentEventSummary(event: EnvironmentEvent): string {
  switch (event.kind) {
    case "user_message_received":
      return `event=${event.id} [user@${event.message.channel}] ${truncateForSummary(event.message.text)}`;
    case "session_state_changed":
      return `event=${event.id} session=${event.session} ${event.previousState}->${event.nextState}`;
    case "command_finished":
      return `event=${event.id} command_finished session=${event.session} rc=${event.returnCode}`;
    case "command_timed_out":
      return `event=${event.id} command_timed_out session=${event.session}`;
    case "skill_run_started":
    case "skill_run_closed":
    case "skill_review_pending":
    case "skill_review_completed":
      return `event=${event.id} ${event.kind} skill=${event.skill}`;
  }
}

function truncateForSummary(text: string, maxLength = 80): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
