// ─── View Model Builder ─────────────────────────────────────────────
//
// Maps a stream of RunEvent[] into TuiViewModel.
// Pure logic, no I/O. The builder is append-only: apply events in order,
// then call getViewModel() to snapshot the current state.

import type { RunEvent, AgentRunStateData } from "../types/run.js";
import type { ModelTurn } from "../types/model.js";
import type { PtyObservation } from "../terminal/types.js";
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
  private thinkingStreams = new Map<number, string>();
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
        this.thinkingStreams.set(event.stepIndex, "");
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "model",
          status: "running",
          title: "model requested",
          summary: "",
        });
        break;

      case "model_thinking_delta": {
        this.header.stepIndex = event.stepIndex;
        this.header.status = "waiting_for_model";
        const content =
          (this.thinkingStreams.get(event.stepIndex) ?? "") + event.delta;
        this.thinkingStreams.set(event.stepIndex, content);

        let frame = this.findLatestModelFrame(event.stepIndex);
        if (!frame) {
          this.pushFrame({
            stepIndex: event.stepIndex,
            timestamp: event.timestamp,
            phase: "model",
            status: "running",
            title: "model thinking",
            summary: "",
          });
          frame = this.findLatestModelFrame(event.stepIndex);
        }
        if (frame) {
          frame.status = "running";
          frame.title = "model thinking";
          frame.timestamp = event.timestamp;
          frame.summary = `thinking... ${content.length} chars`;
          frame.detail = formatDetail([["thinking", compactLongText(content)]]);
        }
        break;
      }

      case "model_output_received": {
        const turn = event.turn;
        this.completeModelFrame(event);
        switch (turn.kind) {
          case "tool_call": {
            this.pushFrame({
              stepIndex: event.stepIndex,
              timestamp: event.timestamp,
              phase: "decision",
              status: "ok",
              title: `tool call: ${turn.toolCall.name}`,
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

          if (isPtyObservation(observation)) {
            status =
              observation.result === "ok"
                ? "ok"
                : observation.result === "rejected"
                  ? "warn"
                  : observation.result === "timeout"
                    ? "waiting"
                    : "warn";
            title = observation.errorCode
              ? `pty rejected ${observation.errorCode}`
              : `pty ${observation.result} ${observation.action.kind}`;
            summary = formatPtyObservationSummary(observation);
            logPath = observation.logRef;
          } else {
            const observationRecord: Record<string, unknown> = isRecord(observation)
              ? observation
              : {};
            const result =
              typeof observationRecord.result === "string"
                ? observationRecord.result
                : "ok";
            status = result === "rejected" ? "warn" : "ok";
            title = `${event.request.toolName} finished`;
            summary =
              observation.message ??
              (typeof observationRecord.result === "string"
                ? `result=${observationRecord.result}`
                : "");
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
    this.thinkingStreams.delete(event.stepIndex);
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
  if (message.id) {
    return `agent:${message.id}`;
  }
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
      const parts = ["tool=stash_file"];
      if (typeof args.name === "string") {
        parts.push(`name=${args.name}`);
      }
      if (typeof args.content === "string") {
        parts.push(`bytes=${Buffer.byteLength(args.content, "utf8")}`);
      }
      return parts.join(" ");
    }
    const actionKind = typeof args.kind === "string" ? args.kind : undefined;
    if (actionKind) {
      const session = typeof args.session === "string" ? args.session : "default";
      const parts = [`action=${actionKind}`, `session=${session}`];
      if (typeof args.expectedInputSeq === "number") {
        parts.push(`inputSeq=${args.expectedInputSeq}`);
      }
      if (typeof args.seq === "number") {
        parts.push(`seq=${args.seq}`);
      }
      return parts.join(" ");
    }
    return "";
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
  return JSON.stringify(redactLargePayloads(value), null, 2);
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

function isPtyObservation(value: unknown): value is PtyObservation {
  return (
    isRecord(value) &&
    "terminal" in value &&
    "action" in value &&
    "result" in value &&
    "events" in value
  );
}

function formatPtyObservationSummary(observation: PtyObservation): string {
  const parts = [
    `action=${observation.action.kind}`,
    `inputSeq=${observation.terminal.inputSeq}`,
    `alive=${observation.terminal.alive}`,
  ];
  if (observation.terminal.syncStatus.kind === "unsynced") {
    parts.push(`sync=unsynced:${observation.terminal.syncStatus.reason}`);
  }
  if (observation.eventsOmitted !== undefined) {
    parts.push(`eventsOmitted=${observation.eventsOmitted}`);
  }
  if (observation.action.bytes !== undefined) {
    parts.push(`bytes=${observation.action.bytes}`);
  }
  if (observation.action.redacted) {
    parts.push("redacted=true");
  }
  if (observation.message) {
    parts.push(observation.message);
  }
  return parts.join(" ");
}

function redactLargePayloads(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactLargePayloads(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "text" &&
      typeof child === "string" &&
      value.kind === "write_text" &&
      shouldRedactWriteTextDetail(child)
    ) {
      next[key] = `[redacted write_text payload ${Buffer.byteLength(child, "utf8")} bytes]`;
    } else if (
      key === "content" &&
      typeof child === "string" &&
      shouldRedactWriteTextDetail(child)
    ) {
      next[key] = `[redacted stash_file content ${Buffer.byteLength(child, "utf8")} bytes]`;
    } else if (
      key === "preview" &&
      typeof child === "string" &&
      value.kind === "write_text" &&
      value.redacted === true
    ) {
      next[key] = "[redacted write_text preview]";
    } else {
      next[key] = redactLargePayloads(child);
    }
  }
  return next;
}

function shouldRedactWriteTextDetail(text: string): boolean {
  if (text.length > 512) {
    return true;
  }

  const line = text.trim();
  return line.length >= 128 && line.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(line);
}
