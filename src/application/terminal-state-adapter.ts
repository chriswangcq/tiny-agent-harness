import {
  parseTerminalChunk,
  transitionTerminalStateMany,
} from "../terminal/index.js";
import type {
  LogRef,
  TerminalEvent,
} from "../terminal/index.js";
import type { TerminalRuntimeSnapshot } from "./terminal-ports.js";

export type ApplyPtyChunkInput = {
  snapshot: TerminalRuntimeSnapshot;
  chunk: string;
  promptNonce: string;
  logRef?: LogRef;
  inputAccepted?: boolean;
};

export type ApplyPtyChunkResult = {
  snapshot: TerminalRuntimeSnapshot;
  events: TerminalEvent[];
};

export function applyPtyChunkToSnapshot(
  input: ApplyPtyChunkInput,
): ApplyPtyChunkResult {
  const parsed = parseTerminalChunk({
    chunk: input.chunk,
    state: input.snapshot.parserState,
    promptNonce: input.promptNonce,
  });
  const transition = transitionTerminalStateMany(
    input.snapshot.terminal,
    parsed.events,
    { inputAccepted: input.inputAccepted === true || input.chunk.length > 0 },
  );

  return {
    snapshot: {
      ...input.snapshot,
      terminal: transition.terminal,
      parserState: parsed.state,
      outputLog: input.logRef ?? input.snapshot.outputLog,
    },
    events: parsed.events,
  };
}
