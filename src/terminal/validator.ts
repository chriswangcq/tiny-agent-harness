import type { PtyAction, TerminalErrorCode, TerminalOwner, ValidationResult } from "./types.js";

export type PtyActionLimits = {
  maxWriteTextBytes: number;
  maxFrameBytes: number;
};

export const DEFAULT_PTY_ACTION_LIMITS: PtyActionLimits = {
  maxWriteTextBytes: 4096,
  maxFrameBytes: 4096,
};

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
      "write_text exceeds the PTY small-input limit; start the receiver CLI and send smaller stdin frame lines.",
    );
  }

  if (owner.kind === "receiver") {
    return validateReceiverWriteText(owner, text);
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

function validateReceiverWriteText(
  owner: Extract<TerminalOwner, { kind: "receiver" }>,
  text: string,
): ValidationResult {
  if (!text.endsWith("\n")) {
    return reject(
      owner,
      "OWNER_REJECTED",
      "Receiver stdin writes must contain exactly one complete line ending in newline.",
    );
  }

  const line = text.slice(0, -1);
  if (line.includes("\n") || line.includes("\r")) {
    return reject(
      owner,
      "OWNER_REJECTED",
      "Receiver stdin writes must contain exactly one line.",
    );
  }

  if (line.startsWith("__TAH_RECEIVER_END__")) {
    return { ok: true };
  }

  if (line.length === 0) {
    return reject(owner, "RECEIVER_INVALID_BASE64", "Receiver frame line is empty.");
  }

  if (utf8Bytes(line) > owner.maxFrameBytes) {
    return reject(owner, "RECEIVER_FRAME_TOO_LARGE", "Receiver frame exceeds maxFrameBytes.");
  }

  if (!isBase64(line)) {
    return reject(owner, "RECEIVER_INVALID_BASE64", "Receiver frame is not valid base64.");
  }

  return { ok: true };
}

function validateKey(owner: TerminalOwner): ValidationResult {
  if (owner.kind === "shell" || owner.kind === "shell_continuation" || owner.kind === "receiver") {
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
      return "write_text is not accepted by the current receiver.";
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

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return false;
  }
  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || /^=+$/u.test(value.slice(firstPadding));
}
