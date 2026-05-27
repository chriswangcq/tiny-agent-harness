import type {
  PtyAction,
  TerminalErrorCode,
  TerminalState,
  ValidationResult,
} from "./types.js";

export type PtyActionLimits = Record<string, never>;

export const DEFAULT_PTY_ACTION_LIMITS: PtyActionLimits = {};

export function validatePtyAction(input: {
  action: PtyAction;
  terminal: TerminalState;
  limits?: Partial<PtyActionLimits>;
}): ValidationResult {
  void input.limits;
  const { action, terminal } = input;

  if (action.kind === "poll" || action.kind === "status") {
    return { ok: true };
  }

  if (action.kind === "restart") {
    return { ok: true };
  }

  if (action.kind === "terminate") {
    return { ok: true };
  }

  if (!terminal.alive) {
    return reject(
      terminal,
      "TERMINAL_TERMINATED",
      "Terminal is terminated; restart before writing input.",
    );
  }

  if (
    action.expectedInputSeq !== undefined &&
    action.expectedInputSeq !== terminal.inputSeq
  ) {
    return reject(
      terminal,
      "INPUT_SEQ_MISMATCH",
      "Terminal input sequence changed before input.",
    );
  }

  return { ok: true };
}

function reject(
  terminal: TerminalState,
  code: TerminalErrorCode,
  message: string,
): Extract<ValidationResult, { ok: false }> {
  return { ok: false, code, message, terminal };
}
