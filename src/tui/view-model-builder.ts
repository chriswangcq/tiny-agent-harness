// ─── View Model Builder ─────────────────────────────────────────────
//
// Maps a stream of RunEvent[] into TuiViewModel.
// Pure logic, no I/O. The builder is append-only: apply events in order,
// then call getViewModel() to snapshot the current state.

import type {
  RunEvent,
  AgentRunStateData,
  ModelDecisionTrace,
} from "../types/run.js";
import type { ModelTurn } from "../types/model.js";
import type {
  SessionListObservation,
  TerminalObservation,
  TerminalSessionSnapshot,
} from "../terminal/types.js";
import type {
  UserMessage,
  AgentMessage,
  EnvironmentEvent,
  IoWaitRequest,
} from "../types/environment.js";
import {
  environmentEventLevel,
  ioWaitMinLevel,
} from "../types/environment.js";
import type {
  TuiViewModel,
  RunHeaderView,
  ConversationItem,
  LoopFrame,
  SessionView,
  SessionTailUpdate,
  TuiLimits,
} from "./types.js";
import { DEFAULT_TUI_LIMITS } from "./types.js";
import { redactTerminalWriteDisplayText } from "./redaction.js";

type ConversationProjectionItem = ConversationItem & {
  order: number;
};

export class ViewModelBuilder {
  private sessions = new Map<string, SessionView>();

  private header: RunHeaderView = {
    runId: "",
    status: "created",
    stepIndex: 0,
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

      case "run_resumed":
        this.header = {
          ...this.header,
          runId: event.runId,
          status: "running",
          updatedAt: event.timestamp,
        };
        this.pushFrame({
          stepIndex: this.header.stepIndex,
          timestamp: event.timestamp,
          phase: "environment",
          status: "ok",
          title: "run resumed",
          summary: `previousStatus=${event.previousStatus}`,
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
                ["diagnostic", turn.diagnostic],
                ["thinking", compactLongText(turn.thinking?.content)],
                ["raw decision", compactLongText(turn.rawDecision)],
                ["raw", turn.raw],
              ]),
            });
            break;
        }
        break;
      }

      case "model_decision_recorded":
        this.upsertDecisionTraceFrame(event);
        break;

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
          summary: `tool=${event.request.toolName}`,
          detail: formatDetail([["request", event.request]]),
        });
        break;

      case "tool_reviewed": {
          const decision = event.decision;
          const warnings = decision.warnings ?? [];
          const findings = decision.findings ?? [];
          const summaryParts: string[] = [];

          // Truncate long reason messages in display summary
          const MAX_REASON_DISPLAY = 120;
          const reasonText = decision.reason ?? "";
          const displayReason =
            reasonText.length > MAX_REASON_DISPLAY
              ? reasonText.slice(0, MAX_REASON_DISPLAY) + "..."
              : reasonText;
          if (displayReason) {
            summaryParts.push(displayReason);
          }
          if (warnings.length > 0) {
            summaryParts.push(`warnings=${warnings.length}`);
          }
          if (findings.length > 0) {
            const counts = findings.reduce(
              (acc, f) => {
                acc[f.severity] = (acc[f.severity] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            );
            const countText = Object.entries(counts)
              .sort(([a], [b]) => {
                const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
                return (order[a] ?? 9) - (order[b] ?? 9);
              })
              .map(([sev, count]) => `${sev}=${count}`)
              .join(" ");
            summaryParts.push(`findings[${countText}]`);
          }

          this.pushFrame({
            stepIndex: event.stepIndex,
            timestamp: event.timestamp,
            phase: "review",
            status: decision.status === "approved" ? "ok" : "warn",
            title: decision.status === "approved" ? "approved" : "rejected",
            summary: summaryParts.filter(Boolean).join(" "),
            reviewDecision: decision,
            detail: formatDetail([
              ["request", event.request],
              ["decision", decision],
              ...(findings.length > 0
                ? [["risk findings", findings]] as Array<[string, unknown]>
                : []),
            ]),
          });
          break;
        }

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

          if (isTerminalObservation(observation)) {
            status = terminalResultStatus(observation.result);
            title = observation.errorCode
              ? `${observation.request} rejected ${observation.errorCode}`
              : `${observation.request} ${observation.result}`;
            summary = formatTerminalObservationSummary(observation);
            logPath = observation.screen.logRef.path;

            this.sessions.set(observation.observedSession, {
              session: observation.observedSession,
              state: terminalSessionState(observation.terminal),
              currentCommand: observation.terminal.foregroundProcess ?? undefined,
              returnCode:
                observation.terminal.lastShellPrompt?.lastReturnCode ?? null,
              logPath: observation.screen.logRef.path,
              tail: observation.screen.text || observation.message || "",
              screenRows: observation.screen.rows,
              screenCols: observation.screen.cols,
              updatedAt: event.timestamp,
            });
          } else if (isSessionListObservation(observation)) {
            status = "ok";
            title = `${event.request.toolName} finished`;
            summary = `currentSession=${observation.currentSession} sessions=${observation.sessions.length}`;
            for (const session of observation.sessions) {
              this.sessions.set(session.session, sessionSnapshotToView(session, event.timestamp));
            }
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
              (typeof observationRecord.message === "string"
                ? observationRecord.message
                : undefined) ??
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
          detail: formatDetail([
            ["wake reason", formatIoWaitWakeReason(event.wait, event.event)],
            ["wait", event.wait],
            ["event", event.event],
          ]),
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

      case "history_compacted":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "environment",
          status: "ok",
          title: "history compacted",
          summary:
            `tokens=${event.compaction.tokenCount}/${event.compaction.maxTokens} ` +
            `dropped=${event.compaction.droppedItemCount} retained=${event.compaction.retainedItemCount}`,
          detail: event.compaction.summary,
        });
        break;
      case "runtime_stuck_detected":
        this.pushFrame({
          stepIndex: event.stepIndex,
          timestamp: event.timestamp,
          phase: "environment",
          status: event.severity === "blocked" ? "error" : "warn",
          title: `runtime stuck: ${event.reason.pattern}`,
          summary: event.reason.message,
          detail: formatDetail([
            ["severity", event.severity],
            ["pattern", event.reason.pattern],
            ["threshold", event.reason.threshold],
            ["signature", event.reason.signature],
            ["consecutiveCount", event.reason.consecutiveCount],
            ["sinceStepIndex", event.reason.sinceStepIndex],
            ["lastStepIndex", event.reason.lastStepIndex],
          ]),
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
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      startedAt: state.createdAt,
    };
  }

  applySessionLogTails(updates: readonly SessionTailUpdate[]): void {
    for (const update of updates) {
      const existing = this.sessions.get(update.session);
      this.sessions.set(update.session, {
        session: update.session,
        state: existing?.state ?? "idle",
        currentCommand: existing?.currentCommand,
        returnCode: existing?.returnCode,
        logPath: update.logPath,
        tail: update.tail,
        tailOffset: update.tailOffset,
        screenRows: update.screenRows ?? existing?.screenRows,
        screenCols: update.screenCols ?? existing?.screenCols,
        updatedAt: update.updatedAt,
      });
    }
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
      sessions: [...this.sessions.values()].sort((a, b) => {
        if (a.session === "default") return -1;
        if (b.session === "default") return 1;
        return a.session.localeCompare(b.session);
      }),
      activeSkills: [],
    };
  }

  private pushFrame(frame: Omit<LoopFrame, "id">): void {
    this.frameCounter++;
    this.loop.push({ ...frame, id: `frame-${this.frameCounter}` });
  }

  private upsertDecisionTraceFrame(
    event: Extract<RunEvent, { type: "model_decision_recorded" }>,
  ): void {
    const phase = decisionTracePhase(event.decision);
    const frame = this.findLatestFrame(event.stepIndex, phase);
    const projection = decisionTraceFrameProjection(event.decision);
    if (frame) {
      frame.timestamp = event.timestamp;
      frame.detail = appendDecisionTraceDetail(frame.detail, event.decision);
      return;
    }

    this.pushFrame({
      stepIndex: event.stepIndex,
      timestamp: event.timestamp,
      phase,
      status: projection.status,
      title: projection.title,
      summary: projection.summary,
      detail: formatDetail([["decision trace", event.decision]]),
    });
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
        ["diagnostic", event.turn.diagnostic],
        ["thinking", compactLongText(event.output.thinking.content)],
        ["raw decision", compactLongText(event.output.rawDecision)],
        [
          "turn",
          {
            kind: event.turn.kind,
            message: event.turn.message,
            diagnostic: event.turn.diagnostic,
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
    return this.findLatestFrame(stepIndex, "model");
  }

  private findLatestFrame(
    stepIndex: number,
    phase: LoopFrame["phase"],
  ): LoopFrame | undefined {
    for (let index = this.loop.length - 1; index >= 0; index--) {
      const frame = this.loop[index]!;
      if (frame.stepIndex === stepIndex && frame.phase === phase) {
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
    case "session_focused":
    case "session_restarted":
    case "session_output_available":
    case "session_input_ready":
    case "session_continuation_prompt":
    case "session_returned_to_prompt":
    case "session_terminated":
    case "session_unsynced":
      return `event=${event.id} ${event.kind} session=${event.session}`;
  }
}

function formatIoWaitWakeReason(
  wait: IoWaitRequest,
  event: EnvironmentEvent,
): Record<string, unknown> {
  const eventLevel = environmentEventLevel(event);
  const minLevel = ioWaitMinLevel(wait);
  return {
    eventId: event.id,
    eventKind: event.kind,
    source: event.source,
    eventLevel,
    minLevel,
    prioritySatisfied: eventLevel >= minLevel,
  };
}

function truncateForSummary(text: string, maxLength = 80): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function formatToolCallSummary(toolCall: { name?: string; arguments: unknown }): string {
  const args = toolCall.arguments;
  if (isRecord(args)) {
    return formatTerminalToolInputSummary(toolCall.name, args);
  }
  return "";
}

function formatTerminalToolInputSummary(
  toolName: string | undefined,
  args: Record<string, unknown>,
): string {
  const parts = [`tool=${toolName ?? "unknown"}`];
  switch (toolName) {
    case "terminal_write":
      if (typeof args.expectedInputSeq === "number") {
        parts.push(`inputSeq=${args.expectedInputSeq}`);
      }
      if (typeof args.text === "string") {
        parts.push(`bytes=${Buffer.byteLength(args.text, "utf8")}`);
      }
      if (typeof args.waitForReturnMs === "number") {
        parts.push(`waitMs=${args.waitForReturnMs}`);
      }
      break;
    case "terminal_key":
      if (typeof args.key === "string") {
        parts.push(`key=${args.key}`);
      }
      if (typeof args.expectedInputSeq === "number") {
        parts.push(`inputSeq=${args.expectedInputSeq}`);
      }
      if (typeof args.waitForReturnMs === "number") {
        parts.push(`waitMs=${args.waitForReturnMs}`);
      }
      break;
    case "session_interrupt":
      if (typeof args.expectedInputSeq === "number") {
        parts.push(`inputSeq=${args.expectedInputSeq}`);
      }
      if (typeof args.waitForReturnMs === "number") {
        parts.push(`waitMs=${args.waitForReturnMs}`);
      }
      break;
    case "session_observe":
    case "session_restart":
    case "session_terminate":
      parts.push(`session=${typeof args.session === "string" ? args.session : "current"}`);
      if (typeof args.cwd === "string") {
        parts.push(`cwd=${args.cwd}`);
      }
      if (typeof args.reason === "string") {
        parts.push(`reason=${truncateForSummary(args.reason, 40)}`);
      }
      break;
    case "session_focus":
      if (typeof args.session === "string") {
        parts.push(`session=${args.session}`);
      }
      if (typeof args.create === "boolean") {
        parts.push(`create=${args.create}`);
      }
      if (typeof args.cwd === "string") {
        parts.push(`cwd=${args.cwd}`);
      }
      break;
    case "session_list":
      break;
    default:
      for (const [key, value] of Object.entries(args).slice(0, 4)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          parts.push(`${key}=${truncateForSummary(String(value), 40)}`);
        }
      }
  }
  return parts.join(" ");
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

function decisionTracePhase(decision: ModelDecisionTrace): LoopFrame["phase"] {
  return decision.kind === "io_wait" ? "io_wait" : "decision";
}

function decisionTraceFrameProjection(
  decision: ModelDecisionTrace,
): Pick<LoopFrame, "status" | "title" | "summary"> {
  switch (decision.kind) {
    case "tool_call": {
      const toolCall = decision.toolCall;
      return {
        status: "ok",
        title: `tool call: ${toolCall?.name ?? "unknown"}`,
        summary: toolCall === undefined ? "" : formatToolCallSummary(toolCall),
      };
    }
    case "io_wait":
      return {
        status: "waiting",
        title: "io wait requested",
        summary: decision.ioWait?.reason ?? "",
      };
    case "invalid_output":
      return {
        status: "warn",
        title: "invalid model output",
        summary: decision.invalidOutput?.message ?? "",
      };
  }
}

function appendDecisionTraceDetail(
  existing: string | undefined,
  decision: ModelDecisionTrace,
): string {
  const detail = formatDetail([["decision trace", decision]]);
  if (!existing || existing.length === 0) {
    return detail;
  }
  if (existing.includes("## decision trace")) {
    return existing;
  }
  return `${existing}\n\n${detail}`;
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

function isTerminalObservation(value: unknown): value is TerminalObservation {
  return (
    isRecord(value) &&
    typeof value.currentSession === "string" &&
    typeof value.observedSession === "string" &&
    "terminal" in value &&
    typeof value.request === "string" &&
    typeof value.result === "string" &&
    typeof value.returnedToPrompt === "boolean" &&
    isRecord(value.screen) &&
    typeof value.screen.text === "string" &&
    isRecord(value.screen.logRef) &&
    typeof value.screen.logRef.path === "string"
  );
}

function isSessionListObservation(value: unknown): value is SessionListObservation {
  return (
    isRecord(value) &&
    typeof value.currentSession === "string" &&
    Array.isArray(value.sessions)
  );
}

function terminalResultStatus(result: TerminalObservation["result"]): LoopFrame["status"] {
  if (result === "ok") return "ok";
  if (result === "timeout") return "waiting";
  return "warn";
}

function terminalSessionState(
  terminal: TerminalObservation["terminal"],
): SessionView["state"] {
  if (!terminal.alive) return "terminated";
  if (terminal.foregroundProcess) return "running";
  if (terminal.lastContinuationPrompt) return "blocked";
  return "idle";
}

function sessionSnapshotToView(
  snapshot: TerminalSessionSnapshot,
  updatedAt: string,
): SessionView {
  return {
    session: snapshot.session,
    state: terminalSessionState(snapshot.terminal),
    currentCommand: snapshot.terminal.foregroundProcess ?? undefined,
    returnCode: snapshot.terminal.lastShellPrompt?.lastReturnCode ?? null,
    logPath: snapshot.outputLog?.ref ?? "",
    tail: "",
    updatedAt,
  };
}

function formatTerminalObservationSummary(observation: TerminalObservation): string {
  const parts = [
    `request=${observation.request}`,
    `session=${observation.observedSession}`,
    `inputSeq=${observation.terminal.inputSeq}`,
    `alive=${observation.terminal.alive}`,
  ];
  if (observation.terminal.syncStatus.kind === "unsynced") {
    parts.push(`sync=unsynced:${observation.terminal.syncStatus.reason}`);
  }
  if (observation.returnedToPrompt) {
    parts.push("returnedToPrompt=true");
  }
  if (observation.screen.truncated) {
    parts.push("screen=truncated");
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
      key === "arguments" &&
      isRecord(child) &&
      value.name === "terminal_write"
    ) {
      const redactedArgs = redactLargePayloads(child) as Record<string, unknown>;
      if (typeof child.text === "string") {
        redactedArgs.text = redactTerminalWriteDisplayText(child.text);
      }
      next[key] = redactedArgs;
      continue;
    }
    if (
      key === "text" &&
      typeof child === "string" &&
      shouldRedactTerminalWriteDetail(value, child)
    ) {
      next[key] = redactTerminalWriteDisplayText(child);
    } else {
      next[key] = redactLargePayloads(child);
    }
  }
  return next;
}

function shouldRedactTerminalWriteDetail(
  parent: Record<string, unknown>,
  text: string,
): boolean {
  if (parent.name !== "terminal_write" && parent.kind !== "terminal_write") {
    return false;
  }
  return redactTerminalWriteDisplayText(text) !== text;
}
