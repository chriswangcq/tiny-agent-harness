import type {
  PtyAction,
  PtyActionSummary,
  PtyObservation,
  TerminalErrorCode,
  TerminalEvent,
  TerminalState,
} from "./types.js";

export type TerminalObservationLimits = {
  maxPreviewChars: number;
  maxOutputTailChars?: number;
};

export const DEFAULT_TERMINAL_OBSERVATION_LIMITS: TerminalObservationLimits = {
  maxPreviewChars: 160,
  maxOutputTailChars: 2048,
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

export function buildPtyObservation(input: {
  session: string;
  terminal: TerminalState;
  action: PtyAction;
  result: PtyObservation["result"];
  events: readonly TerminalEvent[];
  outputTail?: string;
  newOutputBytes?: number;
  outputPreview?: string;
  logRef?: string;
  errorCode?: TerminalErrorCode;
  message?: string;
  limits?: Partial<TerminalObservationLimits>;
}): PtyObservation {
  const limits = { ...DEFAULT_TERMINAL_OBSERVATION_LIMITS, ...input.limits };
  const outputTail =
    input.outputTail === undefined
      ? undefined
      : tailPreview(input.outputTail, limits.maxOutputTailChars ?? 2048);
  const outputPreviewSource = outputTail ?? input.outputPreview;
  return {
    session: input.session,
    terminal: input.terminal,
    action: summarizePtyAction(input.action, limits),
    result: input.result,
    eventCount: input.events.length,
    returnedToPrompt: input.events.some((event) => event.kind === "prompt"),
    outputTail,
    outputTailBytes: outputTail === undefined ? undefined : utf8Bytes(outputTail),
    newOutputBytes: input.newOutputBytes,
    outputPreview:
      outputPreviewSource === undefined
        ? undefined
        : tailPreview(outputPreviewSource, limits.maxOutputTailChars ?? 2048),
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

function tailPreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `…${value.slice(-(Math.max(0, maxChars - 1)))}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
