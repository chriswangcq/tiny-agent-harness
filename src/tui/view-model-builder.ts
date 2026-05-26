// ─── View Model Builder ─────────────────────────────────────────────
//
// Maps a stream of RunEvent[] into TuiViewModel.
// Pure logic, no I/O. The builder is append-only: apply events in order,
// then call getViewModel() to snapshot the current state.

import type { RunEvent, AgentRunStateData } from "../types/run.js";
import type { ModelTurn } from "../types/model.js";
import type { BashObservation } from "../types/bash.js";
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
        this.completeModelFrame(event);
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
              summary: formatToolCallSummary(turn.toolCall),
              detail: formatDetail([
                ["thinking", turn.thinking.content],
                ["tool call", turn.toolCall],
                ["raw decision", turn.rawDecision],
                ["raw", turn.raw],
              ]),
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
              detail: formatDetail([
                ["thinking", turn.thinking.content],
                ["wait", turn.wait],
                ["raw decision", turn.rawDecision],
                ["raw", turn.raw],
              ]),
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
              detail: formatDetail([
                ["message", turn.message],
                ["thinking", compactLongText(turn.thinking?.content)],
                ["raw decision", compactLongText(turn.rawDecision)],
                ["raw", turn.raw],
              ]),
            });
            break;
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
          detail: formatDetail([
            ["tool call", event.toolCall],
            ["validation result", event.result],
          ]),
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
          detail: formatDetail([["request", event.request]]),
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
          detail: formatDetail([
            ["request", event.request],
            ["decision", event.decision],
          ]),
        });
        break;

      case "tool_execution_started":
        this.header.status = "waiting_for_tool";
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "tool",
          status: "running",
          title: `${event.request.toolName} started`,
          summary: "",
          detail: formatDetail([["request", event.request]]),
        });
        break;

      case "tool_execution_finished":
        {
          const observation = event.observation;
          let status: LoopFrame["status"];
          let title: string;
          let summary: string;
          let logPath: string | undefined;

          if (isBashObservation(observation)) {
            const timedOut = observation.timedOut === true;
            status = timedOut
              ? "waiting"
              : observation.returnCode === 0
                ? "ok"
                : "error";
            title = observation.errorCode
              ? `bash rejected ${observation.errorCode}`
              : timedOut
              ? "bash timed out, focus released"
              : `bash finished rc=${observation.returnCode}`;
            summary = observation.message
              ? observation.message
              : timedOut
              ? `session=${observation.session ?? "unknown"} still running`
              : observation.output?.slice(0, 200) ?? "";
            logPath = observation.outputLogPath;
          } else {
            status = "ok";
            title = `${event.request.toolName} finished`;
            summary = observation.message;
          }

          this.pushFrame({
            stepIndex: event.stepIndex,
            timestamp: event.timestamp,
            phase: "tool",
            status,
            title,
            summary,
            logPath,
            detail: formatDetail([
              ["request", event.request],
              ["observation", observation],
            ]),
          });
        }
        break;

      case "observation_appended":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "observation",
          status: "ok",
          title: "observation appended",
          summary: "",
          detail: formatDetail([["observation", event.observation]]),
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
          detail: formatDetail([["wait", event.wait]]),
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
          detail: formatDetail([["event ids", event.eventIds]]),
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

  private completeModelFrame(
    event: Extract<RunEvent, { type: "model_output_received" }>,
  ): void {
    const frame = this.findLatestModelFrame(event.stepIndex);
    if (!frame) return;

    frame.status = event.turn.kind === "invalid_output" ? "warn" : "ok";
    frame.title =
      event.turn.kind === "invalid_output"
        ? "model completed with invalid output"
        : "model completed";
    frame.summary = formatModelOutputSummary(event.turn);
    if (event.turn.kind === "invalid_output") {
      frame.detail = formatDetail([
        ["message", event.turn.message],
        ["thinking", compactLongText(event.output.thinking.content)],
        ["raw decision", compactLongText(event.output.rawDecision)],
        [
          "turn",
          {
            kind: event.turn.kind,
            message: event.turn.message,
          },
        ],
        ["usage", event.output.usage],
      ]);
      return;
    }

    frame.detail = formatDetail([
      ["thinking", event.output.thinking.content],
      ["thinking raw", event.output.thinking.raw],
      ["raw decision", event.output.rawDecision],
      ["turn", event.turn],
      ["usage", event.output.usage],
    ]);
  }

  private findLatestModelFrame(stepIndex: number): LoopFrame | undefined {
    for (let index = this.loop.length - 1; index >= 0; index--) {
      const frame = this.loop[index]!;
      if (frame.stepIndex === stepIndex && frame.phase === "model") {
        return frame;
      }
    }
    return undefined;
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

function formatToolCallSummary(toolCall: { name?: string; arguments: unknown }): string {
  const args = toolCall.arguments;
  if (isRecord(args)) {
    if (toolCall.name === "stash_file") {
      const name = typeof args.name === "string" ? args.name : "artifact";
      const content =
        typeof args.content === "string"
          ? `${Buffer.byteLength(args.content, "utf8")} chars`
          : "content";
      return `name=${JSON.stringify(name)} ${content}`;
    }
    const session = typeof args.session === "string" ? args.session : "default";
    const command = typeof args.command === "string" ? args.command : undefined;
    if (command) {
      return `session=${session} command=${JSON.stringify(truncateForSummary(command, 80))}`;
    }
    const control = typeof args.control === "string" ? args.control : undefined;
    if (control) {
      return `control=${control}${typeof args.session === "string" ? ` session=${args.session}` : ""}`;
    }
    return `session=${session}`;
  }
  return "";
}

function formatModelOutputSummary(turn: ModelTurn): string {
  switch (turn.kind) {
    case "tool_call":
      return `decision=tool_call ${formatToolCallSummary(turn.toolCall)}`;
    case "io_wait":
      return `decision=io_wait ${turn.wait.reason ?? ""}`.trim();
    case "invalid_output":
      return `decision=invalid_output ${turn.message}`.trim();
  }
}

function formatDetail(
  sections: Array<[title: string, value: unknown]>,
): string {
  const lines: string[] = [];
  for (const [title, value] of sections) {
    if (value === undefined || value === null || value === "") continue;
    if (lines.length > 0) lines.push("");
    lines.push(`## ${title}`);
    lines.push(formatDetailValue(value));
  }
  return lines.join("\n");
}

function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function compactLongText(value: string | undefined, maxLength = 2400): string | undefined {
  if (value === undefined || value.length <= maxLength) return value;
  const headLength = Math.floor(maxLength * 0.65);
  const tailLength = maxLength - headLength;
  const omitted = value.length - headLength - tailLength;
  return [
    value.slice(0, headLength),
    "",
    `... <truncated ${omitted} chars> ...`,
    "",
    value.slice(-tailLength),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBashObservation(value: unknown): value is BashObservation {
  return isRecord(value) && "returnCode" in value && "output" in value;
}
