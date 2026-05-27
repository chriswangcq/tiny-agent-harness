import type {
  PtyAction,
  ReceiverOwner,
  TerminalErrorCode,
  TerminalOwner,
  ValidationResult,
} from "./types.js";

export type PtyActionLimits = {
  maxWriteTextBytes: number;
  maxFrameBytes: number;
};

export const DEFAULT_PTY_ACTION_LIMITS: PtyActionLimits = {
  maxWriteTextBytes: 4096,
  maxFrameBytes: 4096,
};

type ReceiverValidationResult =
  | { ok: true; receiver: ReceiverOwner }
  | Extract<ValidationResult, { ok: false }>;

export function validatePtyAction(input: {
  action: PtyAction;
  owner: TerminalOwner;
  limits?: Partial<PtyActionLimits>;
}): ValidationResult {
  const limits = { ...DEFAULT_PTY_ACTION_LIMITS, ...input.limits };
  const { action, owner } = input;

  if (action.kind === "poll" || action.kind === "status") {
    return { ok: true };
  }

  if (action.kind === "restart") {
    return { ok: true };
  }

  if (action.kind === "terminate") {
    return { ok: true };
  }

  if (action.kind === "interrupt") {
    if (
      action.expectedOwnerRevision !== undefined &&
      action.expectedOwnerRevision !== owner.revision
    ) {
      return reject(owner, "OWNER_MISMATCH", "Owner revision changed before interrupt.");
    }

    return { ok: true };
  }

  if (action.expectedOwnerRevision !== owner.revision) {
    return reject(owner, "OWNER_MISMATCH", "Owner revision changed before input.");
  }

  if (owner.kind === "terminated") {
    return reject(owner, "TERMINAL_TERMINATED", "Terminal is terminated.");
  }

  switch (action.kind) {
    case "write_text":
      return validateWriteText(owner, action.text, limits.maxWriteTextBytes);
    case "key":
      return validateKey(owner);
    case "input_frame":
      return validateInputFrame(owner, action.receiverId, action.seq, action.dataBase64, limits);
    case "end_input":
      return validateEndInput(owner, action.receiverId);
  }
}

function validateWriteText(
  owner: TerminalOwner,
  text: string,
  maxBytes: number,
): ValidationResult {
  if (utf8Bytes(text) > maxBytes) {
    return reject(
      owner,
      "PAYLOAD_TOO_LARGE_FOR_ACTION",
      "write_text exceeds the PTY small-input limit; start a receiver and send frames.",
    );
  }

  if (owner.kind === "shell" || owner.kind === "shell_continuation") {
    return { ok: true };
  }

  if (owner.kind === "process") {
    if (owner.stdinMode === "interactive") {
      return { ok: true };
    }

    return reject(
      owner,
      "OWNER_REJECTED",
      "write_text is not accepted by the foreground process owner.",
    );
  }

  return reject(
    owner,
    owner.kind === "unknown" ? "TERMINAL_UNSYNCED" : "OWNER_REJECTED",
    rejectedTextMessage(owner),
  );
}

function validateKey(owner: TerminalOwner): ValidationResult {
  if (owner.kind === "shell" || owner.kind === "shell_continuation") {
    return { ok: true };
  }

  if (owner.kind === "process" && owner.stdinMode !== "none") {
    return { ok: true };
  }

  if (owner.kind === "unknown") {
    return reject(owner, "TERMINAL_UNSYNCED", "Terminal owner is unknown.");
  }

  return reject(owner, "OWNER_REJECTED", "Key input is not accepted by the current owner.");
}

function validateInputFrame(
  owner: TerminalOwner,
  receiverId: string,
  seq: number,
  dataBase64: string,
  limits: PtyActionLimits,
): ValidationResult {
  const receiver = expectReceiver(owner, receiverId);
  if (!receiver.ok) {
    return receiver;
  }

  if (seq !== receiver.receiver.nextSeq) {
    return reject(
      owner,
      "RECEIVER_SEQ_MISMATCH",
      `Expected receiver frame seq ${receiver.receiver.nextSeq}, got ${seq}.`,
    );
  }

  if (utf8Bytes(dataBase64) > limits.maxFrameBytes) {
    return reject(owner, "RECEIVER_FRAME_TOO_LARGE", "Receiver frame exceeds maxFrameBytes.");
  }

  return { ok: true };
}

function validateEndInput(owner: TerminalOwner, receiverId: string): ValidationResult {
  const receiver = expectReceiver(owner, receiverId);
  if (!receiver.ok) {
    return receiver;
  }

  return { ok: true };
}

function expectReceiver(
  owner: TerminalOwner,
  receiverId: string,
): ReceiverValidationResult {
  if (owner.kind === "unknown") {
    return reject(owner, "TERMINAL_UNSYNCED", "Terminal owner is unknown.");
  }

  if (owner.kind !== "receiver") {
    return reject(owner, "OWNER_REJECTED", "Current terminal owner is not a receiver.");
  }

  if (owner.receiverId !== receiverId) {
    return reject(
      owner,
      "OWNER_REJECTED",
      `Receiver id mismatch: expected ${owner.receiverId}, got ${receiverId}.`,
    );
  }

  return { ok: true, receiver: owner };
}

function reject(
  owner: TerminalOwner,
  code: TerminalErrorCode,
  message: string,
): Extract<ValidationResult, { ok: false }> {
  return { ok: false, code, message, owner };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rejectedTextMessage(owner: TerminalOwner): string {
  switch (owner.kind) {
    case "receiver":
      return "write_text cannot be sent while a receiver owns the terminal.";
    case "unknown":
      return "Terminal owner is unknown; poll, interrupt, or restart before writing.";
    case "terminated":
      return "Terminal is terminated.";
    case "shell":
    case "shell_continuation":
    case "process":
      return "write_text is not accepted by the current terminal owner.";
  }
}
