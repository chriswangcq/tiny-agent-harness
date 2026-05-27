import type {
  PayloadRef,
  PtyAction,
  PtyActionSummary,
  PtyObservation,
  TerminalErrorCode,
  TerminalEvent,
  TerminalEventSummary,
  TerminalOwner,
} from "./types.js";

export type TerminalObservationLimits = {
  maxPreviewChars: number;
};

export const DEFAULT_TERMINAL_OBSERVATION_LIMITS: TerminalObservationLimits = {
  maxPreviewChars: 160,
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
    case "input_frame":
      return {
        kind: "input_frame",
        session: action.session,
        receiverId: action.receiverId,
        seq: action.seq,
        bytes: asciiBytes(action.dataBase64),
        redacted: true,
      };
    case "end_input":
      return {
        kind: "end_input",
        session: action.session,
        receiverId: action.receiverId,
        bytes: action.bytes,
        sha256: action.sha256,
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
    case "receiver_ready":
      return {
        kind: "receiver_ready",
        receiverId: event.receiverId,
        bytes: event.bytesReceived,
      };
    case "receiver_ack":
      return {
        kind: "receiver_ack",
        receiverId: event.receiverId,
        bytes: event.bytes,
      };
    case "receiver_done":
      return {
        kind: "receiver_done",
        receiverId: event.receiverId,
        bytes: event.bytes,
        sha256: event.sha256,
      };
    case "prompt":
    case "continuation_prompt":
    case "silence_timeout":
    case "terminated":
    case "unsynced":
      return { kind: event.kind };
  }
}

export function buildPtyObservation(input: {
  session: string;
  owner: TerminalOwner;
  action: PtyAction;
  result: PtyObservation["result"];
  events: readonly TerminalEvent[];
  outputPreview?: string;
  logRef?: string;
  payloadRef?: PayloadRef;
  errorCode?: TerminalErrorCode;
  message?: string;
  limits?: Partial<TerminalObservationLimits>;
}): PtyObservation {
  const limits = { ...DEFAULT_TERMINAL_OBSERVATION_LIMITS, ...input.limits };
  return {
    session: input.session,
    owner: input.owner,
    action: summarizePtyAction(input.action, limits),
    result: input.result,
    events: input.events.map((event) => summarizeTerminalEvent(event, limits)),
    outputPreview:
      input.outputPreview === undefined
        ? undefined
        : preview(input.outputPreview, limits.maxPreviewChars),
    logRef: input.logRef,
    payloadRef: input.payloadRef,
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

function asciiBytes(value: string): number {
  return value.length;
}
