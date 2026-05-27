import type {
  ContinuationReason,
  ProcessStdinMode,
  ReceiverMode,
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
    case "receiver_ack":
      return toReceiverAck(owner, event);
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
    case "receiver_ready":
      return toReceiver(owner, {
        receiverId: event.receiverId,
        commandLine: event.commandLine,
        mode: event.mode,
        maxFrameBytes: event.maxFrameBytes,
        nextSeq: event.nextSeq,
        bytesReceived: event.bytesReceived ?? 0,
        expectedSha256: event.expectedSha256,
      });
    case "receiver_done":
      return toUnknown(owner, "state_gap");
    case "silence_timeout":
      return toProcess(owner, {
        commandLine: event.commandLine,
        startedAt: event.startedAt,
        stdinMode: event.stdinMode ?? "unknown",
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

function toReceiverAck(
  owner: TerminalOwner,
  event: Extract<TerminalEvent, { kind: "receiver_ack" }>,
): OwnerTransition {
  if (owner.kind !== "receiver" || owner.receiverId !== event.receiverId) {
    return { owner, changed: false };
  }

  return toOwner(owner, {
    ...owner,
    revision: nextOwnerRevision(owner),
    nextSeq: event.seq + 1,
    bytesReceived: event.bytes,
  });
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

export function toReceiver(
  owner: TerminalOwner,
  input: {
    receiverId: string;
    commandLine: string;
    mode: ReceiverMode;
    nextSeq: number;
    bytesReceived: number;
    maxFrameBytes: number;
    expectedSha256?: string;
  },
): OwnerTransition {
  return toOwner(owner, {
    kind: "receiver",
    revision: nextOwnerRevision(owner),
    receiverId: input.receiverId,
    commandLine: input.commandLine,
    mode: input.mode,
    nextSeq: input.nextSeq,
    bytesReceived: input.bytesReceived,
    maxFrameBytes: input.maxFrameBytes,
    expectedSha256: input.expectedSha256,
  });
}

export function toProcess(
  owner: TerminalOwner,
  input: {
    commandLine: string | null;
    stdinMode?: ProcessStdinMode;
    startedAt: string;
    lastOutputAt?: string | null;
  },
): OwnerTransition {
  return toOwner(owner, {
    kind: "process",
    revision: nextOwnerRevision(owner),
    commandLine: input.commandLine,
    stdinMode: input.stdinMode ?? "unknown",
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
