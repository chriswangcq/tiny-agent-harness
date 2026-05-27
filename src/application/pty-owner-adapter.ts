import {
  parseTerminalChunk,
  transitionOwnerMany,
  transitionOwner,
} from "../terminal/index.js";
import type {
  LogRef,
  ProcessStdinMode,
  TerminalEvent,
  TerminalOwner,
} from "../terminal/index.js";
import type { TerminalRuntimeSnapshot } from "./terminal-ports.js";

export type ApplyPtyChunkInput = {
  snapshot: TerminalRuntimeSnapshot;
  chunk: string;
  promptNonce: string;
  logRef?: LogRef;
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
    promptNonce: promptNonceFor(input.snapshot.owner, input.promptNonce),
  });
  const transition = transitionOwnerMany(input.snapshot.owner, parsed.events);

  return {
    snapshot: {
      ...input.snapshot,
      owner: transition.owner,
      parserState: parsed.state,
      outputLog: input.logRef ?? input.snapshot.outputLog,
    },
    events: parsed.events,
  };
}

export function applySilenceTimeoutToSnapshot(input: {
  snapshot: TerminalRuntimeSnapshot;
  elapsedMs: number;
  commandLine: string | null;
  startedAt: string;
  stdinMode?: ProcessStdinMode;
}): ApplyPtyChunkResult {
  const event: TerminalEvent = {
    kind: "silence_timeout",
    elapsedMs: input.elapsedMs,
    commandLine: input.commandLine,
    startedAt: input.startedAt,
    stdinMode: input.stdinMode,
  };
  const transition = transitionOwner(input.snapshot.owner, event);

  return {
    snapshot: {
      ...input.snapshot,
      owner: transition.owner,
    },
    events: [event],
  };
}

function promptNonceFor(owner: TerminalOwner, fallback: string): string {
  if (owner.kind === "shell" || owner.kind === "shell_continuation") {
    return owner.promptNonce;
  }

  return fallback;
}
