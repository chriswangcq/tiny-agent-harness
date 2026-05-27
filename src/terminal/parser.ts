import type {
  ContinuationReason,
  TerminalEvent,
  UnknownOwner,
} from "./types.js";

export type TerminalMarkers = {
  prompt: string;
  continuation: string;
};

export type ParserState = {
  pending: string;
  totalBytes: number;
};

export type ParseTerminalChunkInput = {
  chunk: string;
  state?: ParserState;
  promptNonce: string;
  markers?: Partial<TerminalMarkers>;
};

export type ParseTerminalChunkResult = {
  state: ParserState;
  events: TerminalEvent[];
};

export const DEFAULT_TERMINAL_MARKERS: TerminalMarkers = {
  prompt: "__TAH_PROMPT__",
  continuation: "__TAH_CONT__",
};

export function parseTerminalChunk(input: ParseTerminalChunkInput): ParseTerminalChunkResult {
  const markers = { ...DEFAULT_TERMINAL_MARKERS, ...input.markers };
  const previous = input.state ?? { pending: "", totalBytes: 0 };
  const combined = `${previous.pending}${input.chunk}`;
  const totalBytes = previous.totalBytes + utf8Bytes(input.chunk);
  const { completeLines, pending } = splitCompleteLines(combined);
  const events = completeLines.map((line) =>
    parseLine(line, input.promptNonce, markers),
  );

  return {
    state: { pending, totalBytes },
    events,
  };
}

function parseLine(
  rawLine: string,
  promptNonce: string,
  markers: TerminalMarkers,
): TerminalEvent {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

  if (line.startsWith(markers.prompt)) {
    const fields = parseFields(line, markers.prompt);
    if (!hasTrustedNonce(fields, promptNonce)) {
      return unsynced("prompt_spoof_suspected");
    }

    const returnCode = parseInteger(fields.rc);
    const promptSeq = parseInteger(fields.seq);
    const cwd = fields.cwd === undefined ? undefined : decodeField(fields.cwd);
    if (returnCode === undefined || promptSeq === undefined || cwd === undefined) {
      return unsynced("unparsed_output");
    }

    return {
      kind: "prompt",
      returnCode,
      cwd,
      promptSeq,
      promptNonce,
    };
  }

  if (line.startsWith(markers.continuation)) {
    const fields = parseFields(line, markers.continuation);
    if (!hasTrustedNonce(fields, promptNonce)) {
      return unsynced("prompt_spoof_suspected");
    }

    const promptSeq = parseInteger(fields.seq);
    const reason = parseContinuationReason(fields.reason);
    if (promptSeq === undefined || reason === undefined) {
      return unsynced("unparsed_output");
    }

    return {
      kind: "continuation_prompt",
      reason,
      promptSeq,
      promptNonce,
    };
  }

  return {
    kind: "output",
    bytes: utf8Bytes(line),
    preview: line,
  };
}

function parseFields(line: string, marker: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const rest = line.slice(marker.length).trim();
  if (rest.length === 0) {
    return fields;
  }

  for (const token of rest.split(/\s+/u)) {
    const equalsIndex = token.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    fields[token.slice(0, equalsIndex)] = token.slice(equalsIndex + 1);
  }

  return fields;
}

function splitCompleteLines(value: string): {
  completeLines: string[];
  pending: string;
} {
  const lines = value.split("\n");
  if (!value.endsWith("\n")) {
    return { completeLines: lines.slice(0, -1), pending: lines.at(-1) ?? "" };
  }

  return { completeLines: lines.slice(0, -1), pending: "" };
}

function hasTrustedNonce(fields: Record<string, string>, promptNonce: string): boolean {
  return fields.nonce !== undefined && decodeField(fields.nonce) === promptNonce;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/u.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function parseContinuationReason(value: string | undefined): ContinuationReason | undefined {
  if (
    value === "quote" ||
    value === "heredoc" ||
    value === "line_continuation" ||
    value === "unknown"
  ) {
    return value;
  }

  return undefined;
}

function decodeField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unsynced(reason: UnknownOwner["reason"]): TerminalEvent {
  return { kind: "unsynced", reason };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
