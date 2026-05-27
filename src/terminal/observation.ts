import type {
  PtyAction,
  PtyActionSummary,
  PtyObservation,
  TerminalErrorCode,
  TerminalEvent,
  TerminalEventSummary,
  TerminalState,
} from "./types.js";

export type TerminalObservationLimits = {
  maxPreviewChars: number;
  maxEvents: number;
};

export const DEFAULT_TERMINAL_OBSERVATION_LIMITS: TerminalObservationLimits = {
  maxPreviewChars: 160,
  maxEvents: 50,
};

export function summarizePtyAction(
  action: PtyAction,
  limits: Partial<TerminalObservationLimits> = {},
): PtyActionSummary {
  const resolved = { ...DEFAULT_TERMINAL_OBSERVATION_LIMITS, ...limits };

  switch (action.kind) {
    case "write_text":
      return {
        kind: action.kind,
        session: action.session,
        bytes: utf8Bytes(action.text),
        preview: preview(action.text, resolved.maxPreviewChars),
        redacted: action.text.length > resolved.maxPreviewChars,
      };
    case "key":
      return {
        kind: "key",
        session: action.session,
        preview: action.key,
      };
    case "interrupt":
    case "poll":
    case "restart":
    case "status":
    case "terminate":
      return {
        kind: action.kind,
        session: action.session,
      };
  }
}

export function summarizeTerminalEvent(
  event: TerminalEvent,
  limits: Partial<TerminalObservationLimits> = {},
): TerminalEventSummary {
  const resolved = { ...DEFAULT_TERMINAL_OBSERVATION_LIMITS, ...limits };

  switch (event.kind) {
    case "output":
      return {
        kind: "output",
        bytes: event.bytes,
        preview: preview(event.preview, resolved.maxPreviewChars),
        logRef: event.logRef,
      };
    case "prompt":
    case "continuation_prompt":
    case "terminated":
    case "unsynced":
      return { kind: event.kind };
  }
}

export function buildPtyObservation(input: {
  session: string;
  terminal: TerminalState;
  action: PtyAction;
  result: PtyObservation["result"];
  events: readonly TerminalEvent[];
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
  limits?: Partial<TerminalObservationLimits>;
}): PtyObservation {
  const limits = { ...DEFAULT_TERMINAL_OBSERVATION_LIMITS, ...input.limits };
  const summarizedEvents = input.events
    .slice(0, limits.maxEvents)
    .map((event) => summarizeTerminalEvent(event, limits));
  const eventsOmitted = Math.max(0, input.events.length - summarizedEvents.length);
  return {
    session: input.session,
    terminal: input.terminal,
    action: summarizePtyAction(input.action, limits),
    result: input.result,
    eventCount: input.events.length,
    eventsOmitted: eventsOmitted > 0 ? eventsOmitted : undefined,
    events: summarizedEvents,
    outputPreview:
      input.outputPreview === undefined
        ? undefined
        : preview(input.outputPreview, limits.maxPreviewChars),
    logRef: input.logRef,
    errorCode: input.errorCode,
    message: input.message,
  };
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
