import type {
  TerminalEvent,
  TerminalState,
  TerminalUnsyncedReason,
} from "./types.js";

export type CreateTerminalStateInput = {
  cwd: string;
  promptSeq: number;
  lastReturnCode: number | null;
  inputSeq?: number;
};

export type TerminalStateTransition = {
  terminal: TerminalState;
  changed: boolean;
};

export function createTerminalState(
  input: CreateTerminalStateInput,
): TerminalState {
  return {
    inputSeq: input.inputSeq ?? 0,
    alive: true,
    syncStatus: { kind: "trusted" },
    lastShellPrompt: {
      cwd: input.cwd,
      promptSeq: input.promptSeq,
      lastReturnCode: input.lastReturnCode,
    },
    lastContinuationPrompt: null,
    termination: null,
  };
}

export function terminalMatchesInputSeq(
  terminal: TerminalState,
  expectedInputSeq: number,
): boolean {
  return terminal.inputSeq === expectedInputSeq;
}

export function transitionTerminalStateMany(
  terminal: TerminalState,
  events: readonly TerminalEvent[],
  options: { inputAccepted?: boolean } = {},
): TerminalStateTransition {
  let next = terminal;
  let changed = options.inputAccepted === true || events.length > 0;

  for (const event of events) {
    const eventNext = applyTerminalEvent(next, event);
    if (!sameTerminalFacts(next, eventNext)) {
      changed = true;
    }
    next = eventNext;
  }

  if (!changed) {
    return { terminal, changed: false };
  }

  return {
    terminal: {
      ...next,
      inputSeq: terminal.inputSeq + 1,
    },
    changed: true,
  };
}

export function markTerminalTerminated(
  terminal: TerminalState,
  input: { exitCode: number | null; reason: string },
): TerminalState {
  return {
    ...terminal,
    inputSeq: terminal.inputSeq + 1,
    alive: false,
    syncStatus: { kind: "trusted" },
    termination: {
      exitCode: input.exitCode,
      reason: input.reason,
    },
  };
}

function applyTerminalEvent(
  terminal: TerminalState,
  event: TerminalEvent,
): TerminalState {
  switch (event.kind) {
    case "output":
      return terminal;
    case "prompt":
      return {
        ...terminal,
        alive: true,
        syncStatus: { kind: "trusted" },
        lastShellPrompt: {
          cwd: event.cwd,
          promptSeq: event.promptSeq,
          lastReturnCode: event.returnCode,
        },
        lastContinuationPrompt: null,
        termination: null,
      };
    case "continuation_prompt":
      return {
        ...terminal,
        alive: true,
        syncStatus: { kind: "trusted" },
        lastContinuationPrompt: {
          reason: event.reason,
          promptSeq: event.promptSeq,
        },
        termination: null,
      };
    case "unsynced":
      return {
        ...terminal,
        syncStatus: {
          kind: "unsynced",
          reason: event.reason,
        },
      };
    case "terminated":
      return markTerminalTerminated(terminal, event);
  }
}

function sameTerminalFacts(
  left: TerminalState,
  right: TerminalState,
): boolean {
  return (
    left.alive === right.alive &&
    JSON.stringify(left.syncStatus) === JSON.stringify(right.syncStatus) &&
    JSON.stringify(left.lastShellPrompt) === JSON.stringify(right.lastShellPrompt) &&
    JSON.stringify(left.lastContinuationPrompt) ===
      JSON.stringify(right.lastContinuationPrompt) &&
    JSON.stringify(left.termination) === JSON.stringify(right.termination)
  );
}

export function createUnsyncedTerminalState(
  reason: TerminalUnsyncedReason,
): TerminalState {
  return {
    inputSeq: 0,
    alive: true,
    syncStatus: { kind: "unsynced", reason },
    lastShellPrompt: null,
    lastContinuationPrompt: null,
    termination: null,
  };
}
