import type { PtyAction, TerminalErrorCode, TerminalOwner, ValidationResult } from "./types.js";

export type PtyActionLimits = Record<string, never>;

export const DEFAULT_PTY_ACTION_LIMITS: PtyActionLimits = {};

export function validatePtyAction(input: {
  action: PtyAction;
  owner: TerminalOwner;
  limits?: Partial<PtyActionLimits>;
}): ValidationResult {
  void input.limits;
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
      return validateWriteText(owner, action.text);
    case "key":
      return validateKey(owner);
  }
}

function validateWriteText(
  owner: TerminalOwner,
  _text: string,
): ValidationResult {
  if (owner.kind === "shell" || owner.kind === "shell_continuation") {
    return { ok: true };
  }

  if (owner.kind === "process") {
    if (owner.inputPolicy !== "blocked") {
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

  if (owner.kind === "process" && owner.inputPolicy !== "blocked") {
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

function rejectedTextMessage(owner: TerminalOwner): string {
  switch (owner.kind) {
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
