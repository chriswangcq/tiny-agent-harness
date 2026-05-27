import type {
  ContinuationReason,
  ProcessInputPolicy,
  TerminalEvent,
  TerminalOwner,
} from "./types.js";

export type OwnerTransition = {
  owner: TerminalOwner;
  changed: boolean;
};

export type ShellOwnerInput = {
  cwd: string;
  promptSeq: number;
  lastReturnCode: number | null;
  promptNonce: string;
  revision?: number;
};

export function createShellOwner(input: ShellOwnerInput): TerminalOwner {
  return {
    kind: "shell",
    revision: input.revision ?? 0,
    cwd: input.cwd,
    promptSeq: input.promptSeq,
    lastReturnCode: input.lastReturnCode,
    promptNonce: input.promptNonce,
  };
}

export function nextOwnerRevision(owner: TerminalOwner): number {
  return owner.revision + 1;
}

export function ownerMatchesRevision(
  owner: TerminalOwner,
  expectedRevision: number,
): boolean {
  return owner.revision === expectedRevision;
}

export function transitionOwner(
  owner: TerminalOwner,
  event: TerminalEvent,
): OwnerTransition {
  switch (event.kind) {
    case "output":
      return { owner, changed: false };
    case "prompt":
      return toOwner(owner, {
        kind: "shell",
        revision: nextOwnerRevision(owner),
        cwd: event.cwd,
        promptSeq: event.promptSeq,
        lastReturnCode: event.returnCode,
        promptNonce: event.promptNonce,
      });
    case "continuation_prompt":
      return toContinuation(owner, {
        reason: event.reason,
        promptSeq: event.promptSeq,
        promptNonce: event.promptNonce,
      });
    case "silence_timeout":
      return toProcess(owner, {
        commandLine: event.commandLine,
        startedAt: event.startedAt,
        inputPolicy: event.inputPolicy ?? "unknown",
      });
    case "unsynced":
      return toUnknown(owner, event.reason);
    case "terminated":
      return toOwner(owner, {
        kind: "terminated",
        revision: nextOwnerRevision(owner),
        exitCode: event.exitCode,
        reason: event.reason,
      });
  }
}

export function transitionOwnerMany(
  owner: TerminalOwner,
  events: readonly TerminalEvent[],
): OwnerTransition {
  return events.reduce<OwnerTransition>(
    (current, event) => {
      const next = transitionOwner(current.owner, event);
      return { owner: next.owner, changed: current.changed || next.changed };
    },
    { owner, changed: false },
  );
}

export function toContinuation(
  owner: TerminalOwner,
  input: {
    reason: ContinuationReason;
    promptSeq: number;
    promptNonce: string;
  },
): OwnerTransition {
  return toOwner(owner, {
    kind: "shell_continuation",
    revision: nextOwnerRevision(owner),
    reason: input.reason,
    promptSeq: input.promptSeq,
    promptNonce: input.promptNonce,
  });
}

export function toProcess(
  owner: TerminalOwner,
  input: {
    commandLine: string | null;
    inputPolicy?: ProcessInputPolicy;
    startedAt: string;
    lastOutputAt?: string | null;
  },
): OwnerTransition {
  return toOwner(owner, {
    kind: "process",
    revision: nextOwnerRevision(owner),
    commandLine: input.commandLine,
    inputPolicy: input.inputPolicy ?? "unknown",
    startedAt: input.startedAt,
    lastOutputAt: input.lastOutputAt ?? null,
  });
}

export function toUnknown(
  owner: TerminalOwner,
  reason: Extract<TerminalOwner, { kind: "unknown" }>["reason"],
): OwnerTransition {
  return toOwner(owner, {
    kind: "unknown",
    revision: nextOwnerRevision(owner),
    reason,
  });
}

function toOwner(owner: TerminalOwner, next: TerminalOwner): OwnerTransition {
  if (sameOwner(owner, next)) {
    return { owner, changed: false };
  }

  return { owner: next, changed: true };
}

function sameOwner(left: TerminalOwner, right: TerminalOwner): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
